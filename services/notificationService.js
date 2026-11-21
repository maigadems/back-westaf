import { q, one } from '../config/db.js';
import { pushToStaff, pushToUser } from './pushService.js';

// Envoi push en arrière-plan : n'interrompt jamais l'opération en cours
const background = (promise) => { promise.catch((e) => console.error('❌ Push :', e.message)); };

// Notification pour l'équipe d'administration (Jeuss + super admin) : user_id NULL
export const notifyStaff = async ({ type, title, body = '', reservationId = null, financial = false }) => {
  await q('INSERT INTO notifications (user_id, type, title, body, reservation_id, is_financial) VALUES (NULL, ?, ?, ?, ?, ?)', [
    type, title, body, reservationId, financial ? 1 : 0
  ]);
  background(pushToStaff({ title, body: String(body).slice(0, 240), tag: type, url: reservationId ? '/admin/reservations?id=' + reservationId : '/admin/dashboard' }));
};

export const notifyUser = async (userId, { type, title, body = '', reservationId = null }) => {
  if (!userId) return;
  await q('INSERT INTO notifications (user_id, type, title, body, reservation_id) VALUES (?, ?, ?, ?, ?)', [
    userId, type, title, body, reservationId
  ]);
  const u = await one('SELECT role FROM users WHERE id = ?', [userId]);
  const url = u?.role === 'engineer' ? (reservationId ? '/ingenieur?session=' + reservationId : '/ingenieur')
    : u?.role === 'client' ? (reservationId ? '/mon-espace/reservations?voir=' + reservationId : '/mon-espace')
      : (reservationId ? '/admin/reservations?id=' + reservationId : '/admin/dashboard');
  background(pushToUser(userId, { title, body: String(body).slice(0, 240), tag: type, url }));
};

const scope = (user) =>
  user.role === 'admin' || user.role === 'super_admin'
    ? { where: '(user_id IS NULL OR user_id = ?)', params: [user.id] }
    : { where: 'user_id = ? AND is_financial = 0', params: [user.id] };

export const listNotifications = async (user, { unreadOnly = false, limit = 50 } = {}) => {
  const s = scope(user);
  const rows = await q(
    `SELECT id, type, title, body, reservation_id, is_financial, read_at, created_at FROM notifications
     WHERE ${s.where} ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...s.params, Math.min(Number(limit) || 50, 200)]
  );
  const [{ n }] = await q(`SELECT COUNT(*) AS n FROM notifications WHERE ${s.where} AND read_at IS NULL`, s.params);
  return { notifications: rows, unread: Number(n) };
};

export const markRead = async (user, ids) => {
  const s = scope(user);
  if (ids === 'all') {
    await q(`UPDATE notifications SET read_at = UTC_TIMESTAMP() WHERE ${s.where} AND read_at IS NULL`, s.params);
    return;
  }
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
  if (!list.length) return;
  await q(`UPDATE notifications SET read_at = UTC_TIMESTAMP() WHERE ${s.where} AND id IN (?) AND read_at IS NULL`, [...s.params, list]);
};
