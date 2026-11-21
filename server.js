// === Westaf Records — API de gestion du studio ===
import { config, paytechConfigured, smtpConfigured, whatsappConfigured } from './config/env.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { pool } from './config/db.js';
import { runMigrations } from './migrations/index.js';
import { errorHandler, ah, badRequest } from './lib/http.js';
import { isValidDate, rangeToLegacySlots } from './lib/time.js';
import { uploadRoot } from './services/mediaService.js';
import { startScheduler } from './services/scheduler.js';
import { bootstrapAccounts } from './scripts/bootstrap.js';
import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import clientRoutes from './routes/client.js';
import actionRoutes from './routes/actions.js';
import adminRoutes from './routes/admin.js';
import { clearPublicCache } from './routes/public.js';
import engineerRoutes from './routes/engineer.js';
import webhookRoutes from './routes/webhooks.js';
import crypto from 'crypto';
import { getOrCreateSecret } from './services/secretService.js';
import { initPush } from './services/pushService.js';


export const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin: config.corsOrigins,
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition'],
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']
}));
// rawBody conservé pour vérifier la signature des webhooks WhatsApp
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
if (config.nodeEnv !== 'test') app.use(morgan('tiny'));

// Images importées (lisibles depuis le site, hébergé sur un autre domaine)
app.use('/uploads', (_req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(uploadRoot, { maxAge: '30d', immutable: true, fallthrough: false }));

app.use('/auth', authRoutes);
app.use('/public', publicRoutes);
app.use('/client', clientRoutes);
app.use('/actions', actionRoutes);
// Toute modification dans l'administration rafraîchit les données publiques en cache
app.use('/admin', (req, res, next) => {
  if (req.method !== 'GET') { clearPublicCache(); res.on('finish', clearPublicCache); }
  next();
});
app.use('/admin', adminRoutes);
app.use('/engineer', engineerRoutes);
app.use('/', webhookRoutes);

// Compatibilité : ancienne route publique des créneaux occupés (format "08-09")
app.get('/reservations/slots', ah(async (req, res) => {
  if (!isValidDate(req.query.date)) throw badRequest('Date invalide');
  const [rows] = await pool.query(
    "SELECT r.start_at, r.end_at FROM reservations r WHERE r.start_at IS NOT NULL AND DATE(r.start_at) = ? AND r.statut IN ('confirmee','en_attente')",
    [req.query.date]
  );
  res.json({ slots: rows.flatMap((r) => rangeToLegacySlots(r.start_at, r.end_at)) });
}));

app.get('/health', ah(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    integrations: { paytech: paytechConfigured(), whatsapp: whatsappConfigured(), smtp: smtpConfigured(), google: !!config.google.clientId }
  });
}));

app.use((req, res) => res.status(404).json({ error: true, message: 'Route non trouvée' }));
app.use(errorHandler);

export const start = async () => {
  if (config.autoMigrate) await runMigrations();
  // Secrets absents ou trop courts dans l'environnement : générés une fois et conservés en base
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    config.jwtSecret = await getOrCreateSecret('jwt_secret', () => crypto.randomBytes(48).toString('hex'));
  }
  await initPush();
  await bootstrapAccounts();
  startScheduler();
  return new Promise((resolve) => {
    const server = app.listen(config.port, () => {
      console.log(`🚀 API démarrée sur le port ${config.port}`);
      const missing = [];
      if (!paytechConfigured()) missing.push('PayTech');
      if (!whatsappConfigured()) missing.push('WhatsApp Cloud API');
      if (!smtpConfigured()) missing.push('SMTP (e-mails)');
      if (!config.google.clientId) missing.push('Google OAuth');
      if (missing.length) console.warn(`⚠️  Intégrations non configurées : ${missing.join(', ')}`);
      resolve(server);
    });
  });
};

if (process.env.NODE_ENV !== 'test') {
  start().catch((e) => {
    console.error('❌ Démarrage impossible :', e);
    process.exit(1);
  });
}
