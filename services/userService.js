import jwt from 'jsonwebtoken';
import { q, one, pool } from '../config/db.js';
import { config } from '../config/env.js';
import { hashPassword } from '../lib/password.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http.js';

export const STAFF_ROLES = ['super_admin', 'admin', 'engineer'];
export const ADMIN_ROLES = ['super_admin', 'admin'];

export const publicUser = (u) =>
  u && {
    id: u.id,
    role: u.role,
    first_name: u.first_name,
    last_name: u.last_name,
    email: u.email,
    phone: u.phone,
    avatar_url: u.avatar_url,
    is_active: !!u.is_active,
    must_change_password: !!u.must_change_password,
    has_password: !!u.password_hash,
    google_linked: !!u.google_id,
    created_at: u.created_at,
    last_login_at: u.last_login_at
  };

export const findUserById = (id) => one('SELECT * FROM users WHERE id = ?', [id]);
export const findUserByEmail = (email) => one('SELECT * FROM users WHERE email = ?', [String(email || '').toLowerCase()]);
export const findUserByLegacyPhone = (p) => one('SELECT * FROM users WHERE legacy_phone = ?', [p]);

export const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role, tv: user.token_version }, config.jwtSecret, {
    expiresIn: user.role === 'client' ? config.jwtTtl : config.staffJwtTtl,
    issuer: 'westaf-api'
  });

export const verifyToken = (token) => jwt.verify(token, config.jwtSecret, { issuer: 'westaf-api' });

export const createUser = async ({ role = 'client', first_name, last_name, email, phone = null, password = null, google_id = null, avatar_url = null, must_change_password = 0 }) => {
  if (email && (await findUserByEmail(email))) throw conflict('Un compte existe déjà avec cette adresse e-mail');
  const [r] = await pool.query(
    `INSERT INTO users (role, first_name, last_name, email, phone, password_hash, google_id, avatar_url, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [role, first_name || '', last_name || '', email ? email.toLowerCase() : null, phone, password ? hashPassword(password) : null,
      google_id, avatar_url, must_change_password ? 1 : 0]
  );
  return findUserById(r.insertId);
};

export const setUserPassword = async (userId, password, { mustChange = 0 } = {}) => {
  // token_version++ : toutes les sessions existantes sont invalidées
  await q('UPDATE users SET password_hash = ?, must_change_password = ?, token_version = token_version + 1 WHERE id = ?', [
    hashPassword(password), mustChange ? 1 : 0, userId
  ]);
  return findUserById(userId);
};

export const touchLogin = (id) => q('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [id]);

// --- Gestion des comptes par l'administration ---

// Qui peut gérer quel rôle
export const canManageRole = (actor, role) => {
  if (actor.role === 'super_admin') return true;
  if (actor.role === 'admin') return role === 'engineer' || role === 'client';
  return false;
};

export const listUsers = async ({ role, search, active } = {}) => {
  const where = [];
  const params = [];
  if (role) { where.push('u.role IN (?)'); params.push(Array.isArray(role) ? role : [role]); }
  if (active === '1' || active === '0') { where.push('u.is_active = ?'); params.push(Number(active)); }
  if (search) {
    where.push("(u.email LIKE ? OR u.phone LIKE ? OR CONCAT(u.first_name, ' ', u.last_name) LIKE ?)");
    const s = `%${search}%`;
    params.push(s, s.replace(/\s|\+/g, ''), s);
  }
  return q(
    `SELECT u.*,
       (SELECT COUNT(*) FROM reservations r WHERE r.user_id = u.id) AS nb_reservations,
       (SELECT COUNT(*) FROM reservations r WHERE r.engineer_id = u.id AND r.statut = 'confirmee' AND r.start_at >= UTC_TIMESTAMP()) AS nb_sessions_a_venir,
       (SELECT MAX(r.start_at) FROM reservations r WHERE r.user_id = u.id) AS derniere_session
     FROM users u ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY u.created_at DESC LIMIT 1000`,
    params
  );
};

export const updateUserByAdmin = async (actor, id, input) => {
  const target = await findUserById(id);
  if (!target) throw notFound('Compte introuvable');
  if (!canManageRole(actor, target.role)) throw forbidden('Vous ne pouvez pas modifier ce compte');
  if (input.role && input.role !== target.role) {
    if (!canManageRole(actor, input.role)) throw forbidden('Rôle non autorisé');
    if (target.id === actor.id) throw badRequest('Vous ne pouvez pas changer votre propre rôle');
    await assertNotLastSuperAdmin(target);
  }
  if (input.is_active === false && target.id === actor.id) throw badRequest('Vous ne pouvez pas désactiver votre propre compte');
  if (input.is_active === false) await assertNotLastSuperAdmin(target);
  if (input.email && input.email !== target.email) {
    const other = await findUserByEmail(input.email);
    if (other && other.id !== target.id) throw conflict('Adresse e-mail déjà utilisée');
  }
  const fields = {};
  for (const k of ['first_name', 'last_name', 'email', 'phone', 'role']) if (input[k] !== undefined) fields[k] = input[k];
  if (input.is_active !== undefined) fields.is_active = input.is_active ? 1 : 0;
  const keys = Object.keys(fields);
  if (keys.length) {
    // Désactivation ou changement de rôle : on invalide les sessions ouvertes
    const bump = input.is_active === false || (input.role && input.role !== target.role) ? ', token_version = token_version + 1' : '';
    await q(`UPDATE users SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')}${bump} WHERE id = ?`, [...keys.map((k) => fields[k]), id]);
  }
  return findUserById(id);
};

const assertNotLastSuperAdmin = async (target) => {
  if (target.role !== 'super_admin') return;
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND is_active = 1 AND id <> ?", [target.id]);
  if (!Number(n)) throw badRequest('Impossible : il doit rester au moins un super administrateur actif');
};

export const deleteUserByAdmin = async (actor, id) => {
  const target = await findUserById(id);
  if (!target) throw notFound('Compte introuvable');
  if (!canManageRole(actor, target.role)) throw forbidden('Vous ne pouvez pas supprimer ce compte');
  if (target.id === actor.id) throw badRequest('Vous ne pouvez pas supprimer votre propre compte');
  await assertNotLastSuperAdmin(target);
  // Les données de réservation ne sont jamais supprimées : un compte lié à des réservations est désactivé à la place.
  const [{ n }] = await q('SELECT COUNT(*) AS n FROM reservations WHERE user_id = ? OR engineer_id = ?', [id, id]);
  if (Number(n) > 0) {
    throw conflict('Ce compte est lié à des réservations : désactivez-le plutôt que de le supprimer (l’historique est conservé).');
  }
  await q('DELETE FROM users WHERE id = ?', [id]);
};
