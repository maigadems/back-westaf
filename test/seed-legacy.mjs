// Recrée une base « ancienne version » (schema.sql d'origine) avec des données
// représentatives, pour vérifier que les migrations préservent tout.
import './env.js';
import mysql from 'mysql2/promise';
import crypto from 'crypto';

const conn = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, database: process.env.DB_NAME, dateStrings: true
});
await conn.query('SET FOREIGN_KEY_CHECKS = 0');
const [tables] = await conn.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
for (const { t } of tables) await conn.query(`DROP TABLE \`${t}\``);
await conn.query('SET FOREIGN_KEY_CHECKS = 1');

await conn.query(`CREATE TABLE reservations (
  id CHAR(36) NOT NULL PRIMARY KEY, nom VARCHAR(255) NOT NULL, email VARCHAR(255) NOT NULL, telephone VARCHAR(50) NOT NULL,
  message TEXT, date_reservation DATE NOT NULL, creneaux TEXT NULL, duree_heures INT NULL, montant_total INT NOT NULL,
  type_paiement ENUM('partiel','total') NOT NULL DEFAULT 'total', montant_paye INT NOT NULL DEFAULT 0,
  statut ENUM('en_attente','confirmee','annulee') NOT NULL DEFAULT 'confirmee', type_service ENUM('horaire','mixage','mastering') NOT NULL,
  nombre_titres INT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_date (date_reservation), INDEX idx_dup (email, date_reservation, type_service)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
await conn.query(`CREATE TABLE clients (telephone VARCHAR(20) NOT NULL PRIMARY KEY, nom VARCHAR(255) NULL, password_hash VARCHAR(255) NOT NULL,
  must_change_password TINYINT(1) NOT NULL DEFAULT 1, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
await conn.query(`CREATE TABLE credential_reveals (reveal_key VARCHAR(64) NOT NULL PRIMARY KEY, telephone VARCHAR(20) NOT NULL,
  password_plain VARCHAR(64) NOT NULL, expires_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

const hash = (p) => { const s = crypto.randomBytes(16); return `${s.toString('hex')}:${crypto.scryptSync(p, s, 64).toString('hex')}`; };
await conn.query('INSERT INTO clients (telephone, nom, password_hash, must_change_password) VALUES (?, ?, ?, 0)', ['771112233', 'Awa Diop', hash('AncienMdp1')]);

const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const past = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
const rows = [
  [crypto.randomUUID(), 'Awa Diop', 'awa@exemple.sn', '+221 77 111 22 33', future, JSON.stringify(['10-11', '11-12']), 2, 60000, 'partiel', 30000, 'confirmee', 'horaire', null],
  [crypto.randomUUID(), 'Moussa Ndiaye', 'moussa@exemple.sn', '78 444 55 66', past, JSON.stringify(['14-15']), 1, 30000, 'total', 30000, 'confirmee', 'horaire', null],
  [crypto.randomUUID(), 'Moussa Ndiaye', 'moussa@exemple.sn', '78 444 55 66', past, null, null, 150000, 'total', 150000, 'confirmee', 'mixage', 1],
  [crypto.randomUUID(), 'Fatou Sow', 'fatou@exemple.sn', '76 000 00 00', future, JSON.stringify(['20-21']), 1, 30000, 'total', 30000, 'annulee', 'horaire', null]
];
for (const r of rows) {
  await conn.query(`INSERT INTO reservations (id, nom, email, telephone, date_reservation, creneaux, duree_heures, montant_total, type_paiement,
    montant_paye, statut, type_service, nombre_titres, message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, '')`, r);
}
console.log('Base historique recréée :', rows.length, 'réservations, 1 client');
await conn.end();
