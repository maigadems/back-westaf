// Tâches planifiées (toutes les minutes) :
//  - libération des créneaux non payés,
//  - rappel WhatsApp de confirmation de présence (2 h avant par défaut),
//  - lien de paiement du solde (10 min avant par défaut).
// Un verrou MySQL garantit qu'une seule instance exécute les tâches à la fois,
// et les clés de déduplication empêchent tout double envoi.
import { pool, q } from '../config/db.js';
import { config } from '../config/env.js';
import { getInt } from './settingsService.js';
import { expireHolds, getReservation } from './reservationService.js';
import { logHistory } from './historyService.js';
import * as notify from './notifier.js';

let running = false;

export const runReminders = async () => {
  const before = await getInt('reminder_minutes_before', 120);
  const rows = await q(
    `SELECT id, created_at, start_at FROM reservations
     WHERE statut = 'confirmee' AND start_at IS NOT NULL AND reminder_sent_at IS NULL
       AND session_status IN ('planifiee','autorisee')
       AND start_at > UTC_TIMESTAMP() AND start_at <= UTC_TIMESTAMP() + INTERVAL ? MINUTE`,
    [before]
  );
  let sent = 0;
  for (const row of rows) {
    // Marque d'abord (une seule tentative par créneau), puis envoie
    const [u] = await pool.query('UPDATE reservations SET reminder_sent_at = UTC_TIMESTAMP() WHERE id = ? AND reminder_sent_at IS NULL', [row.id]);
    if (!u.affectedRows) continue;
    const r = await getReservation(row.id);
    // Réservation faite après l'heure du rappel : le client vient de réserver, pas de demande de confirmation
    const createdAt = String(r.created_at).replace('T', ' ').slice(0, 19);
    const reminderAt = new Date(new Date(`${r.start_at.replace(' ', 'T')}Z`).getTime() - before * 60000).toISOString().replace('T', ' ').slice(0, 19);
    if (createdAt > reminderAt) {
      await logHistory(r.id, null, 'reminder_skipped', { reason: 'Réservation effectuée moins de 2 h avant la session' });
      continue;
    }
    const result = await notify.sendReminder(r);
    if (result?.ok && !result.skipped) {
      await q("UPDATE reservations SET presence_status = 'demandee' WHERE id = ? AND presence_status = 'non_demandee'", [r.id]);
      await logHistory(r.id, null, 'reminder_sent', {});
      sent++;
    } else if (!result?.skipped) {
      await logHistory(r.id, null, 'reminder_failed', { status: result?.status });
      await notify.scheduledFailure(r, 'Rappel WhatsApp', result);
    }
  }
  return sent;
};

export const runPaymentLinks = async () => {
  const before = await getInt('payment_link_minutes_before', 10);
  const rows = await q(
    `SELECT id FROM reservations
     WHERE statut = 'confirmee' AND start_at IS NOT NULL AND payment_link_sent_at IS NULL
       AND session_status IN ('planifiee','autorisee')
       AND start_at <= UTC_TIMESTAMP() + INTERVAL ? MINUTE AND start_at > UTC_TIMESTAMP() - INTERVAL 60 MINUTE`,
    [before]
  );
  let sent = 0;
  for (const row of rows) {
    const [u] = await pool.query('UPDATE reservations SET payment_link_sent_at = UTC_TIMESTAMP() WHERE id = ? AND payment_link_sent_at IS NULL', [row.id]);
    if (!u.affectedRows) continue;
    const r = await getReservation(row.id);
    if (r.payment_status === 'paye' || r.solde <= 0) {
      // Déjà entièrement réglée : session autorisée sans lien de paiement
      if (r.session_status === 'planifiee') await q("UPDATE reservations SET session_status = 'autorisee', payment_status = 'paye' WHERE id = ?", [r.id]);
      continue;
    }
    if (r.payment_status === 'en_attente_validation') continue; // espèces déjà demandées
    const result = await notify.sendPaymentLink(r);
    if (result?.ok && !result.skipped) {
      await logHistory(r.id, null, 'payment_link_sent', { amount: r.solde });
      sent++;
    } else if (!result?.skipped) {
      await logHistory(r.id, null, 'payment_link_failed', { status: result?.status });
      await notify.scheduledFailure(r, 'Lien de paiement WhatsApp', result);
    }
  }
  return sent;
};

export const tick = async () => {
  if (running) return { skipped: true };
  running = true;
  const conn = await pool.getConnection();
  try {
    const [[lock]] = await conn.query("SELECT GET_LOCK('westaf_scheduler', 0) AS ok");
    if (!lock.ok) return { skipped: true };
    try {
      const expired = await expireHolds();
      const reminders = await runReminders();
      const links = await runPaymentLinks();
      await q('DELETE FROM password_resets WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 7 DAY');
      return { expired, reminders, links };
    } finally {
      await conn.query("SELECT RELEASE_LOCK('westaf_scheduler')");
    }
  } catch (e) {
    console.error('❌ Planificateur:', e.message);
    return { error: e.message };
  } finally {
    conn.release();
    running = false;
  }
};

export const startScheduler = () => {
  if (!config.schedulerEnabled) {
    console.log('⏸️  Planificateur désactivé (SCHEDULER_ENABLED=false) : appelez POST /cron/tick depuis une tâche cron');
    return;
  }
  setInterval(tick, 60000).unref();
  setTimeout(tick, 5000).unref();
  console.log('⏱️  Planificateur démarré (rappels, liens de paiement, expirations)');
};
