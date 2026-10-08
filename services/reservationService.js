import crypto from 'crypto';
import { pool } from '../config/db.js';

const parseRow = (row) => ({
  ...row,
  creneaux: row.creneaux ? JSON.parse(row.creneaux) : null,
  created_at: row.created_at ? row.created_at.replace(' ', 'T') + 'Z' : row.created_at,
  updated_at: row.updated_at ? row.updated_at.replace(' ', 'T') + 'Z' : row.updated_at
});

/**
 * Créer une réservation après confirmation de paiement
 */
export const createReservation = async (d) => {
  try {
    const id = crypto.randomUUID();
    await pool.execute(
      `INSERT INTO reservations
        (id, nom, email, telephone, message, date_reservation, creneaux, duree_heures,
         montant_total, type_service, nombre_titres, statut)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmee')`,
      [
        id,
        d.nom,
        d.email,
        d.telephone,
        d.message || '',
        d.date_reservation,
        d.creneaux ? JSON.stringify(d.creneaux) : null,
        d.duree_heures ?? null,
        d.montant_total,
        d.type_service,
        d.nombre_titres ?? null
      ]
    );
    const [rows] = await pool.execute('SELECT * FROM reservations WHERE id = ?', [id]);
    return { success: true, data: parseRow(rows[0]) };
  } catch (error) {
    console.error('❌ Erreur MySQL lors de la création:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Éviter les doublons (même email/date/service dans les 5 dernières minutes)
 */
export const checkDuplicateReservation = async (email, date_reservation, type_service) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id FROM reservations
       WHERE email = ? AND date_reservation = ? AND type_service = ?
         AND created_at >= (UTC_TIMESTAMP() - INTERVAL 5 MINUTE)`,
      [email, date_reservation, type_service]
    );
    return rows.length > 0;
  } catch (error) {
    console.error('❌ Erreur lors de la vérification des doublons:', error);
    return false;
  }
};

export const getAllReservations = async () => {
  const [rows] = await pool.execute('SELECT * FROM reservations ORDER BY created_at DESC');
  return rows.map(parseRow);
};

export const getBookedSlotsForDate = async (date) => {
  const [rows] = await pool.execute(
    `SELECT creneaux FROM reservations
     WHERE date_reservation = ? AND statut <> 'annulee'
       AND type_service = 'horaire' AND creneaux IS NOT NULL`,
    [date]
  );
  return rows.flatMap((r) => JSON.parse(r.creneaux));
};

export const getReservationStats = async () => {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS totalReservations,
            COALESCE(SUM(duree_heures), 0) AS totalSlots,
            COALESCE(SUM(montant_total), 0) AS totalRevenue
     FROM reservations
     WHERE statut <> 'annulee'
       AND date_reservation >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
       AND date_reservation <= LAST_DAY(CURDATE())`
  );
  const r = rows[0];
  return {
    totalReservations: Number(r.totalReservations),
    totalSlots: Number(r.totalSlots),
    totalRevenue: Number(r.totalRevenue)
  };
};

export const updateReservationStatus = async (id, statut) => {
  const [res] = await pool.execute('UPDATE reservations SET statut = ? WHERE id = ?', [statut, id]);
  return res.affectedRows > 0;
};

export const deleteReservation = async (id) => {
  const [res] = await pool.execute('DELETE FROM reservations WHERE id = ?', [id]);
  return res.affectedRows > 0;
};
