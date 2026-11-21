// Exécuteur de migrations : chaque migration n'est appliquée qu'une seule fois
// (suivi dans la table schema_migrations). Les migrations n'effacent aucune donnée.
import { pool } from '../config/db.js';
import m001 from './001_base_tables.js';
import m002 from './002_platform_schema.js';
import m003 from './003_backfill_and_seed.js';
import m004 from './004_invoices.js';
import m005 from './005_long_sessions.js';
import m006 from './006_remove_services.js';
import m007 from './007_orders.js';
import m008 from './008_order_addon.js';
import m009 from './009_productions.js';
import m010 from './010_push_subscriptions.js';
import m011 from './011_app_secrets.js';
import m012 from './012_staff_accounts.js';
import m013 from './013_fix_super_admin_email.js';

const MIGRATIONS = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013];

export const helpers = (conn) => ({
  columnExists: async (table, column) => {
    const [r] = await conn.query(
      'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [table, column]
    );
    return r.length > 0;
  },
  indexExists: async (table, index) => {
    const [r] = await conn.query(
      'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
      [table, index]
    );
    return r.length > 0;
  },
  tableExists: async (table) => {
    const [r] = await conn.query(
      'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [table]
    );
    return r.length > 0;
  },
  async addColumn(table, column, definition) {
    if (!(await this.columnExists(table, column))) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  },
  async addIndex(table, index, definition) {
    if (!(await this.indexExists(table, index))) await conn.query(`ALTER TABLE \`${table}\` ADD ${definition}`);
  }
});

export const runMigrations = async ({ log = console.log } = {}) => {
  const conn = await pool.getConnection();
  try {
    await conn.query("SET time_zone = '+00:00'");
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(100) NOT NULL PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    // Verrou pour éviter deux migrations simultanées (plusieurs instances)
    const [[lock]] = await conn.query("SELECT GET_LOCK('westaf_migrations', 60) AS ok");
    if (!lock.ok) throw new Error('Impossible d’obtenir le verrou de migration');
    try {
      const [done] = await conn.query('SELECT id FROM schema_migrations');
      const applied = new Set(done.map((r) => r.id));
      const h = helpers(conn);
      for (const m of MIGRATIONS) {
        if (applied.has(m.id)) continue;
        log(`⏳ Migration ${m.id}…`);
        await m.up(conn, h);
        await conn.query('INSERT INTO schema_migrations (id) VALUES (?)', [m.id]);
        log(`✅ Migration ${m.id} appliquée`);
      }
    } finally {
      await conn.query("SELECT RELEASE_LOCK('westaf_migrations')");
    }
  } finally {
    conn.release();
  }
};
