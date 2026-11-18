import { pool } from '../config/db.js';

// Actions dont le détail contient des informations financières (masquées aux ingénieurs)
export const FINANCIAL_ACTIONS = new Set([
  'payment_initial', 'payment_balance', 'cash_requested', 'cash_validated', 'payment_link_sent', 'payment_conflict'
]);

export const logHistory = async (reservationId, actor, action, details = {}, conn = pool) => {
  await conn.query(
    'INSERT INTO reservation_history (reservation_id, actor_id, actor_role, action, details) VALUES (?, ?, ?, ?, ?)',
    [reservationId, actor?.id || null, actor?.role || 'system', action, JSON.stringify(details || {})]
  );
};

export const getHistory = async (reservationId, { financial = true } = {}) => {
  const [rows] = await pool.query(
    `SELECT h.id, h.action, h.actor_role, h.details, h.created_at,
            TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS actor_name
     FROM reservation_history h LEFT JOIN users u ON u.id = h.actor_id
     WHERE h.reservation_id = ? ORDER BY h.created_at DESC, h.id DESC`,
    [reservationId]
  );
  return rows
    .filter((r) => financial || !FINANCIAL_ACTIONS.has(r.action))
    .map((r) => {
      let details = {};
      try { details = JSON.parse(r.details || '{}'); } catch { details = {}; }
      if (!financial) {
        // Ne conserver que les informations opérationnelles
        const { from, to, status, reason, engineer } = details;
        details = Object.fromEntries(Object.entries({ from, to, status, reason, engineer }).filter(([, v]) => v !== undefined));
      }
      return { ...r, details };
    });
};
