// Indicateurs du tableau de bord, calculés uniquement à partir des données réelles.
import { q, one } from '../config/db.js';
import { COMPLETED_SQL, REAL_SQL } from './reservationService.js';

export const dashboardStats = async ({ finance = false } = {}) => {
  const counts = await one(
    `SELECT
       COUNT(*) AS total,
       SUM(DATE(COALESCE(r.start_at, r.date_reservation)) = UTC_DATE() AND r.statut IN ('confirmee','terminee')) AS today,
       SUM(r.statut = 'confirmee' AND (r.start_at IS NULL OR r.start_at >= UTC_TIMESTAMP())) AS upcoming,
       SUM(${COMPLETED_SQL}) AS completed,
       SUM(r.statut = 'annulee') AS cancelled,
       SUM(r.reschedule_count > 0) AS rescheduled,
       SUM(r.statut = 'a_traiter') AS to_handle
     FROM reservations r WHERE ${REAL_SQL}`
  );
  const [clients, services, engineers] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM users WHERE role = 'client'"),
    one('SELECT COUNT(*) AS n FROM services WHERE is_active = 1'),
    one("SELECT COUNT(*) AS n FROM users WHERE role = 'engineer' AND is_active = 1")
  ]);
  const todaySessions = await q(
    `SELECT r.id, r.nom, r.start_at, r.end_at, r.session_status, r.presence_status, ${finance ? 'r.payment_status,' : ''}
            COALESCE(s.name, r.type_service) AS service_name,
            TRIM(CONCAT(COALESCE(e.first_name,''),' ',COALESCE(e.last_name,''))) AS engineer_name
     FROM reservations r LEFT JOIN services s ON s.id = r.service_id LEFT JOIN users e ON e.id = r.engineer_id
     WHERE r.statut IN ('confirmee','terminee') AND DATE(r.start_at) = UTC_DATE() ORDER BY r.start_at`
  );
  const next7 = await q(
    `SELECT DATE(r.start_at) AS day, COUNT(*) AS n, COALESCE(SUM(TIMESTAMPDIFF(HOUR, r.start_at, r.end_at)), 0) AS hours
     FROM reservations r WHERE r.statut = 'confirmee' AND r.start_at >= UTC_DATE() AND r.start_at < UTC_DATE() + INTERVAL 7 DAY
     GROUP BY DATE(r.start_at) ORDER BY day`
  );
  const out = {
    reservations: {
      total: Number(counts.total || 0),
      today: Number(counts.today || 0),
      upcoming: Number(counts.upcoming || 0),
      completed: Number(counts.completed || 0),
      cancelled: Number(counts.cancelled || 0),
      rescheduled: Number(counts.rescheduled || 0),
      toHandle: Number(counts.to_handle || 0)
    },
    clients: Number(clients.n),
    activeServices: Number(services.n),
    activeEngineers: Number(engineers.n),
    todaySessions,
    next7Days: next7.map((d) => ({ day: d.day, count: Number(d.n), hours: Number(d.hours) }))
  };

  if (finance) {
    const f = await one(
      `SELECT
         COALESCE(SUM(p.amount), 0) AS collected,
         COALESCE(SUM(CASE WHEN p.completed_at >= DATE_FORMAT(UTC_DATE(), '%Y-%m-01') THEN p.amount END), 0) AS collected_month,
         COALESCE(SUM(CASE WHEN p.method = 'cash' THEN p.amount END), 0) AS cash_collected
       FROM payments p WHERE p.status = 'completed'`
    );
    const due = await one(
      `SELECT COALESCE(SUM(r.montant_total - r.montant_paye), 0) AS due FROM reservations r
       WHERE r.statut IN ('confirmee','a_traiter') AND r.montant_total > r.montant_paye`
    );
    const pendingCash = await one("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM payments WHERE method = 'cash' AND status = 'awaiting_validation'");
    const monthly = await q(
      `SELECT DATE_FORMAT(p.completed_at, '%Y-%m') AS month, SUM(p.amount) AS amount, COUNT(*) AS n
       FROM payments p WHERE p.status = 'completed' AND p.completed_at >= DATE_FORMAT(UTC_DATE() - INTERVAL 5 MONTH, '%Y-%m-01')
       GROUP BY month ORDER BY month`
    );
    const byService = await q(
      `SELECT COALESCE(s.name, r.type_service) AS service, COUNT(DISTINCT r.id) AS n, COALESCE(SUM(p.amount), 0) AS amount
       FROM payments p JOIN reservations r ON r.id = p.reservation_id LEFT JOIN services s ON s.id = r.service_id
       WHERE p.status = 'completed' GROUP BY service ORDER BY amount DESC`
    );
    out.finance = {
      collected: Number(f.collected),
      collectedMonth: Number(f.collected_month),
      cashCollected: Number(f.cash_collected),
      outstanding: Number(due.due),
      pendingCash: { count: Number(pendingCash.n), amount: Number(pendingCash.amount) },
      monthly: monthly.map((m) => ({ month: m.month, amount: Number(m.amount), count: Number(m.n) })),
      byService: byService.map((s) => ({ service: s.service, count: Number(s.n), amount: Number(s.amount) }))
    };
  }
  return out;
};
