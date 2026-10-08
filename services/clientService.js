import crypto from 'crypto';
import { pool } from '../config/db.js';

// Chiffres uniquement, sans indicatif 221 : "+221 77 860 04 82" -> "778600482"
export const normalizePhone = (raw) => {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00221')) d = d.slice(5);
  else if (d.startsWith('221') && d.length > 9) d = d.slice(3);
  return d;
};

export const hashPassword = (password) => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
};

export const verifyPassword = (password, stored) => {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
};

const generatePassword = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join('');
};

export const findClient = async (telephone) => {
  const [rows] = await pool.execute('SELECT * FROM clients WHERE telephone = ?', [telephone]);
  return rows[0] || null;
};

/**
 * Crée le compte client s'il n'existe pas. Retourne le mot de passe en clair
 * uniquement pour un nouveau compte (affiché une seule fois au client).
 */
export const ensureClientAccount = async (rawPhone, nom) => {
  const telephone = normalizePhone(rawPhone);
  if (telephone.length < 8) return { created: false, telephone: null };
  const existing = await findClient(telephone);
  if (existing) return { created: false, telephone };
  const password = generatePassword();
  await pool.execute(
    'INSERT INTO clients (telephone, nom, password_hash) VALUES (?, ?, ?)',
    [telephone, nom || null, hashPassword(password)]
  );
  return { created: true, telephone, password };
};

export const storeReveal = async (key, telephone, password) => {
  await pool.execute('DELETE FROM credential_reveals WHERE expires_at < UTC_TIMESTAMP()');
  await pool.execute(
    `INSERT INTO credential_reveals (reveal_key, telephone, password_plain, expires_at)
     VALUES (?, ?, ?, UTC_TIMESTAMP() + INTERVAL 24 HOUR)
     ON DUPLICATE KEY UPDATE telephone = VALUES(telephone), password_plain = VALUES(password_plain)`,
    [key, telephone, password]
  );
};

// Lecture à usage unique
export const takeReveal = async (key) => {
  const [rows] = await pool.execute(
    'SELECT telephone, password_plain FROM credential_reveals WHERE reveal_key = ? AND expires_at >= UTC_TIMESTAMP()',
    [key]
  );
  if (!rows[0]) return null;
  await pool.execute('DELETE FROM credential_reveals WHERE reveal_key = ?', [key]);
  return rows[0];
};

export const setPassword = async (telephone, password) => {
  const [r] = await pool.execute('UPDATE clients SET password_hash = ? WHERE telephone = ?', [
    hashPassword(password),
    telephone
  ]);
  return r.affectedRows > 0;
};

export const resetPassword = async (telephone) => {
  const password = generatePassword();
  const ok = await setPassword(telephone, password);
  return ok ? password : null;
};

export const getClientReservations = async (telephone) => {
  const [rows] = await pool.execute(
    `SELECT id, nom, email, telephone, date_reservation, creneaux, duree_heures, montant_total,
            type_paiement, montant_paye, statut, type_service, nombre_titres, created_at
     FROM reservations
     WHERE REPLACE(REPLACE(REPLACE(REPLACE(telephone, '+221', ''), ' ', ''), '-', ''), '.', '') = ?
        OR REPLACE(REPLACE(REPLACE(telephone, ' ', ''), '-', ''), '+', '') = ?
     ORDER BY date_reservation DESC, created_at DESC`,
    [telephone, '221' + telephone]
  );
  return rows.map((r) => ({
    ...r,
    creneaux: r.creneaux ? JSON.parse(r.creneaux) : null,
    date_reservation:
      r.date_reservation instanceof Date
        ? r.date_reservation.toISOString().slice(0, 10)
        : r.date_reservation
  }));
};

export const listClients = async () => {
  const [rows] = await pool.execute(
    `SELECT c.telephone, c.nom, c.created_at,
            (SELECT COUNT(*) FROM reservations r
              WHERE REPLACE(REPLACE(REPLACE(REPLACE(r.telephone, '+221', ''), ' ', ''), '-', ''), '.', '') = c.telephone) AS nb_reservations
     FROM clients c ORDER BY c.created_at DESC`
  );
  return rows;
};

export const getOverview = async () => {
  const [[tot]] = await pool.execute(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN statut <> 'annulee' THEN montant_paye END), 0) AS encaisse,
            COALESCE(SUM(CASE WHEN statut <> 'annulee' THEN montant_total - montant_paye END), 0) AS solde,
            COALESCE(SUM(CASE WHEN statut <> 'annulee' AND date_reservation >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
                               AND date_reservation <= LAST_DAY(CURDATE()) THEN montant_paye END), 0) AS encaisse_mois,
            SUM(statut <> 'annulee' AND date_reservation >= CURDATE()) AS a_venir,
            SUM(statut = 'annulee') AS annulees
     FROM reservations`
  );
  const [[cl]] = await pool.execute('SELECT COUNT(*) AS n FROM clients');
  return {
    totalReservations: Number(tot.total),
    encaisse: Number(tot.encaisse),
    soldeAEncaisser: Number(tot.solde),
    encaisseMois: Number(tot.encaisse_mois),
    aVenir: Number(tot.a_venir || 0),
    annulees: Number(tot.annulees || 0),
    clients: Number(cl.n)
  };
};
