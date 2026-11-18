// Factures : une facture par réservation, émise au premier paiement encaissé.
// Numérotation annuelle continue (WR-AAAA-0001) garantie par invoice_counters.
const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';

export default {
  id: '004_invoices',
  async up(conn) {
    await conn.query(`CREATE TABLE IF NOT EXISTS invoice_counters (
      year SMALLINT NOT NULL PRIMARY KEY,
      last_number INT NOT NULL DEFAULT 0
    ) ${T}`);

    await conn.query(`CREATE TABLE IF NOT EXISTS invoices (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      number VARCHAR(30) NOT NULL,
      reservation_id CHAR(36) NOT NULL,
      user_id INT UNSIGNED NULL,
      client_name VARCHAR(255) NOT NULL,
      client_email VARCHAR(255) NULL,
      client_phone VARCHAR(50) NULL,
      issued_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_invoice_number (number),
      UNIQUE KEY uq_invoice_reservation (reservation_id),
      KEY idx_invoice_user (user_id),
      KEY idx_invoice_issued (issued_at)
    ) ${T}`);

    // Mentions légales de l'émetteur (renseignées par Jeuss dans Paramètres → Facturation)
    for (const [k, v] of [
      ['invoice_prefix', 'WR'],
      ['invoice_company_name', 'Westaf Records'],
      ['invoice_address', 'Almadies, Dakar, Sénégal'],
      ['invoice_ninea', ''],
      ['invoice_rccm', ''],
      ['invoice_footer', 'Merci pour votre confiance.']
    ]) {
      await conn.query('INSERT IGNORE INTO settings (skey, svalue) VALUES (?, ?)', [k, v]);
    }

    // Factures des réservations déjà payées (ordre chronologique du premier paiement)
    const [rows] = await conn.query(
      `SELECT r.id, r.user_id, r.nom, r.email, r.telephone, MIN(p.completed_at) AS first_paid
       FROM reservations r JOIN payments p ON p.reservation_id = r.id AND p.status = 'completed'
       LEFT JOIN invoices i ON i.reservation_id = r.id
       WHERE i.id IS NULL GROUP BY r.id ORDER BY first_paid, r.created_at`
    );
    for (const r of rows) {
      const issued = r.first_paid || new Date().toISOString().slice(0, 19).replace('T', ' ');
      const year = Number(String(issued).slice(0, 4));
      await conn.query('INSERT INTO invoice_counters (year, last_number) VALUES (?, 1) ON DUPLICATE KEY UPDATE last_number = last_number + 1', [year]);
      const [[c]] = await conn.query('SELECT last_number FROM invoice_counters WHERE year = ?', [year]);
      await conn.query(
        'INSERT INTO invoices (number, reservation_id, user_id, client_name, client_email, client_phone, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [`WR-${year}-${String(c.last_number).padStart(4, '0')}`, r.id, r.user_id, r.nom, r.email || null, r.telephone || null, issued]
      );
    }
  }
};
