// Configure l'environnement de test à partir du MySQL éphémère (test/start-db.mjs)
import fs from 'fs';

const db = JSON.parse(fs.readFileSync(new URL(process.env.DB_JSON || './.db.json', import.meta.url), 'utf8'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DB_HOST: '127.0.0.1',
  DB_PORT: String(db.port),
  DB_USER: db.user,
  DB_PASSWORD: '',
  DB_NAME: db.dbName,
  JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
  FRONTEND_URL: 'https://site.test',
  PUBLIC_API_URL: 'https://api.test',
  SCHEDULER_ENABLED: 'false',
  UPLOAD_DIR: 'test/.uploads',
  PAYTECH_API_KEY: process.env.PAYTECH_API_KEY ?? 'test-key',
  PAYTECH_API_SECRET: process.env.PAYTECH_API_SECRET ?? 'test-secret',
  WHATSAPP_APP_SECRET: 'wa-app-secret',
  WHATSAPP_VERIFY_TOKEN: 'wa-verify',
  CRON_SECRET: 'cron-secret',
  SUPER_ADMIN_EMAIL: 'super@studio.test',
  SUPER_ADMIN_PASSWORD: 'SuperPass123',
  ADMIN_EMAIL: 'jeuss@studio.test',
  ADMIN_PASSWORD: 'JeussPass123'
});
