// Secrets générés automatiquement par le serveur (signature des sessions, clés des notifications push)
// lorsqu'ils ne sont pas fournis par l'environnement : aucune variable à ajouter sur l'hébergement.
export default {
  id: '011_app_secrets',
  async up(conn) {
    await conn.query(`CREATE TABLE IF NOT EXISTS app_secrets (
      name VARCHAR(64) NOT NULL PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
};
