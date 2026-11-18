// npm run migrate — applique les migrations en attente puis quitte
import '../config/env.js';
import { pool } from '../config/db.js';
import { runMigrations } from '../migrations/index.js';

try {
  await runMigrations();
  console.log('✅ Base de données à jour');
} catch (e) {
  console.error('❌ Migration échouée :', e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
