import dotenv from 'dotenv';

dotenv.config();

// Fuseau du studio (Dakar = UTC+0). Toutes les dates SQL sont en heure locale du studio.
process.env.TZ = process.env.TZ || 'Africa/Dakar';

const list = (v, def = '') => String(v ?? def).split(',').map((s) => s.trim()).filter(Boolean);
const trimSlash = (u) => String(u || '').replace(/\/+$/, '');
// Première URL valide (tolère une valeur mal saisie du type « https://a.comhttps://a.com/ »)
const firstUrl = (v) => { const m = String(v || '').match(/https?:\/\/.*?(?=https?:\/\/|$)/); return m ? m[0].trim() : ''; };
const PROD_SITE = 'https://westafrecords.com';
const PROD_API = 'https://forestgreen-mole-128636.hostingersite.com';
// Valeur d'exemple jamais remplacée dans un ancien .env
const real = (v) => (v && !/votre-domaine|exemple\.com/.test(v) ? v : '');

export const config = {
  port: Number(process.env.PORT) || 5000,
  nodeEnv: process.env.NODE_ENV || 'production',
  frontendUrl: trimSlash(firstUrl(process.env.FRONTEND_URL) || PROD_SITE),
  publicApiUrl: trimSlash(real(process.env.PUBLIC_API_URL) || (process.env.NODE_ENV === 'test' ? '' : PROD_API)),
  // Origines de l'ancien .env + adresses du site toujours autorisées
  corsOrigins: [...new Set([...list(process.env.CORS_ORIGINS), PROD_SITE, 'https://www.westafrecords.com', 'https://harmonious-florentine-0eff6a.netlify.app'])],
  // Clé des sessions : JWT_SECRET ou ancienne ADMIN_TOKEN_SECRET si assez longue ; sinon générée au démarrage (app_secrets)
  jwtSecret: process.env.JWT_SECRET || process.env.ADMIN_TOKEN_SECRET || '',
  jwtTtl: process.env.JWT_TTL || '7d',
  staffJwtTtl: process.env.STAFF_JWT_TTL || '12h',
  autoMigrate: process.env.AUTO_MIGRATE !== 'false',
  schedulerEnabled: process.env.SCHEDULER_ENABLED !== 'false',
  cronSecret: process.env.CRON_SECRET || '',
  uploadDir: process.env.UPLOAD_DIR || 'uploads',

  google: { clientId: process.env.GOOGLE_CLIENT_ID || '' },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : (Number(process.env.SMTP_PORT) || 465) === 465,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || ''
  },

  paytech: {
    baseUrl: process.env.PAYTECH_BASE_URL || 'https://paytech.sn/api',
    apiKey: process.env.PAYTECH_API_KEY || '',
    apiSecret: process.env.PAYTECH_API_SECRET || '',
    env: process.env.PAYTECH_ENV || 'prod',
    ipnUrl: real(process.env.PAYTECH_IPN_URL),
    refundNotifUrl: process.env.PAYTECH_REFUND_NOTIF_URL || '',
    currency: process.env.CURRENCY || 'XOF'
  },

  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    lang: process.env.WHATSAPP_TEMPLATE_LANG || 'fr',
    templates: {
      adminAlert: process.env.WA_TPL_ADMIN_ALERT || 'studio_alerte_admin',
      clientUpdate: process.env.WA_TPL_CLIENT_UPDATE || 'studio_info_client',
      reminder: process.env.WA_TPL_REMINDER || 'studio_rappel_session',
      paymentLink: process.env.WA_TPL_PAYMENT_LINK || 'studio_lien_paiement'
    }
  },

  bootstrap: {
    superAdminEmail: process.env.SUPER_ADMIN_EMAIL || '',
    superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || '',
    adminEmail: process.env.ADMIN_EMAIL || '',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    // Identifiants admin de l'ancien serveur (déjà présents sur Hostinger)
    legacyLogin: process.env.ADMIN_LOGIN || '',
    adminFirstName: process.env.ADMIN_FIRST_NAME || 'Jeuss'
  }
};

export const paytechConfigured = () => !!(config.paytech.apiKey && config.paytech.apiSecret);
export const whatsappConfigured = () => !!(config.whatsapp.token && config.whatsapp.phoneNumberId);
export const smtpConfigured = () => !!(config.smtp.host && config.smtp.user && config.smtp.pass);
