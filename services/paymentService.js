// Paiements PayTech : acompte / total à la réservation, solde avant la session.
import axios from 'axios';
import crypto from 'crypto';
import { q, one, pool } from '../config/db.js';
import { config, paytechConfigured } from '../config/env.js';
import { HttpError, badRequest } from '../lib/http.js';
import { legacySlotsToRange, hoursBetween, rangeToLegacySlots } from '../lib/time.js';
import { intlPhone } from '../lib/phone.js';
import { confirmBalancePayment, confirmInitialPayment, getReservation } from './reservationService.js';
import { logHistory } from './historyService.js';
import * as notify from './notifier.js';
import { issueAfterPayment } from './invoiceService.js';
import { confirmMilestonePayment } from './orderService.js';

const headers = () => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  API_KEY: config.paytech.apiKey,
  API_SECRET: config.paytech.apiSecret
});

const ipnUrl = () => config.paytech.ipnUrl || (config.publicApiUrl ? `${config.publicApiUrl}/ipn` : '');

/**
 * Crée une demande de paiement PayTech pour une réservation.
 * kind : 'initial' (acompte / total) ou 'balance' (solde avant session).
 */
export const startPaytechPayment = async (reservation, kind, amount, milestone = null) => {
  if (!paytechConfigured()) throw new HttpError(503, 'Le paiement en ligne est momentanément indisponible. Contactez le studio.');
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('Montant invalide');
  const ref = `${kind === 'initial' ? 'RES' : kind === 'milestone' ? 'ETP' : 'BAL'}_${reservation.id.slice(0, 8)}_${Date.now()}`;
  await q("INSERT INTO payments (reservation_id, ref_command, kind, milestone_id, method, amount, status) VALUES (?, ?, ?, ?, 'online', ?, 'pending')", [
    reservation.id, ref, kind, milestone?.id || null, amount
  ]);
  const ret = `${config.frontendUrl}/paiement/retour?ref=${encodeURIComponent(ref)}&r=${encodeURIComponent(reservation.id)}`;
  const label = `${reservation.service_name}${reservation.start_at ? ` — ${reservation.start_at.slice(0, 16)}` : ''}`;
  const payload = {
    item_name: kind === 'initial' ? label : kind === 'milestone' ? `${milestone.label} — ${label}` : `Solde — ${label}`,
    item_price: amount,
    currency: config.paytech.currency,
    ref_command: ref,
    command_name: kind === 'initial' ? `Réservation ${reservation.service_name}` : `Solde réservation ${reservation.id.slice(0, 8)}`,
    env: config.paytech.env,
    ipn_url: ipnUrl(),
    success_url: `${ret}&status=success`,
    cancel_url: `${ret}&status=cancel`,
    custom_field: JSON.stringify({ ref, reservation_id: reservation.id, kind })
  };
  if (config.paytech.refundNotifUrl) payload.refund_notif_url = config.paytech.refundNotifUrl;

  try {
    const { data } = await axios.post(`${config.paytech.baseUrl}/payment/request-payment`, payload, { headers: headers(), timeout: 15000 });
    if (data.success !== 1 || !data.redirect_url) throw new Error(`Réponse PayTech inattendue : ${JSON.stringify(data).slice(0, 300)}`);
    await q('UPDATE payments SET provider_token = ? WHERE ref_command = ?', [data.token || null, ref]);
    return { redirectUrl: data.redirect_url, ref };
  } catch (e) {
    await q("UPDATE payments SET status = 'failed' WHERE ref_command = ?", [ref]);
    console.error('❌ PayTech request-payment:', e.response?.data || e.message);
    throw new HttpError(502, 'Impossible de créer le paiement en ligne pour le moment. Réessayez dans quelques instants.');
  }
};

// Authentification de l'IPN (logique identique à l'ancienne intégration)
export const verifyIpn = (b) => {
  const { apiKey, apiSecret } = config.paytech;
  if (!apiKey || !apiSecret) return false;
  if (b.hmac_compute) {
    const message = `${b.final_item_price || b.item_price}|${b.ref_command}|${apiKey}`;
    const expected = crypto.createHmac('sha256', apiSecret).update(message).digest('hex');
    return expected.length === String(b.hmac_compute).length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(b.hmac_compute)));
  }
  if (b.api_key_sha256 && b.api_secret_sha256) {
    const k = crypto.createHash('sha256').update(apiKey).digest('hex');
    const s = crypto.createHash('sha256').update(apiSecret).digest('hex');
    return k === b.api_key_sha256 && s === b.api_secret_sha256;
  }
  return false;
};

export const handleIpn = async (b) => {
  const payment = b.ref_command ? await one('SELECT * FROM payments WHERE ref_command = ?', [b.ref_command]) : null;

  if (!payment) {
    // Paiement initié par l'ancienne version du site (données dans custom_field)
    return handleLegacyIpn(b);
  }
  if (b.type_event === 'sale_canceled') {
    await q("UPDATE payments SET status = 'canceled' WHERE id = ? AND status = 'pending'", [payment.id]);
    return { handled: 'canceled' };
  }
  if (b.type_event !== 'sale_complete') return { handled: 'ignored' };
  if (payment.status === 'completed') return { handled: 'duplicate' };

  const paidAmount = Number(b.item_price || b.final_item_price);
  if (paidAmount !== Number(payment.amount)) {
    console.error(`❌ IPN : montant ${paidAmount} ≠ attendu ${payment.amount} (${payment.ref_command})`);
    await logHistory(payment.reservation_id, null, 'payment_conflict', { amount: paidAmount, expected: payment.amount, reason: 'Montant IPN inattendu' });
  }
  const [upd] = await pool.query(
    "UPDATE payments SET status = 'completed', completed_at = UTC_TIMESTAMP(), provider_method = ? WHERE id = ? AND status <> 'completed'",
    [String(b.payment_method || '').slice(0, 60) || null, payment.id]
  );
  if (!upd.affectedRows) return { handled: 'duplicate' };

  const p = { ...payment, provider_method: b.payment_method };
  if (payment.kind === 'initial') await confirmInitialPayment(payment.reservation_id, p);
  else if (payment.kind === 'milestone') await confirmMilestonePayment(p);
  else await confirmBalancePayment(payment.reservation_id, p);
  return { handled: payment.kind };
};

// --- Compatibilité : paiements lancés avant la mise en production de la nouvelle version ---
const handleLegacyIpn = async (b) => {
  if (b.type_event !== 'sale_complete') return { handled: 'legacy_ignored' };
  let data = null;
  try { data = JSON.parse(b.custom_field); } catch {
    try { data = JSON.parse(Buffer.from(String(b.custom_field || ''), 'base64').toString('utf-8')); } catch { data = null; }
  }
  const d = data?.reservationData;
  if (!d || !d.nom || !d.email) return { handled: 'legacy_no_data' };

  const dup = await one(
    'SELECT id FROM reservations WHERE email = ? AND date_reservation = ? AND type_service = ? AND created_at >= (UTC_TIMESTAMP() - INTERVAL 5 MINUTE)',
    [d.email, d.date_reservation, d.type_service]
  );
  if (dup) return { handled: 'legacy_duplicate' };

  const id = crypto.randomUUID();
  const partiel = d.type_service === 'horaire' && d.paymentOption === 'half';
  const paid = partiel ? Math.ceil(d.montant_total / 2) : Number(d.montant_total);
  const range = d.type_service === 'horaire' ? legacySlotsToRange(d.date_reservation, d.creneaux) : null;
  const service = await one('SELECT id FROM services WHERE slug = ?', [{ horaire: 'enregistrement-studio', mixage: 'mixage', mastering: 'mastering' }[d.type_service] || '']);
  const user = await one('SELECT id FROM users WHERE email = ?', [String(d.email).toLowerCase()]);
  const ps = paid >= d.montant_total ? 'paye' : 'acompte';
  await q(
    `INSERT INTO reservations (id, user_id, service_id, nom, email, telephone, message, date_reservation, start_at, end_at, creneaux,
       duree_heures, montant_total, type_paiement, montant_paye, payment_status, statut, session_status, type_service, nombre_titres, action_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmee', ?, ?, ?, ?)`,
    [id, user?.id || null, service?.id || null, d.nom, d.email, intlPhone(d.telephone) || d.telephone, d.message || '', d.date_reservation,
      range?.start || null, range?.end || null, range ? JSON.stringify(rangeToLegacySlots(range.start, range.end)) : null,
      d.duree_heures ?? null, d.montant_total, partiel ? 'partiel' : 'total', paid, ps, ps === 'paye' && range ? 'autorisee' : 'planifiee',
      d.type_service, d.nombre_titres ?? null, crypto.randomBytes(24).toString('hex')]
  );
  if (range) for (const h of hoursBetween(range.start, range.end)) await q('INSERT IGNORE INTO slot_locks (slot_start, reservation_id) VALUES (?, ?)', [h, id]);
  await q("INSERT INTO payments (reservation_id, ref_command, kind, method, amount, status, completed_at) VALUES (?, ?, 'initial', 'online', ?, 'completed', UTC_TIMESTAMP())", [
    id, String(b.ref_command || `LEGACY_${id}`), paid
  ]);
  await logHistory(id, null, 'payment_initial', { amount: paid, legacy: true });
  await issueAfterPayment(id);
  await notify.bookingConfirmed(await getReservation(id), paid);
  return { handled: 'legacy_created', id };
};

export const listPayments = async ({ status, method, month, limit = 300 } = {}) => {
  const where = [];
  const params = [];
  if (/^\d{4}-\d{2}$/.test(String(month || ''))) { where.push('COALESCE(p.completed_at, p.created_at) >= ? AND COALESCE(p.completed_at, p.created_at) < (? + INTERVAL 1 MONTH)'); params.push(month + '-01', month + '-01'); }
  if (status) { where.push('p.status = ?'); params.push(status); }
  if (method) { where.push('p.method = ?'); params.push(method); }
  return q(
    `SELECT p.*, r.nom, r.telephone, r.start_at, r.montant_total, r.montant_paye, r.payment_status,
            COALESCE(s.name, r.type_service) AS service_name,
            TRIM(CONCAT(COALESCE(v.first_name,''),' ',COALESCE(v.last_name,''))) AS validated_by_name
     FROM payments p JOIN reservations r ON r.id = p.reservation_id
     LEFT JOIN services s ON s.id = r.service_id LEFT JOIN users v ON v.id = p.validated_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.created_at DESC LIMIT ?`,
    [...params, Math.min(Number(limit) || 300, 1000)]
  );
};

/**
 * Totaux encaissés pour l'administration (paiements confirmés : en ligne et espèces validées).
 * month : 'YYYY-MM' (mois courant par défaut).
 */
export const paymentSummary = async (month) => {
  const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : new Date().toISOString().slice(0, 7);
  const start = m + '-01';
  const sum = async (where, params = []) => {
    const r = await one(
      "SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS n FROM payments WHERE status = 'completed' AND " + where, params
    );
    return { amount: Number(r.amount), count: Number(r.n) };
  };
  const inMonth = 'completed_at >= ? AND completed_at < (? + INTERVAL 1 MONTH)';
  const [total, online, cash, prev, today, week, year, all] = await Promise.all([
    sum(inMonth, [start, start]),
    sum(inMonth + " AND method = 'online'", [start, start]),
    sum(inMonth + " AND method = 'cash'", [start, start]),
    sum('completed_at >= (? - INTERVAL 1 MONTH) AND completed_at < ?', [start, start]),
    sum('DATE(completed_at) = UTC_DATE()'),
    sum('completed_at >= UTC_DATE() - INTERVAL WEEKDAY(UTC_DATE()) DAY'),
    sum("completed_at >= DATE_FORMAT(UTC_DATE(), '%Y-01-01')"),
    sum('1 = 1')
  ]);
  const byKind = await q(
    "SELECT kind, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS n FROM payments WHERE status = 'completed' AND " + inMonth + ' GROUP BY kind',
    [start, start]
  );
  const daily = await q(
    "SELECT DATE(completed_at) AS day, SUM(amount) AS amount, COUNT(*) AS n FROM payments WHERE status = 'completed' AND " + inMonth + ' GROUP BY DATE(completed_at) ORDER BY day',
    [start, start]
  );
  const pendingCash = await one("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM payments WHERE method = 'cash' AND status = 'awaiting_validation'");
  const outstanding = await one(
    "SELECT COALESCE(SUM(montant_total - montant_paye), 0) AS due FROM reservations WHERE statut IN ('confirmee','a_traiter') AND montant_total > montant_paye"
  );
  return {
    month: m,
    total, online, cash, previousMonth: prev, today, week, year, allTime: all,
    byKind: Object.fromEntries(byKind.map((k) => [k.kind, { amount: Number(k.amount), count: Number(k.n) }])),
    daily: daily.map((d) => ({ day: d.day, amount: Number(d.amount), count: Number(d.n) })),
    pendingCash: { count: Number(pendingCash.n), amount: Number(pendingCash.amount) },
    outstanding: Number(outstanding.due)
  };
};
