// Notifications push (Web Push / VAPID) : affichées sur l'écran du téléphone même application fermée.
// Clés VAPID : VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (générer avec `npx web-push generate-vapid-keys`).
import webpush from 'web-push';
import { q } from '../config/db.js';
import { sha256 } from '../lib/password.js';

const PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contact@westafrecords.com';

export const pushConfigured = () => !!(PUBLIC && PRIVATE);
export const vapidPublicKey = () => (pushConfigured() ? PUBLIC : null);
if (pushConfigured()) webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);

export const saveSubscription = async (userId, sub, { app = null, userAgent = null } = {}) => {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 700 || !p256dh || !auth) throw new Error('Abonnement invalide');
  await q(
    `INSERT INTO push_subscriptions (user_id, endpoint, endpoint_hash, p256dh, auth, app, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), app = VALUES(app), user_agent = VALUES(user_agent)`,
    [userId, endpoint, sha256(endpoint), p256dh.slice(0, 255), auth.slice(0, 255), app, String(userAgent || '').slice(0, 255) || null]
  );
};

export const removeSubscription = (userId, endpoint) =>
  q('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint_hash = ?', [userId, sha256(String(endpoint || ''))]);

const sendTo = async (subs, payload) => {
  if (!pushConfigured() || !subs.length) return 0;
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 24 * 3600, urgency: 'high' });
      sent++;
      await q('UPDATE push_subscriptions SET last_used_at = UTC_TIMESTAMP() WHERE id = ?', [s.id]);
    } catch (e) {
      // Abonnement expiré ou révoqué par l'appareil : on le supprime
      if (e.statusCode === 404 || e.statusCode === 410) await q('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
      else console.error('❌ Push :', e.statusCode || '', e.body || e.message);
    }
  }));
  return sent;
};

// Équipe d'administration (Jeuss + super admin)
export const pushToStaff = async (payload) =>
  sendTo(await q("SELECT s.* FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.is_active = 1 AND u.role IN ('admin','super_admin')"), payload);

export const pushToUser = async (userId, payload) =>
  sendTo(await q('SELECT s.* FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.is_active = 1 AND s.user_id = ?', [userId]), payload);
