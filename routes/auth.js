import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { q, one } from '../config/db.js';
import { config } from '../config/env.js';
import { ah, badRequest, email as vEmail, str, HttpError, unauthorized } from '../lib/http.js';
import { randomToken, sha256, validateNewPassword, verifyPassword } from '../lib/password.js';
import { clearFailures, isBlocked, recordFailure, tooMany } from '../lib/rateLimit.js';
import { intlPhone, localPhone } from '../lib/phone.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createUser, findUserByEmail, findUserByLegacyPhone, findUserById, publicUser, setUserPassword, signToken, touchLogin
} from '../services/userService.js';
import { sendPasswordResetEmail } from '../services/emailService.js';
import { pushConfigured, removeSubscription, saveSubscription } from '../services/pushService.js';

const router = Router();
const googleClient = new OAuth2Client();

const session = async (user) => {
  await touchLogin(user.id);
  return { token: signToken(user), user: publicUser(await findUserById(user.id)) };
};

const assertActive = (user) => {
  if (!user.is_active) throw new HttpError(403, 'Ce compte est désactivé. Contactez le studio.');
};

router.post('/register', ah(async (req, res) => {
  const b = req.body || {};
  if (tooMany(`register:${req.ip}`, 10, 60)) throw new HttpError(429, 'Trop de tentatives. Réessayez plus tard.');
  const first_name = str(b.first_name, { field: 'prénom', required: true, max: 100 });
  const last_name = str(b.last_name, { field: 'nom', required: true, max: 100 });
  const email = vEmail(b.email);
  const pwdError = validateNewPassword(b.password);
  if (pwdError) throw badRequest(pwdError);
  let phone = null;
  if (b.phone) {
    phone = intlPhone(b.phone);
    if (!phone) throw badRequest('Numéro de téléphone invalide');
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    // Compte créé automatiquement à partir d'anciennes réservations, sans mot de passe : on le complète
    if (existing.role === 'client' && !existing.password_hash && !existing.google_id) {
      await q('UPDATE users SET first_name = ?, last_name = ?, phone = COALESCE(?, phone) WHERE id = ?', [first_name, last_name, phone, existing.id]);
      const user = await setUserPassword(existing.id, b.password);
      return res.status(201).json(await session(user));
    }
    throw new HttpError(409, 'Un compte existe déjà avec cette adresse e-mail. Connectez-vous ou utilisez « Mot de passe oublié ».');
  }
  const user = await createUser({ role: 'client', first_name, last_name, email, phone, password: b.password });
  res.status(201).json(await session(user));
}));

router.post('/login', ah(async (req, res) => {
  const identifier = String(req.body?.email || req.body?.identifier || '').trim();
  const password = String(req.body?.password || '');
  if (!identifier || !password) throw badRequest('Adresse e-mail et mot de passe requis');
  const rl = `login:${req.ip}:${identifier.toLowerCase()}`;
  if (isBlocked(rl)) throw new HttpError(429, 'Trop de tentatives. Réessayez dans 15 minutes.');

  // E-mail, ou numéro de téléphone pour les comptes créés par l'ancien système
  // (ou identifiant de l'ancien compte administrateur, ADMIN_LOGIN)
  const user = (await findUserByEmail(identifier)) || (identifier.includes('@') ? null : await findUserByLegacyPhone(localPhone(identifier)));
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    recordFailure(rl);
    if (user && !user.password_hash) {
      throw unauthorized(user.google_id
        ? 'Ce compte utilise la connexion Google.'
        : 'Aucun mot de passe n’est encore défini pour ce compte : utilisez « Mot de passe oublié » pour en créer un.');
    }
    throw unauthorized('Adresse e-mail ou mot de passe incorrect');
  }
  assertActive(user);
  clearFailures(rl);
  res.json(await session(user));
}));

router.post('/google', ah(async (req, res) => {
  if (!config.google.clientId) throw new HttpError(503, 'La connexion Google n’est pas encore configurée');
  const credential = String(req.body?.credential || '');
  if (!credential) throw badRequest('Jeton Google manquant');
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: config.google.clientId });
    payload = ticket.getPayload();
  } catch {
    throw unauthorized('Connexion Google invalide ou expirée');
  }
  if (!payload?.sub || !payload.email || !payload.email_verified) throw unauthorized('Adresse Google non vérifiée');

  let user = await one('SELECT * FROM users WHERE google_id = ?', [payload.sub]);
  if (!user) {
    user = await findUserByEmail(payload.email);
    if (user) {
      // E-mail vérifié par Google : on rattache le compte existant
      await q(`UPDATE users SET google_id = ?, avatar_url = COALESCE(avatar_url, ?), first_name = IF(first_name = '', ?, first_name),
                 last_name = IF(last_name = '', ?, last_name) WHERE id = ?`, [
        payload.sub, payload.picture || null, payload.given_name || '', payload.family_name || '', user.id
      ]);
      user = await findUserById(user.id);
    } else {
      user = await createUser({
        role: 'client', first_name: payload.given_name || payload.name || '', last_name: payload.family_name || '',
        email: payload.email, google_id: payload.sub, avatar_url: payload.picture || null
      });
    }
  }
  assertActive(user);
  res.json(await session(user));
}));

router.post('/forgot-password', ah(async (req, res) => {
  const email = vEmail(req.body?.email);
  // Réponse identique que le compte existe ou non (pas d'énumération des comptes)
  const response = { success: true, message: 'Si un compte correspond à cette adresse, un lien de réinitialisation vient d’être envoyé.' };
  if (tooMany(`forgot:${req.ip}`, 10, 60) || tooMany(`forgot:${email}`, 3, 30)) return res.json(response);
  const user = await findUserByEmail(email);
  if (user && user.is_active) {
    const token = randomToken(32);
    await q('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL 1 HOUR)', [user.id, sha256(token)]);
    const link = `${config.frontendUrl}/reinitialiser-mot-de-passe?token=${token}`;
    const r = await sendPasswordResetEmail(user, link);
    if (!r.sent) console.error(`❌ Lien de réinitialisation non envoyé à ${email} : ${r.reason}`);
  }
  res.json(response);
}));

router.get('/reset-password/:token', ah(async (req, res) => {
  const row = await one('SELECT id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()', [sha256(req.params.token)]);
  res.json({ valid: !!row });
}));

router.post('/reset-password', ah(async (req, res) => {
  const token = String(req.body?.token || '');
  const pwdError = validateNewPassword(req.body?.password);
  if (pwdError) throw badRequest(pwdError);
  if (tooMany(`reset:${req.ip}`, 20, 60)) throw new HttpError(429, 'Trop de tentatives');
  const row = await one('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()', [sha256(token)]);
  if (!row) throw badRequest('Lien invalide ou expiré. Faites une nouvelle demande.');
  await q('UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL', [row.user_id]);
  const user = await setUserPassword(row.user_id, req.body.password);
  assertActive(user);
  res.json(await session(user));
}));

router.get('/me', requireAuth(), ah(async (req, res) => {
  res.json({ user: publicUser(req.user) });
}));

router.patch('/me', requireAuth(), ah(async (req, res) => {
  const b = req.body || {};
  const fields = {};
  if (b.first_name !== undefined) fields.first_name = str(b.first_name, { field: 'prénom', required: true, max: 100 });
  if (b.last_name !== undefined) fields.last_name = str(b.last_name, { field: 'nom', required: true, max: 100 });
  if (b.phone !== undefined) {
    fields.phone = b.phone ? intlPhone(b.phone) : null;
    if (b.phone && !fields.phone) throw badRequest('Numéro de téléphone invalide');
  }
  if (b.email !== undefined && b.email !== req.user.email) {
    const email = vEmail(b.email);
    if (!req.user.password_hash || !verifyPassword(String(b.current_password || ''), req.user.password_hash)) {
      throw badRequest('Mot de passe actuel requis pour changer d’adresse e-mail');
    }
    const other = await findUserByEmail(email);
    if (other && other.id !== req.user.id) throw new HttpError(409, 'Adresse e-mail déjà utilisée');
    fields.email = email;
  }
  const keys = Object.keys(fields);
  if (keys.length) await q(`UPDATE users SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => fields[k]), req.user.id]);
  res.json({ user: publicUser(await findUserById(req.user.id)) });
}));

router.post('/change-password', requireAuth(), ah(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  const rl = `pwd:${req.user.id}`;
  if (isBlocked(rl)) throw new HttpError(429, 'Trop de tentatives. Réessayez plus tard.');
  if (req.user.password_hash && !verifyPassword(String(current_password || ''), req.user.password_hash)) {
    recordFailure(rl);
    throw badRequest('Mot de passe actuel incorrect');
  }
  if (current_password && current_password === new_password) throw badRequest('Le nouveau mot de passe doit être différent de l’actuel');
  const pwdError = validateNewPassword(new_password);
  if (pwdError) throw badRequest(pwdError);
  clearFailures(rl);
  const user = await setUserPassword(req.user.id, new_password);
  res.json(await session(user)); // nouveau jeton : les autres sessions sont fermées
}));

// Déconnexion de tous les appareils
router.post('/logout-all', requireAuth(), ah(async (req, res) => {
  await q('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [req.user.id]);
  res.json({ success: true });
}));

// Notifications push : abonnement de l'appareil de l'utilisateur connecté
router.post('/push/subscribe', requireAuth(), ah(async (req, res) => {
  if (!pushConfigured()) throw new HttpError(503, 'Les notifications push ne sont pas encore configurées sur le serveur');
  try {
    await saveSubscription(req.user.id, req.body?.subscription, { app: req.body?.app === 'admin' ? 'admin' : 'client', userAgent: req.headers['user-agent'] });
  } catch (e) {
    throw badRequest(e.message);
  }
  res.status(201).json({ success: true });
}));
router.post('/push/unsubscribe', requireAuth(), ah(async (req, res) => {
  await removeSubscription(req.user.id, req.body?.endpoint);
  res.json({ success: true });
}));

export default router;
