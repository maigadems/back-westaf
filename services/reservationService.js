import crypto from 'crypto';
import { q, one, tx } from '../config/db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import { addMinutes, hoursBetween, isValidDateTime, minutesUntil, normDateTime, nowSql, rangeToLegacySlots, todayStr } from '../lib/time.js';
import { intlPhone } from '../lib/phone.js';
import { assertSlotAvailable, engineerIsFree } from './availabilityService.js';
import { getInt } from './settingsService.js';
import { logHistory } from './historyService.js';
import * as notify from './notifier.js';
import { issueAfterPayment } from './invoiceService.js';
import { insertMilestones, markDepositPaid, planFromService, rescaleUnpaid } from './orderService.js';

// Statuts
export const STATUTS = ['en_attente', 'confirmee', 'annulee', 'terminee', 'expiree', 'a_traiter'];
export const PAYMENT_STATUSES = ['non_paye', 'acompte', 'en_attente_validation', 'paye'];
export const SESSION_STATUSES = ['planifiee', 'autorisee', 'en_cours', 'terminee', 'absent', 'annulee'];

const LEGACY_TYPES = { 'enregistrement-studio': 'horaire', mixage: 'mixage', mastering: 'mastering' };
const LEGACY_NAMES = { horaire: 'Enregistrement studio', mixage: 'Mixage de titre', mastering: 'Mastering' };

export const COMPLETED_SQL = "(r.statut = 'terminee' OR (r.statut = 'confirmee' AND r.end_at IS NOT NULL AND r.end_at < UTC_TIMESTAMP()))";
// Réservations « réelles » : hors paniers non payés / expirés
export const REAL_SQL = "r.statut NOT IN ('en_attente','expiree')";

const BASE_SELECT = `SELECT r.*, s.name AS service_name, s.slug AS service_slug, s.booking_mode, a.name AS addon_name, s.price AS service_unit_price,
    TRIM(CONCAT(COALESCE(e.first_name,''), ' ', COALESCE(e.last_name,''))) AS engineer_name, e.phone AS engineer_phone,
    u.first_name AS client_first_name, u.last_name AS client_last_name, u.email AS client_email, u.phone AS client_phone
  FROM reservations r
  LEFT JOIN services s ON s.id = r.service_id
  LEFT JOIN services a ON a.id = r.addon_service_id
  LEFT JOIN users e ON e.id = r.engineer_id
  LEFT JOIN users u ON u.id = r.user_id`;

const parse = (r) => {
  if (!r) return r;
  let creneaux = null;
  try { creneaux = r.creneaux ? JSON.parse(r.creneaux) : null; } catch { creneaux = null; }
  const hours = r.start_at && r.end_at ? hoursBetween(r.start_at, r.end_at).length : r.duree_heures;
  return {
    ...r,
    creneaux,
    service_name: `${r.service_name || LEGACY_NAMES[r.type_service] || r.type_service}${r.addon_name ? ` + ${r.addon_name}` : ''}`,
    base_service_name: r.service_name || LEGACY_NAMES[r.type_service] || r.type_service,
    booking_mode: r.booking_mode || (r.type_service === 'horaire' ? 'slot' : 'per_track'),
    duree_heures: hours ?? null,
    montant_total: Number(r.montant_total),
    montant_paye: Number(r.montant_paye),
    solde: Math.max(0, Number(r.montant_total) - Number(r.montant_paye)),
    first_name: r.client_first_name || String(r.nom || '').split(' ')[0]
  };
};

// --- Projections selon le rôle (aucune donnée financière pour les ingénieurs) ---
export const forAdmin = (r) => r;

export const forClient = (r) => {
  const { internal_notes, engineer_phone, hold_expires_at, ...rest } = r;
  return rest;
};

const ENGINEER_FIELDS = [
  'id', 'nom', 'email', 'telephone', 'message', 'internal_notes', 'date_reservation', 'start_at', 'end_at', 'duree_heures',
  'nombre_titres', 'statut', 'session_status', 'presence_status', 'reschedule_count', 'service_name', 'service_slug',
  'booking_mode', 'engineer_id', 'engineer_name', 'created_at', 'updated_at', 'completed_at', 'cancelled_at', 'cancel_reason'
];
export const forEngineer = (r) => {
  const out = Object.fromEntries(ENGINEER_FIELDS.map((k) => [k, r[k] ?? null]));
  out.autorisee_a_commencer = ['autorisee', 'en_cours', 'terminee'].includes(r.session_status);
  return out;
};

export const getReservation = async (id) => parse(await one(`${BASE_SELECT} WHERE r.id = ?`, [id]));
export const getReservationByToken = async (token) =>
  /^[a-f0-9]{48}$/.test(String(token || '')) ? parse(await one(`${BASE_SELECT} WHERE r.action_token = ?`, [token])) : null;

export const listReservations = async (f = {}) => {
  const where = [];
  const params = [];
  if (f.userId) { where.push('r.user_id = ?'); params.push(f.userId); }
  if (f.engineerId) { where.push('r.engineer_id = ?'); params.push(f.engineerId); }
  if (f.serviceId) { where.push('r.service_id = ?'); params.push(Number(f.serviceId)); }
  if (f.statut) {
    if (f.statut === 'terminee') where.push(COMPLETED_SQL);
    else if (f.statut === 'a_venir') where.push("r.statut = 'confirmee' AND (r.start_at IS NULL OR r.start_at >= UTC_TIMESTAMP())");
    else if (f.statut === 'reportee') where.push('r.reschedule_count > 0');
    else if (f.statut === 'confirmee') where.push("r.statut = 'confirmee' AND (r.end_at IS NULL OR r.end_at >= UTC_TIMESTAMP())");
    else { where.push('r.statut = ?'); params.push(f.statut); }
  } else if (!f.includeHolds) {
    where.push(REAL_SQL);
  }
  if (f.paymentStatus) { where.push('r.payment_status = ?'); params.push(f.paymentStatus); }
  if (f.from) { where.push('COALESCE(DATE(r.start_at), r.date_reservation) >= ?'); params.push(f.from); }
  if (f.to) { where.push('COALESCE(DATE(r.start_at), r.date_reservation) <= ?'); params.push(f.to); }
  if (f.search) {
    const s = `%${f.search}%`;
    where.push('(r.nom LIKE ? OR r.email LIKE ? OR r.telephone LIKE ? OR r.id LIKE ?)');
    params.push(s, s, `%${String(f.search).replace(/\s|\+/g, '')}%`, s);
  }
  const order = f.order === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Number(f.limit) || 500, 2000);
  const rows = await q(
    `${BASE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY COALESCE(r.start_at, r.date_reservation) ${order}, r.created_at ${order} LIMIT ?`,
    [...params, limit]
  );
  return rows.map(parse);
};

// ---------------------------------------------------------------------------
// Création (client connecté)
// ---------------------------------------------------------------------------
export const createBooking = async (user, input) => {
  const service = await one('SELECT * FROM services WHERE id = ? AND is_active = 1', [Number(input.service_id)]);
  if (!service) throw badRequest('Service indisponible');
  if (service.booking_mode === 'quote' || !service.price) throw badRequest('Ce service se réserve sur devis : contactez le studio');

  const phone = intlPhone(input.phone || user.phone);
  if (!phone) throw badRequest('Un numéro de téléphone WhatsApp valide est requis pour la réservation');
  if (!user.phone || user.phone !== phone) await q('UPDATE users SET phone = ? WHERE id = ?', [phone, user.id]);

  const message = input.message ? String(input.message).slice(0, 2000) : '';
  const fullName = `${user.first_name} ${user.last_name}`.trim() || user.email;
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('hex');
  const holdMinutes = await getInt('hold_minutes', 30);

  let start = null, end = null, hours = null, tracks = null, total;
  if (service.booking_mode === 'slot') {
    if (!isValidDateTime(input.start)) throw badRequest('Choisissez un créneau');
    start = normDateTime(input.start);
    hours = Number(input.hours);
    if (!Number.isInteger(hours) || hours < service.min_hours || hours > service.max_hours) {
      throw badRequest(`Durée invalide (${service.min_hours} à ${service.max_hours} h)`);
    }
    await assertSlotAvailable(start, hours);
    end = addMinutes(start, hours * 60);
    total = service.price * hours;
  } else {
    tracks = Number(input.tracks);
    if (!Number.isInteger(tracks) || tracks < 1 || tracks > 50) throw badRequest('Nombre de titres invalide (1 à 50)');
    total = service.price * tracks;
  }
  const addon = input.with_mastering ? await masteringAddonFor(service) : null;
  if (input.with_mastering && !addon) throw badRequest('Le mastering n’est pas disponible en option pour ce service');
  if (addon) total += addon.price * tracks;
  // Commande au titre (mixage, mastering) : paiement par étapes fixées par le studio
  const plan = service.booking_mode === 'per_track' ? planFromService(service) : null;
  const deposit = plan ? plan.length > 1 : service.allow_deposit && input.payment_option === 'deposit';
  let amountNow = plan ? Math.round((total * plan[0].percent) / 100) : deposit ? Math.ceil((total * service.deposit_percent) / 100) : total;

  await tx(async (conn) => {
    await conn.query(
      `INSERT INTO reservations (id, user_id, service_id, nom, email, telephone, message, date_reservation, start_at, end_at,
         creneaux, duree_heures, montant_total, type_paiement, montant_paye, payment_status, statut, session_status,
         type_service, nombre_titres, action_token, hold_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'non_paye', 'en_attente', 'planifiee', ?, ?, ?, ?)`,
      [id, user.id, service.id, fullName, user.email || '', phone, message, start ? start.slice(0, 10) : todayStr(), start, end,
        start ? JSON.stringify(rangeToLegacySlots(start, end)) : null, hours, total, deposit ? 'partiel' : 'total',
        LEGACY_TYPES[service.slug] || service.slug, tracks, token, addMinutes(new Date(), holdMinutes)]
    );
    if (start) await lockSlots(conn, id, start, end);
    if (addon) await conn.query('UPDATE reservations SET addon_service_id = ?, addon_unit_price = ? WHERE id = ?', [addon.id, addon.price, id]);
    if (plan) amountNow = await insertMilestones(conn, id, total, plan);
    await logHistory(id, user, 'created', { to: start, service: service.name, amountNow }, conn);
  });

  return { reservation: await getReservation(id), amountNow };
};

// Réservation saisie par l'administration (client venu au studio ou par téléphone) :
// confirmée immédiatement, le paiement est encaissé ensuite (en ligne ou en espèces).
export const adminCreateBooking = async (actor, input) => {
  const service = await one('SELECT * FROM services WHERE id = ?', [Number(input.service_id)]);
  if (!service || service.booking_mode === 'quote') throw badRequest('Service invalide');
  const nom = String(input.nom || '').trim();
  if (!nom) throw badRequest('Nom du client requis');
  const phone = intlPhone(input.telephone);
  if (!phone) throw badRequest('Téléphone invalide');
  const mail = String(input.email || '').trim().toLowerCase();
  let userId = input.user_id ? Number(input.user_id) : null;
  if (!userId && mail) userId = (await one('SELECT id FROM users WHERE email = ?', [mail]))?.id || null;

  let start = null, end = null, hours = null, tracks = null, total;
  if (service.booking_mode === 'slot') {
    if (!isValidDateTime(input.start)) throw badRequest('Créneau invalide');
    start = normDateTime(input.start);
    hours = Number(input.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 16) throw badRequest('Durée invalide');
    await assertSlotAvailable(start, hours, { ignoreLeadTime: true, ignoreWindow: true });
    end = addMinutes(start, hours * 60);
    total = (service.price || 0) * hours;
  } else {
    tracks = Number(input.tracks) || 1;
    total = (service.price || 0) * tracks;
  }
  const addon = input.with_mastering ? await masteringAddonFor(service) : null;
  if (addon) total += addon.price * tracks;
  if (input.montant_total !== undefined && input.montant_total !== '') total = Number(input.montant_total);
  if (!Number.isInteger(total) || total < 0) throw badRequest('Montant invalide');

  const id = crypto.randomUUID();
  await tx(async (conn) => {
    await conn.query(
      `INSERT INTO reservations (id, user_id, service_id, nom, email, telephone, message, date_reservation, start_at, end_at, creneaux,
         duree_heures, montant_total, type_paiement, montant_paye, payment_status, statut, session_status, type_service, nombre_titres, action_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'total', 0, ?, 'confirmee', ?, ?, ?, ?)`,
      [id, userId, service.id, nom, mail, phone, String(input.message || '').slice(0, 2000), start ? start.slice(0, 10) : todayStr(), start, end,
        start ? JSON.stringify(rangeToLegacySlots(start, end)) : null, hours, total, total === 0 ? 'paye' : 'non_paye',
        total === 0 && start ? 'autorisee' : 'planifiee', LEGACY_TYPES[service.slug] || service.slug, tracks, crypto.randomBytes(24).toString('hex')]
    );
    if (start) await lockSlots(conn, id, start, end);
    if (addon) await conn.query('UPDATE reservations SET addon_service_id = ?, addon_unit_price = ? WHERE id = ?', [addon.id, addon.price, id]);
    if (service.booking_mode === 'per_track' && total > 0) {
      await insertMilestones(conn, id, total, planFromService(service), { firstStatus: 'demande' });
      await conn.query("UPDATE reservations SET type_paiement = 'partiel', production_status = 'en_attente' WHERE id = ?", [id]);
    }
    await logHistory(id, actor, 'created', { to: start, service: service.name, by: 'admin' }, conn);
  });
  let r = await getReservation(id);
  if (input.engineer_id) r = await assignEngineer(r, Number(input.engineer_id), actor);
  return r;
};

// Mastering proposé en option lors d'une commande de mixage (service actif avec un tarif)
export const masteringAddonFor = async (service) => {
  if (service.slug !== 'mixage') return null;
  const m = await one("SELECT id, name, price FROM services WHERE slug = 'mastering' AND is_active = 1 AND booking_mode = 'per_track' AND price > 0");
  return m || null;
};

const lockSlots = async (conn, reservationId, start, end) => {
  try {
    for (const h of hoursBetween(start, end)) {
      await conn.query('INSERT INTO slot_locks (slot_start, reservation_id) VALUES (?, ?)', [h, reservationId]);
    }
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw conflict('Ce créneau vient d’être réservé par un autre client. Choisissez un autre horaire.', { code: 'SLOT_TAKEN' });
    throw e;
  }
};

const releaseSlots = (conn, reservationId) => conn.query('DELETE FROM slot_locks WHERE reservation_id = ?', [reservationId]);

// Libère les créneaux non payés à l'expiration du délai de paiement
export const expireHolds = async () => {
  const rows = await q("SELECT id FROM reservations WHERE statut = 'en_attente' AND hold_expires_at IS NOT NULL AND hold_expires_at < UTC_TIMESTAMP()");
  for (const r of rows) {
    await tx(async (conn) => {
      const [res] = await conn.query("UPDATE reservations SET statut = 'expiree' WHERE id = ? AND statut = 'en_attente'", [r.id]);
      if (res.affectedRows) {
        await releaseSlots(conn, r.id);
        await logHistory(r.id, null, 'expired', { reason: 'Paiement non finalisé dans le délai' }, conn);
      }
    });
  }
  return rows.length;
};

// Abandon immédiat d'une réservation non payée (échec de création du paiement)
export const abandonHold = async (id) =>
  tx(async (conn) => {
    await conn.query("UPDATE reservations SET statut = 'expiree' WHERE id = ? AND statut = 'en_attente'", [id]);
    await releaseSlots(conn, id);
  });

// ---------------------------------------------------------------------------
// Paiements
// ---------------------------------------------------------------------------
const derivePaymentStatus = (total, paid) => (paid >= total && total > 0 ? 'paye' : paid > 0 ? 'acompte' : 'non_paye');

// Paiement initial (acompte ou total) confirmé par PayTech
export const confirmInitialPayment = async (reservationId, payment) => {
  const outcome = await tx(async (conn) => {
    const [[r]] = await conn.query('SELECT * FROM reservations WHERE id = ? FOR UPDATE', [reservationId]);
    if (!r) return { status: 'missing' };
    if (r.statut === 'confirmee' || r.statut === 'terminee') return { status: 'already' };
    // Réservation expirée entre-temps : on tente de reprendre le créneau
    if (r.statut === 'expiree' && r.start_at) {
      try {
        await lockSlots(conn, r.id, r.start_at, r.end_at);
      } catch {
        await releaseSlots(conn, r.id); // retire les heures partiellement verrouillées
        await conn.query("UPDATE reservations SET statut = 'a_traiter', montant_paye = montant_paye + ?, payment_status = ? WHERE id = ?", [
          payment.amount, derivePaymentStatus(r.montant_total, r.montant_paye + payment.amount), r.id
        ]);
        await logHistory(r.id, null, 'payment_conflict', { amount: payment.amount, reason: 'Créneau repris par un autre client' }, conn);
        return { status: 'conflict' };
      }
    }
    const paid = Number(r.montant_paye) + Number(payment.amount);
    const ps = derivePaymentStatus(Number(r.montant_total), paid);
    await conn.query(
      `UPDATE reservations SET statut = 'confirmee', montant_paye = ?, payment_status = ?, hold_expires_at = NULL,
         session_status = IF(? = 'paye' AND start_at IS NOT NULL, 'autorisee', session_status) WHERE id = ?`,
      [paid, ps, ps, r.id]
    );
    await markDepositPaid(conn, r.id);
    await logHistory(r.id, null, 'payment_initial', { amount: payment.amount, method: payment.provider_method || 'online', status: ps }, conn);
    return { status: 'confirmed' };
  });
  if (outcome.status === 'confirmed' || outcome.status === 'conflict') await issueAfterPayment(reservationId);
  const res = await getReservation(reservationId);
  if (outcome.status === 'confirmed') await notify.bookingConfirmed(res, payment.amount);
  if (outcome.status === 'conflict') await notify.paymentConflict(res, payment.amount);
  return { ...outcome, reservation: res };
};

// Solde réglé (en ligne ou espèces validées) => « Payé » + « Autorisée à commencer »
const markFullyPaid = async (conn, r, actor, { amount, method }) => {
  await conn.query(
    `UPDATE reservations SET montant_paye = montant_total, payment_status = 'paye',
       session_status = IF(session_status IN ('planifiee'), 'autorisee', session_status) WHERE id = ?`,
    [r.id]
  );
  await logHistory(r.id, actor, method === 'cash' ? 'cash_validated' : 'payment_balance', { amount, method, status: 'paye' }, conn);
};

export const confirmBalancePayment = async (reservationId, payment) => {
  const done = await tx(async (conn) => {
    const [[r]] = await conn.query('SELECT * FROM reservations WHERE id = ? FOR UPDATE', [reservationId]);
    if (!r || r.payment_status === 'paye') return false;
    await markFullyPaid(conn, r, null, { amount: payment.amount, method: 'online' });
    // Une éventuelle demande « espèces » en attente devient caduque
    await conn.query("UPDATE payments SET status = 'canceled' WHERE reservation_id = ? AND method = 'cash' AND status = 'awaiting_validation'", [r.id]);
    return true;
  });
  if (done) await issueAfterPayment(reservationId);
  const res = await getReservation(reservationId);
  if (done) await notify.balancePaid(res, payment.amount, 'online');
  return res;
};

export const requestCashPayment = async (res, via = 'web') => {
  if (res.statut !== 'confirmee') throw badRequest('Cette réservation n’est pas active');
  if (res.payment_status === 'paye') throw badRequest('Cette réservation est déjà réglée');
  if (res.payment_status === 'en_attente_validation') return getReservation(res.id);
  await tx(async (conn) => {
    await conn.query(
      `INSERT INTO payments (reservation_id, ref_command, kind, method, amount, status) VALUES (?, ?, 'balance', 'cash', ?, 'awaiting_validation')`,
      [res.id, `CASH_${res.id.slice(0, 8)}_${Date.now()}`, res.solde]
    );
    await conn.query("UPDATE reservations SET payment_status = 'en_attente_validation' WHERE id = ?", [res.id]);
    await logHistory(res.id, null, 'cash_requested', { amount: res.solde, via }, conn);
  });
  const updated = await getReservation(res.id);
  await notify.cashRequested(updated);
  return updated;
};

export const validateCashPayment = async (res, actor) => {
  if (res.payment_status === 'paye') throw badRequest('Cette réservation est déjà réglée');
  if (['annulee', 'expiree'].includes(res.statut)) throw badRequest('Réservation annulée');
  const amount = res.solde;
  await tx(async (conn) => {
    const [[p]] = await conn.query(
      "SELECT id FROM payments WHERE reservation_id = ? AND method = 'cash' AND status = 'awaiting_validation' ORDER BY id DESC LIMIT 1 FOR UPDATE",
      [res.id]
    );
    if (p) {
      await conn.query("UPDATE payments SET status = 'completed', amount = ?, validated_by = ?, completed_at = UTC_TIMESTAMP() WHERE id = ?", [amount, actor.id, p.id]);
    } else {
      await conn.query(
        `INSERT INTO payments (reservation_id, ref_command, kind, method, amount, status, validated_by, completed_at)
         VALUES (?, ?, 'balance', 'cash', ?, 'completed', ?, UTC_TIMESTAMP())`,
        [res.id, `CASH_${res.id.slice(0, 8)}_${Date.now()}`, amount, actor.id]
      );
    }
    await markFullyPaid(conn, res, actor, { amount, method: 'cash' });
  });
  await issueAfterPayment(res.id);
  const updated = await getReservation(res.id);
  await notify.balancePaid(updated, amount, 'cash');
  return updated;
};

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
export const rescheduleReservation = async (res, newStartRaw, actor, { enforceClientRules = true } = {}) => {
  if (res.booking_mode !== 'slot' || !res.start_at) throw badRequest('Cette réservation ne comporte pas de créneau horaire');
  if (res.statut !== 'confirmee') throw badRequest('Seule une réservation confirmée peut être reportée');
  if (['en_cours', 'terminee', 'absent'].includes(res.session_status)) throw badRequest('Cette session a déjà commencé ou est terminée');
  if (!isValidDateTime(newStartRaw)) throw badRequest('Nouveau créneau invalide');
  const newStart = normDateTime(newStartRaw);
  if (newStart === res.start_at) throw badRequest('Choisissez un créneau différent');

  if (enforceClientRules) {
    const limit = await getInt('reschedule_limit_minutes', 120);
    if (minutesUntil(res.start_at) < limit) {
      throw forbidden(`Le report en ligne n’est plus possible à moins de ${Math.round(limit / 60)} h de la session. Contactez le studio.`);
    }
  }
  const hours = res.duree_heures || 1;
  await assertSlotAvailable(newStart, hours, { excludeReservationId: res.id, ignoreWindow: !enforceClientRules });
  const newEnd = addMinutes(newStart, hours * 60);
  const from = res.start_at;

  await tx(async (conn) => {
    const [[locked]] = await conn.query('SELECT statut, start_at FROM reservations WHERE id = ? FOR UPDATE', [res.id]);
    if (locked.statut !== 'confirmee' || locked.start_at !== from) throw conflict('La réservation a été modifiée entre-temps, rechargez la page');
    await releaseSlots(conn, res.id);
    await lockSlots(conn, res.id, newStart, newEnd);
    await conn.query(
      `UPDATE reservations SET start_at = ?, end_at = ?, date_reservation = ?, creneaux = ?, reschedule_count = reschedule_count + 1,
         reminder_sent_at = NULL, payment_link_sent_at = NULL, presence_status = 'non_demandee', presence_answered_at = NULL
       WHERE id = ?`,
      [newStart, newEnd, newStart.slice(0, 10), JSON.stringify(rangeToLegacySlots(newStart, newEnd)), res.id]
    );
    await logHistory(res.id, actor, 'rescheduled', { from, to: newStart }, conn);
  });

  const updated = await getReservation(res.id);
  let engineerWarning = null;
  if (updated.engineer_id) {
    const free = await engineerIsFree(updated.engineer_id, newStart, newEnd, updated.id);
    if (!free.free) engineerWarning = free.reason;
  }
  await notify.rescheduled(updated, from, actor, engineerWarning);
  return updated;
};

// ---------------------------------------------------------------------------
// Annulation, affectation, modifications administratives
// ---------------------------------------------------------------------------
export const cancelReservation = async (res, actor, reason = '') => {
  if (['annulee', 'expiree'].includes(res.statut)) throw badRequest('Réservation déjà annulée');
  await tx(async (conn) => {
    await conn.query(
      "UPDATE reservations SET statut = 'annulee', session_status = 'annulee', cancelled_at = UTC_TIMESTAMP(), cancel_reason = ? WHERE id = ?",
      [String(reason || '').slice(0, 255) || null, res.id]
    );
    await releaseSlots(conn, res.id);
    await conn.query("UPDATE payments SET status = 'canceled' WHERE reservation_id = ? AND status IN ('pending','awaiting_validation')", [res.id]);
    await logHistory(res.id, actor, 'cancelled', { reason }, conn);
  });
  const updated = await getReservation(res.id);
  await notify.cancelled(updated, actor, reason);
  return updated;
};

export const assignEngineer = async (res, engineerId, actor) => {
  if (engineerId === null) {
    await q('UPDATE reservations SET engineer_id = NULL WHERE id = ?', [res.id]);
    await logHistory(res.id, actor, 'engineer_unassigned', { engineer: res.engineer_name });
    return getReservation(res.id);
  }
  const eng = await one("SELECT * FROM users WHERE id = ? AND role = 'engineer'", [engineerId]);
  if (!eng || !eng.is_active) throw badRequest('Ingénieur introuvable ou désactivé');
  if (res.start_at) {
    const free = await engineerIsFree(eng.id, res.start_at, res.end_at, res.id);
    if (!free.free) throw conflict(free.reason === 'absent' ? 'Cet ingénieur est indisponible sur ce créneau' : 'Cet ingénieur a déjà une session sur ce créneau');
  }
  await q('UPDATE reservations SET engineer_id = ? WHERE id = ?', [eng.id, res.id]);
  const name = `${eng.first_name} ${eng.last_name}`.trim();
  await logHistory(res.id, actor, 'engineer_assigned', { engineer: name });
  const updated = await getReservation(res.id);
  await notify.engineerAssigned(updated, eng);
  return updated;
};

export const adminUpdateReservation = async (res, input, actor) => {
  const changes = {};
  for (const k of ['nom', 'email', 'telephone', 'message', 'internal_notes']) {
    if (input[k] !== undefined) changes[k] = String(input[k] ?? '').slice(0, k === 'message' || k === 'internal_notes' ? 4000 : 255);
  }
  if (input.telephone !== undefined) {
    const p = intlPhone(input.telephone);
    if (!p) throw badRequest('Téléphone invalide');
    changes.telephone = p;
  }
  if (input.montant_total !== undefined) {
    const total = Number(input.montant_total);
    if (!Number.isInteger(total) || total < 0) throw badRequest('Montant invalide');
    changes.montant_total = total;
    changes.payment_status = derivePaymentStatus(total, res.montant_paye);
  }
  if (input.nombre_titres !== undefined && res.booking_mode !== 'slot') {
    const n = Number(input.nombre_titres);
    if (!Number.isInteger(n) || n < 1) throw badRequest('Nombre de titres invalide');
    changes.nombre_titres = n;
  }
  const keys = Object.keys(changes);
  if (keys.length) {
    await q(`UPDATE reservations SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => changes[k]), res.id]);
    const logged = { ...changes };
    delete logged.internal_notes;
    await logHistory(res.id, actor, 'updated', { fields: keys, ...logged });
    if (changes.montant_total !== undefined) await rescaleUnpaid(res.id, changes.montant_total);
  }
  let current = await getReservation(res.id);

  // Changement de durée : on recalcule le créneau (même heure de début)
  if (input.hours !== undefined && current.booking_mode === 'slot' && Number(input.hours) !== current.duree_heures) {
    current = await changeDuration(current, Number(input.hours), actor);
  }
  if (input.start_at && current.start_at && normDateTime(input.start_at) !== current.start_at) {
    current = await rescheduleReservation(current, input.start_at, actor, { enforceClientRules: false });
  }
  if (input.engineer_id !== undefined && (input.engineer_id || null) !== (current.engineer_id || null)) {
    current = await assignEngineer(current, input.engineer_id ? Number(input.engineer_id) : null, actor);
  }
  if (input.statut && input.statut !== current.statut) {
    if (input.statut === 'annulee') current = await cancelReservation(current, actor, input.cancel_reason || '');
    else if (input.statut === 'terminee') current = await setSessionStatus(current, 'terminee', actor, { force: true });
    else if (input.statut === 'confirmee' && ['a_traiter', 'en_attente'].includes(current.statut)) {
      await tx(async (conn) => {
        if (current.start_at) {
          await releaseSlots(conn, current.id);
          await lockSlots(conn, current.id, current.start_at, current.end_at);
        }
        await conn.query("UPDATE reservations SET statut = 'confirmee', hold_expires_at = NULL WHERE id = ?", [current.id]);
        await logHistory(current.id, actor, 'status_changed', { status: 'confirmee' }, conn);
      });
      current = await getReservation(current.id);
    } else throw badRequest('Changement de statut non autorisé');
  }
  return current;
};

const changeDuration = async (res, hours, actor) => {
  if (!Number.isInteger(hours) || hours < 1 || hours > 16) throw badRequest('Durée invalide');
  await assertSlotAvailable(res.start_at, hours, { excludeReservationId: res.id, ignoreLeadTime: true, ignoreWindow: true });
  const end = addMinutes(res.start_at, hours * 60);
  await tx(async (conn) => {
    await releaseSlots(conn, res.id);
    await lockSlots(conn, res.id, res.start_at, end);
    await conn.query('UPDATE reservations SET end_at = ?, duree_heures = ?, creneaux = ? WHERE id = ?', [
      end, hours, JSON.stringify(rangeToLegacySlots(res.start_at, end)), res.id
    ]);
    await logHistory(res.id, actor, 'duration_changed', { from: res.duree_heures, to: hours }, conn);
  });
  return getReservation(res.id);
};

// ---------------------------------------------------------------------------
// Statut opérationnel (ingénieur / admin)
// ---------------------------------------------------------------------------
export const setSessionStatus = async (res, status, actor, { force = false } = {}) => {
  if (!['en_cours', 'terminee', 'absent'].includes(status)) throw badRequest('Statut invalide');
  if (res.statut !== 'confirmee' && !(force && res.statut === 'terminee')) throw badRequest('Cette réservation n’est pas active');
  if (status === 'en_cours' && res.session_status !== 'autorisee') {
    throw forbidden('La session ne peut pas commencer : le paiement n’a pas encore été confirmé.');
  }
  if (status === 'terminee' && !force && !['en_cours', 'autorisee'].includes(res.session_status)) {
    throw badRequest('La session doit d’abord être autorisée et démarrée');
  }
  if (status === 'absent' && res.start_at && res.start_at > nowSql()) throw badRequest('La session n’a pas encore commencé');
  await q(
    `UPDATE reservations SET session_status = ?, statut = IF(? = 'terminee', 'terminee', statut),
       completed_at = IF(? = 'terminee', UTC_TIMESTAMP(), completed_at) WHERE id = ?`,
    [status, status, status, res.id]
  );
  await logHistory(res.id, actor, 'session_status', { status });
  const updated = await getReservation(res.id);
  await notify.sessionStatusChanged(updated, status, actor);
  return updated;
};

// ---------------------------------------------------------------------------
// Confirmation de présence (rappel 2 h avant)
// ---------------------------------------------------------------------------
export const recordPresence = async (res, answer, via = 'web') => {
  if (res.statut !== 'confirmee') throw badRequest('Cette réservation n’est plus active');
  const status = answer === 'confirm' ? 'confirmee' : answer === 'reschedule' ? 'report_souhaite' : null;
  if (!status) throw badRequest('Réponse invalide');
  if (res.presence_status === status) return res;
  await q('UPDATE reservations SET presence_status = ?, presence_answered_at = UTC_TIMESTAMP() WHERE id = ?', [status, res.id]);
  await logHistory(res.id, null, status === 'confirmee' ? 'presence_confirmed' : 'reschedule_requested', { via });
  const updated = await getReservation(res.id);
  await notify.presenceAnswered(updated, status);
  return updated;
};

export const assertOwner = (res, user) => {
  if (!res || res.user_id !== user.id) throw notFound('Réservation introuvable');
  return res;
};

export const assertAssigned = (res, user) => {
  if (!res || res.engineer_id !== user.id) throw notFound('Session introuvable');
  return res;
};
