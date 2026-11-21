// Commandes (mixage, mastering…) payées par étapes : acompte, premiers livrables, livraison finale.
// Les pourcentages sont fixés par service (modifiables par Jeuss) puis copiés sur chaque commande.
export default {
  id: '007_orders',
  async up(conn, h) {
    await h.addColumn('services', 'milestone_percent', 'INT NOT NULL DEFAULT 0 AFTER deposit_percent');
    await h.addColumn('reservations', 'production_status', 'VARCHAR(30) NULL AFTER presence_status');

    await conn.query(`CREATE TABLE IF NOT EXISTS order_milestones (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      reservation_id CHAR(36) NOT NULL,
      position TINYINT NOT NULL,
      kind VARCHAR(30) NOT NULL,
      label VARCHAR(100) NOT NULL,
      percent INT NOT NULL,
      amount INT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'a_venir',
      deliverable_note TEXT NULL,
      requested_at DATETIME NULL,
      paid_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_milestone (reservation_id, position),
      KEY idx_milestone_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query("ALTER TABLE payments MODIFY kind ENUM('initial','balance','milestone') NOT NULL");
    await h.addColumn('payments', 'milestone_id', 'INT UNSIGNED NULL AFTER kind');

    // Échéancier de départ des services au titre (modifiable par Jeuss dans Admin → Services) :
    // 30 % à la commande, 40 % aux premiers livrables, 30 % à la livraison finale.
    await conn.query(
      "UPDATE services SET allow_deposit = 1, deposit_percent = 30, milestone_percent = 40 WHERE booking_mode = 'per_track' AND milestone_percent = 0 AND allow_deposit = 0"
    );

    // Commandes existantes : production terminée si entièrement payées
    await conn.query(
      `UPDATE reservations r JOIN services s ON s.id = r.service_id SET r.production_status = IF(r.payment_status = 'paye', 'livree', 'en_cours')
       WHERE s.booking_mode = 'per_track' AND r.production_status IS NULL AND r.statut IN ('confirmee','terminee')`
    );
  }
};
