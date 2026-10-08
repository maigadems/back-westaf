import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

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
  connectionLimit: 5,
  charset: 'utf8mb4',
  // DATE / TIMESTAMP renvoyés en chaînes (YYYY-MM-DD, YYYY-MM-DD HH:MM:SS)
  dateStrings: true,
  timezone: 'Z'
});

console.log('✅ Pool MySQL initialisé');
