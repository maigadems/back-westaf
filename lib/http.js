export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (m, extra) => new HttpError(400, m, extra);
export const unauthorized = (m = 'Authentification requise') => new HttpError(401, m);
export const forbidden = (m = 'Accès refusé') => new HttpError(403, m);
export const notFound = (m = 'Introuvable') => new HttpError(404, m);
export const conflict = (m, extra) => new HttpError(409, m, extra);

// Transmet les erreurs des handlers async au middleware d'erreur
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const errorHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: true, message: err.message, ...err.extra });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: true, message: 'JSON invalide' });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: true, message: 'Fichier trop volumineux (8 Mo max)' });
  if (err?.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: true, message: 'Fichier inattendu' });
  console.error('❌', req.method, req.originalUrl, err);
  res.status(500).json({ error: true, message: 'Erreur serveur' });
};

// --- Validation légère ---
export const str = (v, { max = 255, min = 0, field = 'champ', required = false } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`Le champ « ${field} » est obligatoire`);
    return null;
  }
  const s = String(v).trim();
  if (!s) {
    if (required) throw badRequest(`Le champ « ${field} » est obligatoire`);
    return null;
  }
  if (s.length < min) throw badRequest(`« ${field} » : ${min} caractères minimum`);
  if (s.length > max) throw badRequest(`« ${field} » : ${max} caractères maximum`);
  return s;
};

export const int = (v, { min = -Infinity, max = Infinity, field = 'nombre', required = false } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`Le champ « ${field} » est obligatoire`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`« ${field} » invalide`);
  return n;
};

export const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const email = (v, { required = true } = {}) => {
  const s = str(v, { max: 190, field: 'e-mail', required });
  if (s === null) return null;
  if (!EMAIL_RE.test(s)) throw badRequest('Adresse e-mail invalide');
  return s.toLowerCase();
};

export const oneOf = (v, list, field = 'valeur') => {
  if (!list.includes(v)) throw badRequest(`« ${field} » invalide`);
  return v;
};
