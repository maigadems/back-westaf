// Liens envoyés par WhatsApp : /paiement/:token et /presence/:token côté site.
// Le jeton (48 caractères aléatoires) identifie une seule réservation.
import { Router } from 'express';
import { ah, badRequest, notFound } from '../lib/http.js';
import { minutesUntil } from '../lib/time.js';
import { tooMany } from '../lib/rateLimit.js';
import { getInt } from '../services/settingsService.js';
import { startPaytechPayment } from '../services/paymentService.js';
import { getReservationByToken, recordPresence, requestCashPayment } from '../services/reservationService.js';

const router = Router();

const load = async (req) => {
  if (tooMany(`action:${req.ip}`, 120, 10)) throw badRequest('Trop de requêtes');
  const r = await getReservationByToken(req.params.token);
  if (!r) throw notFound('Lien invalide ou expiré');
  return r;
};

const summary = async (r) => {
  const limit = await getInt('reschedule_limit_minutes', 120);
  return {
    id: r.id,
    first_name: r.first_name,
    service_name: r.service_name,
    start_at: r.start_at,
    end_at: r.end_at,
    statut: r.statut,
    session_status: r.session_status,
    presence_status: r.presence_status,
    payment_status: r.payment_status,
    amount_due: r.solde,
    montant_total: r.montant_total,
    can_reschedule_online: r.statut === 'confirmee' && !!r.start_at && minutesUntil(r.start_at) >= limit,
    reschedule_limit_minutes: limit
  };
};

router.get('/:token', ah(async (req, res) => res.json({ reservation: await summary(await load(req)) })));

router.post('/:token/presence', ah(async (req, res) => {
  const r = await load(req);
  const updated = await recordPresence(r, req.body?.answer, 'lien');
  res.json({ reservation: await summary(updated) });
}));

router.post('/:token/pay-online', ah(async (req, res) => {
  const r = await load(req);
  if (r.statut !== 'confirmee' || r.solde <= 0) throw badRequest('Aucun montant restant à payer');
  const pay = await startPaytechPayment(r, 'balance', r.solde);
  res.json({ redirectUrl: pay.redirectUrl });
}));

router.post('/:token/pay-cash', ah(async (req, res) => {
  const r = await load(req);
  res.json({ reservation: await summary(await requestCashPayment(r, 'lien')) });
}));

export default router;
