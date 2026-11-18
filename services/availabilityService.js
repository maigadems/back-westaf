// Moteur de disponibilités : horaires du studio, pauses, fermetures, réservations
// existantes (slot_locks), absences des ingénieurs, délai minimum et fenêtre de réservation.
// Granularité : l'heure (le studio se réserve à l'heure).
import { q } from '../config/db.js';
import { addDays, addMinutes, fromSql, hm, hoursBetween, isValidDate, minutesToHm, nowSql, todayStr, weekday } from '../lib/time.js';
import { getInt, getSetting } from './settingsService.js';
import { badRequest } from '../lib/http.js';

export const getOpeningHours = async () => {
  const rows = await q('SELECT * FROM opening_hours ORDER BY weekday');
  const map = {};
  for (const r of rows) map[r.weekday] = { ...r, is_open: !!r.is_open };
  return map;
};

const HOUR_RE = /^([01]\d|2[0-4]):00$/;

export const saveOpeningHours = async (days) => {
  if (!Array.isArray(days)) throw badRequest('Format invalide');
  for (const d of days) {
    const wd = Number(d.weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw badRequest('Jour invalide');
    const open = String(d.open_time || '08:00');
    const close = String(d.close_time || '24:00');
    if (!HOUR_RE.test(open) || !HOUR_RE.test(close) || hm(open) >= hm(close)) throw badRequest('Horaires invalides (heures pleines, ouverture avant fermeture)');
    let bs = d.break_start || null;
    let be = d.break_end || null;
    if (bs || be) {
      if (!HOUR_RE.test(bs || '') || !HOUR_RE.test(be || '') || hm(bs) >= hm(be) || hm(bs) < hm(open) || hm(be) > hm(close)) {
        throw badRequest('Pause invalide (doit être comprise dans les horaires d’ouverture)');
      }
    } else { bs = null; be = null; }
    await q(
      `INSERT INTO opening_hours (weekday, is_open, open_time, close_time, break_start, break_end) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE is_open = VALUES(is_open), open_time = VALUES(open_time), close_time = VALUES(close_time),
         break_start = VALUES(break_start), break_end = VALUES(break_end)`,
      [wd, d.is_open ? 1 : 0, open, close, bs, be]
    );
  }
  return getOpeningHours();
};

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/**
 * Charge les contraintes d'une plage de dates [from, to] (inclus).
 */
const loadConstraints = async (from, to) => {
  const start = `${from} 00:00:00`;
  const end = `${addDays(to, 1)} 23:59:59`; // +1 jour : une session peut finir après minuit
  const [hours, closures, locks, settingRespect, engineers, unavail] = await Promise.all([
    getOpeningHours(),
    q('SELECT start_at, end_at FROM closures WHERE start_at < ? AND end_at > ?', [end, start]),
    q('SELECT slot_start, reservation_id FROM slot_locks WHERE slot_start >= ? AND slot_start <= ?', [start, end]),
    getSetting('respect_engineer_unavailability', '1'),
    q("SELECT id FROM users WHERE role = 'engineer' AND is_active = 1"),
    q('SELECT user_id, start_at, end_at FROM engineer_unavailability WHERE start_at < ? AND end_at > ?', [end, start])
  ]);
  return { hours, closures, locks, respectEngineers: settingRespect === '1', engineers: engineers.map((e) => e.id), unavail };
};

// Une heure donnée (début "YYYY-MM-DD HH:00:00") est-elle ouverte ?
const hourIsOpen = (c, hourStart) => {
  const date = hourStart.slice(0, 10);
  const day = c.hours[weekday(date)];
  if (!day || !day.is_open) return false;
  const m = Number(hourStart.slice(11, 13)) * 60;
  if (m < hm(day.open_time) || m + 60 > hm(day.close_time)) return false;
  if (day.break_start && day.break_end && overlaps(m, m + 60, hm(day.break_start), hm(day.break_end))) return false;
  const hEnd = addMinutes(hourStart, 60);
  if (c.closures.some((cl) => overlaps(hourStart, hEnd, cl.start_at, cl.end_at))) return false;
  return true;
};

const hourIsFree = (c, hourStart, excludeReservationId) =>
  !c.locks.some((l) => l.slot_start === hourStart && l.reservation_id !== excludeReservationId);

// S'il existe des ingénieurs actifs et que l'option est activée, au moins un doit être disponible
const engineersAvailable = (c, start, end) => {
  if (!c.respectEngineers || !c.engineers.length) return true;
  return c.engineers.some((id) => !c.unavail.some((u) => u.user_id === id && overlaps(start, end, u.start_at, u.end_at)));
};

/**
 * Créneaux de début possibles pour une date et une durée (heures).
 * Retourne [{ start, end, label, available, reason }]
 */
export const getDaySlots = async (date, hours, { excludeReservationId = null, ignoreLeadTime = false, ignoreWindow = false, constraints = null } = {}) => {
  if (!isValidDate(date)) throw badRequest('Date invalide');
  const duration = Number(hours) || 1;
  const c = constraints || (await loadConstraints(date, date));
  const day = c.hours[weekday(date)];
  if (!day || !day.is_open) return [];

  const leadMinutes = await getInt('min_lead_minutes', 20);
  const windowDays = await getInt('booking_window_days', 30);
  const earliest = ignoreLeadTime ? nowSql() : addMinutes(new Date(), leadMinutes);
  const latestDate = addDays(todayStr(), windowDays);
  if (!ignoreWindow && (date > latestDate || date < todayStr())) return [];

  const slots = [];
  const openM = hm(day.open_time);
  const closeM = hm(day.close_time);
  for (let m = openM; m + duration * 60 <= closeM; m += 60) {
    const start = `${date} ${minutesToHm(m)}:00`;
    const end = addMinutes(start, duration * 60);
    const covered = hoursBetween(start, end);
    let reason = null;
    if (start < earliest) reason = 'passe';
    else if (!covered.every((h) => hourIsOpen(c, h))) reason = 'ferme';
    else if (!covered.every((h) => hourIsFree(c, h, excludeReservationId))) reason = 'reserve';
    else if (!engineersAvailable(c, start, end)) reason = 'indisponible';
    // Les heures passées ou fermées (pause, fermeture) ne sont pas proposées
    if (reason === 'passe' || reason === 'ferme') continue;
    slots.push({
      start,
      end,
      label: `${minutesToHm(m)} – ${minutesToHm(m + duration * 60).replace(/^24:/, '00:')}`,
      available: !reason,
      reason
    });
  }
  return slots;
};

// Résumé sur plusieurs jours : nombre de créneaux libres par date
export const getDaysSummary = async (from, days, hours, opts = {}) => {
  const start = isValidDate(from) ? from : todayStr();
  const count = Math.min(Math.max(Number(days) || 14, 1), 62);
  const to = addDays(start, count - 1);
  const constraints = await loadConstraints(start, to);
  const out = [];
  for (let i = 0; i < count; i++) {
    const date = addDays(start, i);
    const slots = await getDaySlots(date, hours, { ...opts, constraints });
    const day = constraints.hours[weekday(date)];
    out.push({ date, open: !!day?.is_open, available: slots.filter((s) => s.available).length });
  }
  return out;
};

// Vérifie qu'un créneau précis est réservable (avant verrouillage en base)
export const assertSlotAvailable = async (start, hours, opts = {}) => {
  const date = start.slice(0, 10);
  const slots = await getDaySlots(date, hours, opts);
  const slot = slots.find((s) => s.start === start);
  if (!slot || !slot.available) {
    const why = { reserve: 'Ce créneau vient d’être réservé', indisponible: 'Aucun ingénieur disponible sur ce créneau', ferme: 'Le studio est fermé sur ce créneau' };
    throw badRequest(slot?.reason ? why[slot.reason] || 'Créneau indisponible' : 'Créneau indisponible', { code: 'SLOT_UNAVAILABLE' });
  }
  return slot;
};

// Ingénieur libre sur [start, end) : ni absence, ni autre session attribuée
export const engineerIsFree = async (engineerId, start, end, excludeReservationId = null) => {
  const absences = await q('SELECT id FROM engineer_unavailability WHERE user_id = ? AND start_at < ? AND end_at > ?', [engineerId, end, start]);
  if (absences.length) return { free: false, reason: 'absent' };
  const busy = await q(
    `SELECT id FROM reservations WHERE engineer_id = ? AND statut IN ('confirmee','en_attente') AND start_at < ? AND end_at > ? AND id <> ?`,
    [engineerId, end, start, excludeReservationId || '']
  );
  if (busy.length) return { free: false, reason: 'occupe' };
  return { free: true };
};

export const toDate = (sql) => fromSql(sql);
