// Comptes de l'équipe fixés par le studio (aucune variable à ajouter sur l'hébergement).
// Seule l'empreinte scrypt du mot de passe est stockée ici, jamais le mot de passe en clair.
// Le dépôt étant public, le mot de passe doit être changé à la première connexion :
// l'empreinte ci-dessous ne sert alors plus à rien.
const ACCOUNTS = [
  { role: 'super_admin', first_name: 'Pape Matar', email: 'paapamatarndiaye@esp.sn', password_hash: '79f0ab0ac35d1260bd59d240c8d228c3:eb45b283c55bccb2f846e331cc81bb067ce43bec7fd1ecfc1c259354e1696a6419a3db8cf6c4f5d2dafcd2e426742c4f545c6307c7ed9040fc9de4afd02f3cf6' },
  { role: 'admin', first_name: 'Jeuss', email: 'jeuss.beat@westafrecords.com', password_hash: '0b82792ce00636430cf7db8f3278c065:cee131c84c13d5642772bca8aa33e940504c935cd77bd23be50a25bbfeae48183cd5beabf574d9b8a1cb9d423600266b0e7c52983500a9205e0a5efd828eb60f' }
];

export default {
  id: '012_staff_accounts',
  async up(conn) {
    for (const a of ACCOUNTS) {
      const [rows] = await conn.query('SELECT id FROM users WHERE email = ?', [a.email]);
      if (rows.length) {
        // Adresse déjà utilisée : on donne le rôle sans toucher au mot de passe existant
        await conn.query('UPDATE users SET role = ?, is_active = 1, token_version = token_version + 1 WHERE id = ?', [a.role, rows[0].id]);
        continue;
      }
      await conn.query(
        'INSERT INTO users (role, first_name, last_name, email, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?, 1)',
        [a.role, a.first_name, '', a.email, a.password_hash]
      );
    }
  }
};
