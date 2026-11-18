import { Router } from 'express';
import { one } from '../config/db.js';
import { ah, badRequest, notFound } from '../lib/http.js';
import { isValidDate, minutesUntil } from '../lib/time.js';
import { requireClient } from '../middleware/auth.js';
import { getDaySlots, getDaysSummary } from '../services/availabilityService.js';
import { getInt } from '../services/settingsService.js';
import { getInvoice, listInvoices } from '../services/invoiceService.js';
import { invoiceFilename, renderInvoicePdf } from '../services/invoicePdf.js';
import { startPaytechPayment } from '../services/paymentService.js';
import {
  abandonHold, assertOwner, createBooking, forClient, getReservation, listReservations, requestCashPayment, rescheduleReservation
} from '../services/reservationService.js';

const router = Router();
router.use(requireClient);

const withRules = async (r) => {
  const limit = await getInt('reschedule_limit_minutes', 120);
  const out = forClient(r);
  out.can_reschedule = r.booking_mode === 'slot' && r.statut === 'confirmee' && !!r.start_at &&
    !['en_cours', 'terminee', 'absent'].includes(r.session_status) && minutesUntil(r.start_at) >= limit;
  out.reschedule_limit_minutes = limit;
  out.can_pay_balance = r.statut === 'confirmee' && r.solde > 0 && r.payment_status !== 'en_attente_validation';
  out.can_resume_payment = r.statut === 'en_attente';
  return out;
};

router.get('/reservations', ah(async (req, res) => {
  const rows = await listReservations({ userId: req.user.id, includeHolds: false, statut: req.query.statut || undefined });
  res.json({ reservations: await Promise.all(rows.map(withRules)) });
}));

router.get('/reservations/:id', ah(async (req, res) => {
  const r = assertOwner(await getReservation(req.params.id), req.user);
  res.json({ reservation: await withRules(r) });
}));

// Nouvelle réservation : créneau bloqué, puis redirection vers PayTech
router.post('/reservations', ah(async (req, res) => {
  const { reservation, amountNow } = await createBooking(req.user, req.body || {});
  try {
    const pay = await startPaytechPayment(reservation, 'initial', amountNow);
    res.status(201).json({ reservation: await withRules(reservation), amountNow, redirectUrl: pay.redirectUrl });
  } catch (e) {
    await abandonHold(reservation.id); // le créneau est immédiatement libéré
    throw e;
  }
}));

// Reprendre un paiement interrompu (tant que le créneau est bloqué)
router.post('/reservations/:id/resume-payment', ah(async (req, res) => {
  const r = assertOwner(await getReservation(req.params.id), req.user);
  if (r.statut !== 'en_attente') throw badRequest('Cette réservation n’attend pas de paiement');
  // Même montant que la première tentative (acompte ou total)
  const last = await one("SELECT amount FROM payments WHERE reservation_id = ? AND kind = 'initial' ORDER BY id DESC LIMIT 1", [r.id]);
  const amount = last ? Number(last.amount) : r.montant_total;
  const pay = await startPaytechPayment(r, 'initial', amount);
  res.json({ redirectUrl: pay.redirectUrl });
}));

router.post('/reservations/:id/pay-balance', ah(async (req, res) => {
  const r = assertOwner(await getReservation(req.params.id), req.user);
  if (r.statut !== 'confirmee' || r.solde <= 0) throw badRequest('Aucun solde à régler');
  const pay = await startPaytechPayment(r, 'balance', r.solde);
  res.json({ redirectUrl: pay.redirectUrl });
}));

router.post('/reservations/:id/pay-cash', ah(async (req, res) => {
  const r = assertOwner(await getReservation(req.params.id), req.user);
  res.json({ reservation: await withRules(await requestCashPayment(r, 'espace_client')) });
}));

// Disponibilités pour un report (le créneau actuel du client est considéré comme libre)
router.get('/reservations/:id/availability', ah(async (req, res) => {
  const r = assertOwner(await getReservation(req.params.id), req.user);
  if (r.booking_mode !== 'slot') throw notFound('Pas de créneau pour ce service');
  const hours = r.duree_heures || 1;
  if (req.query.date) {
    if (!isValidDate(req.query.date)) throw badRequest('Date invalide');
    return res.json({ slots: await getDaySlots(req.query.date, hours, { excludeReservationId: r.id }) });
  }
  res.json({ days: await getDaysSummary(req.query.from, await getInt('booking_window_days', 30), hours, { excludeReservationId: r.id }) });
}));

router.post('/reservations/:id/reschedule', ah(async (req, res) => {
  const r = assertOwner(await getReservation(req.params.id), req.user);
  const updated = await rescheduleReservation(r, req.body?.start, req.user, { enforceClientRules: true });
  res.json({ reservation: await withRules(updated) });
}));

// Factures du client connecté uniquement
router.get('/invoices', ah(async (req, res) => res.json({ invoices: await listInvoices({ userId: req.user.id }) })));
router.get('/invoices/:id/pdf', ah(async (req, res) => {
  const inv = await getInvoice(req.params.id);
  if (inv.user_id !== req.user.id) throw notFound('Facture introuvable');
  sendPdf(res, inv);
}));
router.get('/invoices/:id', ah(async (req, res) => {
  const inv = await getInvoice(req.params.id);
  if (inv.user_id !== req.user.id) throw notFound('Facture introuvable');
  res.json({ invoice: inv });
}));

function sendPdf(res, inv) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoiceFilename(inv)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  renderInvoicePdf(inv, res);
}

export default router;
