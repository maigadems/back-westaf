// Tables historiques (identiques à schema.sql) : créées uniquement si absentes.
export default {
  id: '001_base_tables',
  async up(conn, h) {
    await conn.query(`CREATE TABLE IF NOT EXISTS reservations (
      id CHAR(36) NOT NULL PRIMARY KEY,
      nom VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      telephone VARCHAR(50) NOT NULL,
      message TEXT,
      date_reservation DATE NOT NULL,
      creneaux TEXT NULL,
      duree_heures INT NULL,
      montant_total INT NOT NULL,
      type_paiement ENUM('partiel','total') NOT NULL DEFAULT 'total',
      montant_paye INT NOT NULL DEFAULT 0,
      statut ENUM('en_attente','confirmee','annulee') NOT NULL DEFAULT 'confirmee',
      type_service ENUM('horaire','mixage','mastering') NOT NULL,
      nombre_titres INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_date (date_reservation),
      INDEX idx_dup (email, date_reservation, type_service)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // Bases antérieures à l'ajout du paiement partiel
    await h.addColumn('reservations', 'type_paiement', "ENUM('partiel','total') NOT NULL DEFAULT 'total' AFTER montant_total");
    await h.addColumn('reservations', 'montant_paye', 'INT NOT NULL DEFAULT 0 AFTER type_paiement');

    await conn.query(`CREATE TABLE IF NOT EXISTS clients (
      telephone VARCHAR(20) NOT NULL PRIMARY KEY,
      nom VARCHAR(255) NULL,
      password_hash VARCHAR(255) NOT NULL,
      must_change_password TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await h.addColumn('clients', 'must_change_password', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER password_hash');

    await conn.query(`CREATE TABLE IF NOT EXISTS credential_reveals (
      reveal_key VARCHAR(64) NOT NULL PRIMARY KEY,
      telephone VARCHAR(20) NOT NULL,
      password_plain VARCHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
};
