// Authentification et contrôle d'accès appliqués côté serveur.
import { findUserById, verifyToken, ADMIN_ROLES } from '../services/userService.js';

const bearer = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

export const loadUser = async (req) => {
  const token = bearer(req);
  if (!token) return null;
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return null;
  }
  const user = await findUserById(payload.sub);
  // Compte désactivé, rôle modifié ou mot de passe changé => jeton révoqué
  if (!user || !user.is_active || user.token_version !== payload.tv || user.role !== payload.role) return null;
  return user;
};

export const requireAuth = (...roles) => async (req, res, next) => {
  try {
    const user = await loadUser(req);
    if (!user) return res.status(401).json({ error: true, message: 'Session expirée. Veuillez vous reconnecter.' });
    if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: true, message: 'Accès refusé' });
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
};

export const optionalAuth = async (req, _res, next) => {
  try {
    req.user = await loadUser(req);
    next();
  } catch (e) {
    next(e);
  }
};

export const requireAdmin = requireAuth(...ADMIN_ROLES);
export const requireSuperAdmin = requireAuth('super_admin');
export const requireEngineer = requireAuth('engineer');
export const requireClient = requireAuth('client');

// Accès aux données financières : Jeuss (admin) et super admin uniquement
export const canSeeFinance = (user) => !!user && ADMIN_ROLES.includes(user.role);
