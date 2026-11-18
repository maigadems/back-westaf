import crypto from 'crypto';

// Format historique conservé : "saltHex:hashHex" (scrypt, 64 octets)
export const hashPassword = (password) => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
};

export const verifyPassword = (password, stored) => {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
};

export const validateNewPassword = (p) => {
  if (typeof p !== 'string' || p.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères';
  if (p.length > 128) return 'Mot de passe trop long';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Le mot de passe doit contenir au moins une lettre et un chiffre';
  return null;
};

export const generatePassword = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let p = Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
  if (!/\d/.test(p)) p = p.slice(0, -1) + '7';
  return p;
};

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
