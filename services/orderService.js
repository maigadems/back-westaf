// Commandes payées par étapes (mixage, mastering…) :
//   1. acompte à la commande → 2. premiers livrables → 3. livraison finale (solde).
// Jeuss fixe les pourcentages par service ; ils sont copiés sur chaque commande et restent
// ajustables commande par commande tant que l'étape n'a pas été demandée.
import { q, one, tx } from '../config/db.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { logHistory } from './historyService.js';
import { getReservation } from './reservationService.js';
import { issueAfterPayment } from './invoiceService.js';
import * as notify from './notifier.js';

export const MILESTONE_LABELS = {
  acompte: 'Acompte à la commande',
  premiers_livrables: 'Premiers livrables',
  livraison_finale: 'Livraison finale'
};

/** Échéancier d'un service : [{ kind, label, percent }] (la dernière étape reçoit le reste). */
export const planFromService = (service) => {
  const deposit = Math.min(100, Math.max(0, Number(service.allow_deposit ? service.deposit_percent : 100) || 100));
  const middle = Math.min(100 - deposit, Math.max(0, Number(service.milestone_percent) || 0));
  const rest = 100 - deposit - middle;
  const plan = [{ kind: 'acompte', percent: deposit }];
  if (middle > 0) plan.push({ kind: 'premiers_livrables', percent: middle });
  if (rest > 0) plan.push({ kind: 'livraison_finale', percent: rest });
  return plan.map((p) => ({ ...p, label: MILESTONE_LABELS[p.kind] }));
};

// Montants entiers : la dernière étape absorbe les arrondis pour que la somme soit exacte
const amountsFor = (total, percents) => {
  const out = percents.map((p) => Math.round((total * p) / 100));
  out[out.length - 1] = total - out.slice(0, -1).reduce((s, a) => s + a, 0);
  return out;
};

export const insertMilestones = async (conn, reservationId, total, plan, { firstStatus = 'a_venir' } = {}) => {
  const amounts = amountsFor(total, plan.map((p) => p.percent));
  for (const [i, p] of plan.entries()) {
    await conn.query(
      'INSERT INTO order_milestones (reservation_id, position, kind, label, percent, amount, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [reservationId, i + 1, p.kind, p.label, p.percent, amounts[i], i === 0 ? firstStatus : 'a_venir', i === 0 && firstStatus === 'demande' ? new Date() : null]
    );
  }
  return amounts[0];
};

export const getMilestones = (reservationId) =>
  q('SELECT id, position, kind, label, percent, amount, status, deliverable_note, requested_at, paid_at FROM order_milestones WHERE reservation_id = ? ORDER BY position', [reservationId]);

const PENDING = ['demande', 'en_attente_validation'];

/** Informations de commande jointes à une réservation (null pour une réservation de créneau). */
export const orderInfo = async (r) => {
  if (!r || r.booking_mode === 'slot') return null;
  const milestones = await getMilestones(r.id);
  const current = milestones.find((m) => PENDING.includes(m.status)) || null;
  const next = milestones.find((m) => m.status === 'a_venir') || null;
  return { production_status: r.production_status || null, milestones, current_id: current?.id ?? null, next_id: next?.id ?? null };
};

const loadMilestone = async (res, milestoneId) => {
  const m = await one('SELECT * FROM order_milestones WHERE id = ? AND reservation_id = ?', [Number(milestoneId), res.id]);
  if (!m) throw notFound('Étape introuvable');
  return m;
};

// Étape actuellement à régler par le client (demandée par Jeuss)
export const currentDueMilestone = async (res) =>
  one("SELECT * FROM order_milestones WHERE reservation_id = ? AND status IN ('demande','en_attente_validation') ORDER BY position LIMIT 1", [res.id]);

// ---------------------------------------------------------------------------
// Paiement de l'acompte à la commande (via l'IPN du paiement initial)
// ---------------------------------------------------------------------------
export const markDepositPaid = async (conn, reservationId) => {
  await conn.query("UPDATE order_milestones SET status = 'paye', paid_at = UTC_TIMESTAMP() WHERE reservation_id = ? AND position = 1 AND status <> 'paye'", [reservationId]);
  // Le paiement initial correspond à l'étape « Acompte » (libellé sur la facture)
  await conn.query(
    `UPDATE payments p JOIN order_milestones m ON m.reservation_id = p.reservation_id AND m.position = 1
     SET p.milestone_id = m.id WHERE p.reservation_id = ? AND p.kind = 'initial' AND p.milestone_id IS NULL`,
    [reservationId]
  );
  await conn.query(
    "UPDATE reservations SET production_status = 'en_cours' WHERE id = ? AND (production_status IS NULL OR production_status = 'en_attente') AND EXISTS (SELECT 1 FROM order_milestones m WHERE m.reservation_id = ?)",
    [reservationId, reservationId]
  );
};

// ---------------------------------------------------------------------------
// Jeuss demande le paiement d'une étape (premiers livrables, livraison finale)
// ---------------------------------------------------------------------------
export const requestMilestone = async (res, milestoneId, { note = '' } = {}, actor) => {
  if (!['confirmee', 'terminee'].includes(res.statut)) throw badRequest('Cette commande n’est pas active');
  const m = await loadMilestone(res, milestoneId);
  if (m.status === 'paye') throw badRequest('Cette étape est déjà réglée');
  const previous = await one("SELECT COUNT(*) AS n FROM order_milestones WHERE reservation_id = ? AND position < ? AND status <> 'paye'", [res.id, m.position]);
  if (Number(previous.n) > 0) throw badRequest('Les étapes précédentes doivent d’abord être réglées');
  const resend = m.status !== 'a_venir';
  await q(
    `UPDATE order_milestones SET status = IF(status = 'a_venir', 'demande', status), deliverable_note = ?, requested_at = COALESCE(requested_at, UTC_TIMESTAMP()) WHERE id = ?`,
    [String(note || m.deliverable_note || '').slice(0, 2000) || null, m.id]
  );
  const production = m.kind === 'livraison_finale' ? 'livree' : m.kind === 'premiers_livrables' ? 'premiers_livrables' : res.production_status;
  if (production) await q('UPDATE reservations SET production_status = ? WHERE id = ?', [production, res.id]);
  await logHistory(res.id, actor, resend ? 'milestone_reminded' : 'milestone_requested', { step: m.label, amount: m.amount, note: note || undefined });
  const updated = await getReservation(res.id);
  await notify.milestoneRequested(updated, { ...m, deliverable_note: note || m.deliverable_note }, resend);
  return updated;
};

// ---------------------------------------------------------------------------
// Règlement d'une étape
// ---------------------------------------------------------------------------
const derive = (total, paid) => (paid >= total && total > 0 ? 'paye' : paid > 0 ? 'acompte' : 'non_paye');

const settle = async (conn, res, m, amount, method, actor) => {
  await conn.query("UPDATE order_milestones SET status = 'paye', paid_at = UTC_TIMESTAMP() WHERE id = ?", [m.id]);
  const [[r]] = await conn.query('SELECT montant_total, montant_paye FROM reservations WHERE id = ? FOR UPDATE', [res.id]);
  const paid = Number(r.montant_paye) + Number(amount);
  const [[left]] = await conn.query("SELECT COUNT(*) AS n FROM order_milestones WHERE reservation_id = ? AND status <> 'paye'", [res.id]);
  const finished = Number(left.n) === 0;
  await conn.query(
    `UPDATE reservations SET montant_paye = ?, payment_status = ?,
       production_status = IF(?, 'livree', production_status),
       statut = IF(?, 'terminee', statut), completed_at = IF(?, UTC_TIMESTAMP(), completed_at) WHERE id = ?`,
    [paid, finished ? 'paye' : derive(Number(r.montant_total), paid), finished, finished, finished, res.id]
  );
  await logHistory(res.id, actor, 'milestone_paid', { step: m.label, amount, method }, conn);
  return finished;
};

const afterSettle = async (reservationId, m, amount, method, finished) => {
  await issueAfterPayment(reservationId);
  await notify.milestonePaid(await getReservation(reservationId), m, amount, method, finished);
};

// Paiement en ligne confirmé par PayTech (IPN)
export const confirmMilestonePayment = async (payment) => {
  const res = await getReservation(payment.reservation_id);
  if (!res) return false;
  const m = await one('SELECT * FROM order_milestones WHERE id = ?', [payment.milestone_id]);
  if (!m || m.status === 'paye') return false;
  const finished = await tx(async (conn) => {
    const f = await settle(conn, res, m, payment.amount, 'online', null);
    await conn.query("UPDATE payments SET status = 'canceled' WHERE milestone_id = ? AND method = 'cash' AND status = 'awaiting_validation'", [m.id]);
    return f;
  });
  await afterSettle(res.id, m, payment.amount, 'online', finished);
  return true;
};

// Le client choisit de régler l'étape en espèces → Jeuss valide la réception
export const requestMilestoneCash = async (res, via = 'web') => {
  const m = await currentDueMilestone(res);
  if (!m) throw badRequest('Aucun paiement n’est demandé pour le moment');
  if (m.status === 'en_attente_validation') return getReservation(res.id);
  await tx(async (conn) => {
    await conn.query(
      "INSERT INTO payments (reservation_id, ref_command, kind, milestone_id, method, amount, status) VALUES (?, ?, 'milestone', ?, 'cash', ?, 'awaiting_validation')",
      [res.id, `CASH_${res.id.slice(0, 8)}_${Date.now()}`, m.id, m.amount]
    );
    await conn.query("UPDATE order_milestones SET status = 'en_attente_validation' WHERE id = ?", [m.id]);
    await conn.query("UPDATE reservations SET payment_status = 'en_attente_validation' WHERE id = ?", [res.id]);
    await logHistory(res.id, null, 'cash_requested', { step: m.label, amount: m.amount, via }, conn);
  });
  const updated = await getReservation(res.id);
  await notify.milestoneCashRequested(updated, m);
  return updated;
};

// Jeuss confirme avoir reçu des espèces pour une étape (demandée ou non)
export const validateMilestoneCash = async (res, milestoneId, actor) => {
  const m = await loadMilestone(res, milestoneId);
  if (m.status === 'paye') throw badRequest('Cette étape est déjà réglée');
  if (['annulee', 'expiree'].includes(res.statut)) throw badRequest('Commande annulée');
  const finished = await tx(async (conn) => {
    const [[p]] = await conn.query(
      "SELECT id FROM payments WHERE milestone_id = ? AND method = 'cash' AND status = 'awaiting_validation' ORDER BY id DESC LIMIT 1 FOR UPDATE", [m.id]
    );
    if (p) {
      await conn.query("UPDATE payments SET status = 'completed', amount = ?, validated_by = ?, completed_at = UTC_TIMESTAMP() WHERE id = ?", [m.amount, actor.id, p.id]);
    } else {
      await conn.query(
        `INSERT INTO payments (reservation_id, ref_command, kind, milestone_id, method, amount, status, validated_by, completed_at)
         VALUES (?, ?, 'milestone', ?, 'cash', ?, 'completed', ?, UTC_TIMESTAMP())`,
        [res.id, `CASH_${res.id.slice(0, 8)}_${Date.now()}`, m.id, m.amount, actor.id]
      );
    }
    // Statut « en attente de validation » levé s'il ne reste pas d'autre demande en espèces
    await conn.query("UPDATE reservations SET payment_status = IF(payment_status = 'en_attente_validation', 'acompte', payment_status) WHERE id = ?", [res.id]);
    return settle(conn, res, m, m.amount, 'cash', actor);
  });
  await afterSettle(res.id, m, m.amount, 'cash', finished);
  return getReservation(res.id);
};

// ---------------------------------------------------------------------------
// Ajustement de l'échéancier d'une commande par Jeuss
// ---------------------------------------------------------------------------
/** percents : { [milestoneId]: percent } pour les étapes non encore demandées ; la dernière prend le reste. */
export const updatePlan = async (res, percents, actor) => {
  const ms = await getMilestones(res.id);
  if (ms.length < 2) throw badRequest('Cette commande n’a qu’une étape de paiement');
  const editable = ms.filter((m) => m.status === 'a_venir');
  if (!editable.length) throw conflict('Toutes les étapes ont déjà été demandées ou réglées');
  const last = ms[ms.length - 1];
  if (last.status !== 'a_venir') throw conflict('La livraison finale a déjà été demandée');
  const locked = ms.filter((m) => m.status !== 'a_venir');
  const lockedAmount = locked.reduce((s, m) => s + m.amount, 0);
  const total = Number(res.montant_total);

  const newPercents = {};
  for (const m of editable) {
    if (m.id === last.id) continue;
    const p = percents?.[m.id] ?? percents?.[String(m.id)];
    const v = p === undefined ? m.percent : Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 100) throw badRequest('Pourcentage invalide');
    newPercents[m.id] = v;
  }
  const lockedPercent = locked.reduce((s, m) => s + m.percent, 0);
  const used = lockedPercent + Object.values(newPercents).reduce((s, v) => s + v, 0);
  if (used >= 100) throw badRequest('La livraison finale doit garder un pourcentage supérieur à 0');

  let assigned = lockedAmount;
  await tx(async (conn) => {
    for (const m of editable) {
      if (m.id === last.id) continue;
      const amount = Math.round((total * newPercents[m.id]) / 100);
      assigned += amount;
      await conn.query('UPDATE order_milestones SET percent = ?, amount = ? WHERE id = ?', [newPercents[m.id], amount, m.id]);
    }
    await conn.query('UPDATE order_milestones SET percent = ?, amount = ? WHERE id = ?', [100 - used, total - assigned, last.id]);
    await logHistory(res.id, actor, 'plan_updated', { plan: Object.values(newPercents).concat(100 - used).join(' / ') }, conn);
  });
  return getReservation(res.id);
};

// Recalcul des montants restants après une modification du total par Jeuss
export const rescaleUnpaid = async (reservationId, total) => {
  const ms = await getMilestones(reservationId);
  if (!ms.length) return;
  const fixed = ms.filter((m) => m.status !== 'a_venir');
  const open = ms.filter((m) => m.status === 'a_venir');
  if (!open.length) return;
  let assigned = fixed.reduce((s, m) => s + m.amount, 0);
  for (const [i, m] of open.entries()) {
    const amount = i === open.length - 1 ? total - assigned : Math.round((total * m.percent) / 100);
    assigned += amount;
    await q('UPDATE order_milestones SET amount = ? WHERE id = ?', [Math.max(0, amount), m.id]);
  }
};

// Liste des commandes pour l'administration
export const listOrders = async ({ status, search } = {}) => {
  const where = ["s.booking_mode = 'per_track'", "r.statut NOT IN ('en_attente','expiree')"];
  const params = [];
  if (status === 'en_cours') where.push("r.statut = 'confirmee'");
  if (status === 'a_regler') where.push("EXISTS (SELECT 1 FROM order_milestones m WHERE m.reservation_id = r.id AND m.status IN ('demande','en_attente_validation'))");
  if (status === 'terminees') where.push("r.statut = 'terminee'");
  if (status === 'annulees') where.push("r.statut = 'annulee'");
  if (search) { where.push('(r.nom LIKE ? OR r.email LIKE ? OR r.telephone LIKE ?)'); const s = `%${search}%`; params.push(s, s, s); }
  const rows = await q(
    `SELECT r.id FROM reservations r JOIN services s ON s.id = r.service_id WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT 500`,
    params
  );
  const out = [];
  for (const { id } of rows) {
    const r = await getReservation(id);
    out.push({ ...r, order: await orderInfo(r) });
  }
  return out;
};
