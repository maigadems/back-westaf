// Abonnements aux notifications push (application installée sur le téléphone / l'ordinateur)
export default {
  id: '010_push_subscriptions',
  async up(conn) {
    await conn.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      endpoint VARCHAR(700) NOT NULL,
      endpoint_hash CHAR(64) NOT NULL,
      p256dh VARCHAR(255) NOT NULL,
      auth VARCHAR(255) NOT NULL,
      app VARCHAR(20) NULL,
      user_agent VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME NULL,
      UNIQUE KEY uq_push_endpoint (endpoint_hash),
      KEY idx_push_user (user_id),
      CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
};
