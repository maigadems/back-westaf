// Nouveau schéma de la plateforme. Aucune donnée existante n'est supprimée :
// les colonnes historiques des réservations sont conservées.
const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';

export default {
  id: '002_platform_schema',
  async up(conn, h) {
    await conn.query(`CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      role ENUM('super_admin','admin','engineer','client') NOT NULL DEFAULT 'client',
      first_name VARCHAR(100) NOT NULL DEFAULT '',
      last_name VARCHAR(100) NOT NULL DEFAULT '',
      email VARCHAR(190) NULL,
      phone VARCHAR(20) NULL,
      legacy_phone VARCHAR(20) NULL,
      password_hash VARCHAR(255) NULL,
      google_id VARCHAR(64) NULL,
      avatar_url VARCHAR(500) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      must_change_password TINYINT(1) NOT NULL DEFAULT 0,
      token_version INT NOT NULL DEFAULT 0,
      last_login_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_users_email (email),
      UNIQUE KEY uq_users_google (google_id),
      UNIQUE KEY uq_users_legacy_phone (legacy_phone),
      KEY idx_users_role (role),
      KEY idx_users_phone (phone)
    ) ${T}`);

    await conn.query(`CREATE TABLE IF NOT EXISTS password_resets (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_reset_token (token_hash),
      KEY idx_reset_user (user_id),
      CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${T}`);

    await conn.query(`CREATE TABLE IF NOT EXISTS settings (
      skey VARCHAR(64) NOT NULL PRIMARY KEY,
      svalue TEXT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ${T}`);

    await conn.query(`CREATE TABLE IF NOT EXISTS services (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(80) NOT NULL,
      name VARCHAR(150) NOT NULL,
      tagline VARCHAR(255) NULL,
      description TEXT NULL,
      booking_mode ENUM('slot','per_track','quote') NOT NULL DEFAULT 'slot',
      price INT NULL,
      price_unit VARCHAR(30) NULL,
      min_hours INT NOT NULL DEFAULT 1,
      max_hours INT NOT NULL DEFAULT 8,
      allow_deposit TINYINT(1) NOT NULL DEFAULT 0,
      deposit_percent INT NOT NULL DEFAULT 50,
      features TEXT NULL,
      image_url VARCHAR(500) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      is_featured TINYINT(1) NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_services_slug (slug)
    ) ${T}`);

    await conn.query(`CREATE TABLE IF NOT EXISTS opening_hours (
      weekday TINYINT NOT NULL PRIMARY KEY,
      is_open TINYINT(1) NOT NULL DEFAULT 1,
      open_time CHAR(5) NOT NULL DEFAULT '08:00',
      close_time CHAR(5) NOT NULL DEFAULT '24:00',
      break_start CHAR(5) NULL,
      break_end CHAR(5) NULL
    ) ${T}`);

    await conn.query(`CREATE TABLE IF NOT EXISTS closures (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      start_at DATETIME NOT NULL,
      end_at DATETIME NOT NULL,
      reason VARCHAR(255) NULL,
      created_by INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_closures_range (start_at, end_at)
    ) ${T}`);

    await conn.query(`CREATE TABLE IF NOT EXISTS engineer_unavailability (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      start_at DATETIME NOT NULL,
      end_at DATETIME NOT NULL,
      reason VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_unavail (user_id, start_at, end_at),
      CONSTRAINT fk_unavail_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${T}`);

    // --- Réservations : colonnes ajoutées (les existantes sont conservées) ---
    // type_service et statut passent en VARCHAR pour accepter les nouveaux services / statuts
    await conn.query("ALTER TABLE reservations MODIFY type_service VARCHAR(80) NOT NULL DEFAULT 'horaire'");
    await conn.query("ALTER TABLE reservations MODIFY statut VARCHAR(20) NOT NULL DEFAULT 'confirmee'");
    await conn.query("ALTER TABLE reservations MODIFY type_paiement VARCHAR(20) NOT NULL DEFAULT 'total'");
    await h.addColumn('reservations', 'user_id', 'INT UNSIGNED NULL AFTER id');
    await h.addColumn('reservations', 'service_id', 'INT UNSIGNED NULL AFTER user_id');
    await h.addColumn('reservations', 'engineer_id', 'INT UNSIGNED NULL AFTER service_id');
    await h.addColumn('reservations', 'start_at', 'DATETIME NULL AFTER date_reservation');
    await h.addColumn('reservations', 'end_at', 'DATETIME NULL AFTER start_at');
    await h.addColumn('reservations', 'payment_status', "VARCHAR(30) NOT NULL DEFAULT 'non_paye' AFTER montant_paye");
    await h.addColumn('reservations', 'session_status', "VARCHAR(30) NOT NULL DEFAULT 'planifiee' AFTER statut");
    await h.addColumn('reservations', 'presence_status', "VARCHAR(30) NOT NULL DEFAULT 'non_demandee' AFTER session_status");
    await h.addColumn('reservations', 'reschedule_count', 'INT NOT NULL DEFAULT 0');
    await h.addColumn('reservations', 'internal_notes', 'TEXT NULL');
    await h.addColumn('reservations', 'action_token', 'CHAR(48) NULL');
    await h.addColumn('reservations', 'hold_expires_at', 'DATETIME NULL');
    await h.addColumn('reservations', 'cancelled_at', 'DATETIME NULL');
    await h.addColumn('reservations', 'cancel_reason', 'VARCHAR(255) NULL');
    await h.addColumn('reservations', 'reminder_sent_at', 'DATETIME NULL');
    await h.addColumn('reservations', 'payment_link_sent_at', 'DATETIME NULL');
    await h.addColumn('reservations', 'presence_answered_at', 'DATETIME NULL');
    await h.addColumn('reservations', 'completed_at', 'DATETIME NULL');
    await h.addIndex('reservations', 'uq_res_action_token', 'UNIQUE KEY uq_res_action_token (action_token)');
    await h.addIndex('reservations', 'idx_res_start', 'KEY idx_res_start (start_at)');
    await h.addIndex('reservations', 'idx_res_user', 'KEY idx_res_user (user_id)');
    await h.addIndex('reservations', 'idx_res_engineer', 'KEY idx_res_engineer (engineer_id, start_at)');
    await h.addIndex('reservations', 'idx_res_statut', 'KEY idx_res_statut (statut)');

    // Verrou d'occupation horaire : la clé primaire empêche toute double réservation,
    // même en cas de requêtes simultanées.
    await conn.query(`CREATE TABLE IF NOT EXISTS slot_locks (
      slot_start DATETIME NOT NULL PRIMARY KEY,
      reservation_id CHAR(36) NOT NULL,
      KEY idx_slot_res (reservation_id)
    ) ${T}`);

    await conn.query(`CREATE TABLE IF NOT EXISTS payments (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      reservation_id CHAR(36) NOT NULL,
      ref_command VARCHAR(80) NOT NULL,
      kind ENUM('initial','balance') NOT NULL,
      method ENUM('online','cash') NOT NULL DEFAULT 'online',
      amount INT NOT NULL,
      status ENUM('pending','completed','canceled','awaiting_validation','failed') NOT NULL DEFAULT 'pending',
      provider_token VARCHAR(120) NULL,
      provider_method VARCHAR(60) NULL,
      validated_by INT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME NULL,
      UNIQUE KEY uq_payments_ref (ref_command),
      KEY idx_payments_res (reservation_id),
      KEY idx_payments_status (status)
    ) ${T}`);

    await conn.query(`CREATE TABLE IF NOT EXISTS reservation_history (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      reservation_id CHAR(36) NOT NULL,
      actor_id INT UNSIGNED NULL,
      actor_role VARCHAR(20) NULL,
      action VARCHAR(50) NOT NULL,
      details TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_hist_res (reservation_id, created_at)
    ) ${T}`);

    // user_id NULL = notification destinée à l'équipe d'administration (Jeuss + super admin)
    await conn.query(`CREATE TABLE IF NOT EXISTS notifications (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NULL,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT NULL,
      reservation_id CHAR(36) NULL,
      is_financial TINYINT(1) NOT NULL DEFAULT 0,
      read_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_notif_user (user_id, read_at, created_at)
    ) ${T}`);

    await conn.query(`CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      direction ENUM('out','in') NOT NULL DEFAULT 'out',
      dedupe_key VARCHAR(191) NULL,
      reservation_id CHAR(36) NULL,
      to_phone VARCHAR(20) NULL,
      kind VARCHAR(50) NOT NULL,
      template VARCHAR(100) NULL,
      payload TEXT NULL,
      status VARCHAR(30) NOT NULL,
      provider_id VARCHAR(191) NULL,
      error TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_wa_dedupe (dedupe_key),
      KEY idx_wa_res (reservation_id),
      KEY idx_wa_provider (provider_id)
    ) ${T}`);

    await conn.query(`CREATE TABLE IF NOT EXISTS equipment (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      category VARCHAR(80) NULL,
      description TEXT NULL,
      is_public TINYINT(1) NOT NULL DEFAULT 1,
      is_featured TINYINT(1) NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ${T}`);

    await conn.query(`CREATE TABLE IF NOT EXISTS equipment_photos (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      equipment_id INT UNSIGNED NOT NULL,
      url VARCHAR(500) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_eqp_equipment (equipment_id),
      CONSTRAINT fk_eqp_equipment FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE
    ) ${T}`);

    await conn.query(`CREATE TABLE IF NOT EXISTS gallery_photos (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      url VARCHAR(500) NOT NULL,
      title VARCHAR(150) NULL,
      description TEXT NULL,
      is_featured TINYINT(1) NOT NULL DEFAULT 0,
      is_public TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      width INT NULL,
      height INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ${T}`);
  }
};
