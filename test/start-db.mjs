// Démarre un MySQL éphémère pour les tests et écrit ses coordonnées dans test/.db.json
import { createDB } from 'mysql-memory-server';
import fs from 'fs';
const db = await createDB({ version: '8.4.x', dbName: 'westaf_test', logLevel: 'WARN' });
fs.writeFileSync(new URL(process.env.DB_JSON || './.db.json', import.meta.url), JSON.stringify({ port: db.port, user: db.username, dbName: db.dbName }));
console.log('MYSQL READY', db.port);
process.on('SIGTERM', async () => { await db.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
