import { Router } from 'express';
import { one } from '../config/db.js';
import { config } from '../config/env.js';
import { ah } from '../lib/http.js';
import { safeEqual } from '../lib/password.js';
import { intlPhone } from '../lib/phone.js';
import { handleIpn, verifyIpn } from '../services/paymentService.js';
import { parseWebhook, recordInbound, recordStatus, verifyWebhookSignature } from '../services/whatsappService.js';
import { getReservationByToken, recordPresence, requestCashPayment } from '../services/reservationService.js';
import { notifyStaff } from '../services/notificationService.js';
import { replyText } from '../services/notifier.js';
import { tick } from '../services/scheduler.js';

const router = Router();

// ------------------------------------------------------------------ PayTech IPN
router.post('/ipn', ah(async (req, res) => {
  const b = req.body || {};
  if (!verifyIpn(b)) {
    console.error('❌ IPN non authentique', b.ref_command);
    return res.status(403).json({ success: 0, message: 'Vérification impossible' });
  }
  const result = await handleIpn(b);
  console.log('📩 IPN', b.ref_command, b.type_event, result);
  res.status(200).json({ success: 1, message: 'IPN traité avec succès' });
}));

// ------------------------------------------------------------------ WhatsApp Cloud API
// Vérification de l'URL du webhook par Meta
router.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  if (mode === 'subscribe' && config.whatsapp.verifyToken && token && safeEqual(token, config.whatsapp.verifyToken)) {
    return res.status(200).send(String(req.query['hub.challenge'] || ''));
  }
  res.sendStatus(403);
});

const handleReply = async (msg) => {
  const [action, token] = String(msg.payload || '').split(':');
  let r = token ? await getReservationByToken(token) : null;

  // Le jeton doit appartenir au numéro qui répond
  if (r && intlPhone(r.telephone) !== intlPhone(msg.from)) r = null;

  // Réponse texte libre « oui » sans bouton : on rattache au dernier rappel envoyé à ce numéro
  if (!r && !msg.payload && /^\s*(oui|ok|yes|confirm)/i.test(msg.text || '')) {
    const row = await one(
      "SELECT action_token FROM reservations WHERE telephone = ? AND statut = 'confirmee' AND presence_status = 'demandee' AND start_at > UTC_TIMESTAMP() ORDER BY start_at LIMIT 1",
      [intlPhone(msg.from)]
    );
    if (row) { r = await getReservationByToken(row.action_token); msg.payload = `PRESENCE_OK:${row.action_token}`; }
  }

  if (!r) {
    await notifyStaff({ type: 'whatsapp_inbound', title: `Message WhatsApp de +${msg.from}`, body: String(msg.text || msg.payload || '').slice(0, 500) });
    return;
  }

  const act = String(msg.payload).split(':')[0] || action;
  if (act === 'PRESENCE_OK') {
    await recordPresence(r, 'confirm', 'whatsapp');
    await replyText(msg.from, `Merci ${r.first_name} ! Votre présence est confirmée. À tout à l’heure au studio.`, r, 'reply_presence_ok');
  } else if (act === 'PRESENCE_RESCHEDULE') {
    const updated = await recordPresence(r, 'reschedule', 'whatsapp');
    const link = `${config.frontendUrl}/presence/${r.action_token}`;
    await replyText(
      msg.from,
      `C’est noté. Choisissez un nouveau créneau depuis votre espace : ${link}${updated.statut === 'confirmee' ? '' : ''}\n(Le report en ligne est possible jusqu’à 2 h avant la session ; au-delà, l’équipe vous recontacte.)`,
      r, 'reply_reschedule_link'
    );
  } else if (act === 'PAY_CASH') {
    try {
      await requestCashPayment(r, 'whatsapp');
      await replyText(msg.from, 'C’est noté : vous réglerez en espèces au studio. L’équipe validera la réception avant le début de la session.', r, 'reply_cash');
    } catch (e) {
      await replyText(msg.from, e.message || 'Cette réservation est déjà réglée.', r, 'reply_cash_error');
    }
  }
};

router.post('/webhooks/whatsapp', ah(async (req, res) => {
  if (!verifyWebhookSignature(req.rawBody, req.headers['x-hub-signature-256'])) {
    console.error('❌ Webhook WhatsApp : signature invalide');
    return res.sendStatus(401);
  }
  // Meta attend une réponse rapide : on accuse réception puis on traite
  res.sendStatus(200);
  const { inbound, statuses } = parseWebhook(req.body);
  for (const s of statuses) await recordStatus(s).catch((e) => console.error('❌ Statut WA:', e.message));
  for (const m of inbound) {
    try {
      if (!(await recordInbound(m))) continue; // déjà traité
      await handleReply(m);
    } catch (e) {
      console.error('❌ Webhook WA:', e.message);
    }
  }
}));

// ------------------------------------------------------------------ Tâche planifiée externe (option)
router.post('/cron/tick', ah(async (req, res) => {
  const secret = String(req.headers['x-cron-secret'] || '');
  if (!config.cronSecret || !secret || !safeEqual(secret, config.cronSecret)) return res.sendStatus(403);
  res.json(await tick());
}));

export default router;
