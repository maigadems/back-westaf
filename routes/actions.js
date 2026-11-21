// Liens envoyés par WhatsApp : /paiement/:token et /presence/:token côté site.
// Le jeton (48 caractères aléatoires) identifie une seule réservation.
import { Router } from 'express';
import { ah, badRequest, notFound } from '../lib/http.js';
import { minutesUntil } from '../lib/time.js';
import { tooMany } from '../lib/rateLimit.js';
import { getInt } from '../services/settingsService.js';
import { startPaytechPayment } from '../services/paymentService.js';
import { getReservationByToken, recordPresence, requestCashPayment } from '../services/reservationService.js';
import { currentDueMilestone, orderInfo, requestMilestoneCash } from '../services/orderService.js';
import { getInvoiceByToken } from '../services/invoiceService.js';
import { invoiceFilename, renderInvoicePdf } from '../services/invoicePdf.js';

const router = Router();

const load = async (req) => {
  if (tooMany(`action:${req.ip}`, 120, 10)) throw badRequest('Trop de requêtes');
  const r = await getReservationByToken(req.params.token);
  if (!r) throw notFound('Lien invalide ou expiré');
  return r;
};

const summary = async (r) => {
  const limit = await getInt('reschedule_limit_minutes', 120);
  const order = await orderInfo(r);
  const due = order?.milestones.find((m) => m.id === order.current_id) || null;
  return {
    is_order: !!order?.milestones.length,
    nombre_titres: r.nombre_titres,
    milestone: due && { id: due.id, label: due.label, amount: due.amount, percent: due.percent, status: due.status, deliverable_note: due.deliverable_note },
    milestones: order?.milestones.map((m) => ({ label: m.label, percent: m.percent, amount: m.amount, status: m.status })) || [],
    id: r.id,
    first_name: r.first_name,
    service_name: r.service_name,
    start_at: r.start_at,
    end_at: r.end_at,
    statut: r.statut,
    session_status: r.session_status,
    presence_status: r.presence_status,
    payment_status: r.payment_status,
    amount_due: due ? due.amount : order?.milestones.length ? 0 : r.solde,
    montant_total: r.montant_total,
    can_reschedule_online: r.statut === 'confirmee' && !!r.start_at && minutesUntil(r.start_at) >= limit,
    reschedule_limit_minutes: limit
  };
};

router.get('/:token', ah(async (req, res) => res.json({ reservation: await summary(await load(req)) })));

// Facture accessible par le lien envoyé au client (WhatsApp, e-mail, partage)
router.get('/:token/invoice', ah(async (req, res) => {
  await load(req);
  const { user_id, ...invoice } = await getInvoiceByToken(req.params.token);
  res.json({ invoice });
}));
router.get('/:token/invoice/pdf', ah(async (req, res) => {
  await load(req);
  const inv = await getInvoiceByToken(req.params.token);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoiceFilename(inv)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  renderInvoicePdf(inv, res);
}));

router.post('/:token/presence', ah(async (req, res) => {
  const r = await load(req);
  const updated = await recordPresence(r, req.body?.answer, 'lien');
  res.json({ reservation: await summary(updated) });
}));

router.post('/:token/pay-online', ah(async (req, res) => {
  const r = await load(req);
  const m = await currentDueMilestone(r);
  if (m) {
    if (m.status !== 'demande') throw badRequest('Paiement en espèces déjà annoncé pour cette étape');
    return res.json({ redirectUrl: (await startPaytechPayment(r, 'milestone', m.amount, m)).redirectUrl });
  }
  if ((await orderInfo(r))?.milestones.length) throw badRequest('Aucun paiement n’est demandé pour le moment');
  if (r.statut !== 'confirmee' || r.solde <= 0) throw badRequest('Aucun montant restant à payer');
  const pay = await startPaytechPayment(r, 'balance', r.solde);
  res.json({ redirectUrl: pay.redirectUrl });
}));

router.post('/:token/pay-cash', ah(async (req, res) => {
  const r = await load(req);
  const isOrder = (await orderInfo(r))?.milestones.length;
  res.json({ reservation: await summary(isOrder ? await requestMilestoneCash(r, 'lien') : await requestCashPayment(r, 'lien')) });
}));

export default router;
