// Productions du studio (derniers sons) : gérées par Jeuss, affichées sur l'accueil.
// Reprise des 3 titres déjà présents sur le site (liens Apple Music).
const TRACKS = [
  ['Fatou Sangaré', 'Westaf Studio Production', 'https://music.apple.com/fr/song/fatou-sangar%C3%A9/1785404198'],
  ['Comme ni nga ma (feat. Astar)', 'Westaf Studio', 'https://music.apple.com/fr/song/comme-ni-nga-ma-feat-astar/1774053167'],
  ['Damalay bëgg', 'Westaf Studio', 'https://music.apple.com/fr/song/damalay-b%C3%ABgg/1813891527']
];

export default {
  id: '009_productions',
  async up(conn) {
    await conn.query(`CREATE TABLE IF NOT EXISTS productions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(150) NOT NULL,
      artist VARCHAR(150) NULL,
      description TEXT NULL,
      cover_url VARCHAR(500) NULL,
      audio_url VARCHAR(500) NULL,
      link_url VARCHAR(500) NULL,
      platform VARCHAR(30) NULL,
      release_date DATE NULL,
      is_public TINYINT(1) NOT NULL DEFAULT 1,
      is_featured TINYINT(1) NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_productions_public (is_public, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.query("INSERT IGNORE INTO settings (skey, svalue) VALUES ('productions_playlist_url', 'https://music.apple.com/fr/playlist/mbalax/pl.u-oZyllYaIRWNp6r8')");
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM productions');
    if (!Number(n)) {
      let i = 0;
      for (const [title, artist, link] of TRACKS) {
        await conn.query('INSERT INTO productions (title, artist, link_url, platform, is_public, is_featured, sort_order) VALUES (?, ?, ?, ?, 1, 1, ?)', [title, artist, link, 'apple_music', i++]);
      }
    }
  }
};
