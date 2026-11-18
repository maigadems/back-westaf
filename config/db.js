import mysql from 'mysql2/promise';
import './env.js';

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;

if (!DB_HOST || !DB_USER || !DB_NAME) {
  console.error('❌ Variables MySQL manquantes (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)');
  process.exit(1);
}

export const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT) || 3306,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 8,
  charset: 'utf8mb4',
  // DATE / DATETIME renvoyés en chaînes (YYYY-MM-DD, YYYY-MM-DD HH:MM:SS)
  dateStrings: true,
  timezone: 'Z'
});

// Les sessions MySQL travaillent en UTC (= heure de Dakar)
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

export const q = async (sql, params = []) => {
  const [rows] = await pool.query(sql, params);
  return rows;
};

export const one = async (sql, params = []) => (await q(sql, params))[0] || null;

// Exécute fn(conn) dans une transaction
export const tx = async (fn) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
};
