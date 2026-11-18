import { q } from '../config/db.js';
import { badRequest } from '../lib/http.js';
import { intlPhone } from '../lib/phone.js';

// Clés modifiables depuis l'administration et leur validation
const SCHEMA = {
  studio_name: { type: 'string', max: 100, public: true },
  whatsapp_admin_number: { type: 'phone' },
  contact_phone: { type: 'string', max: 40, public: true },
  contact_phone_2: { type: 'string', max: 40, public: true },
  contact_email: { type: 'string', max: 190, public: true },
  contact_email_2: { type: 'string', max: 190, public: true },
  address: { type: 'string', max: 255, public: true },
  maps_url: { type: 'url', public: true },
  instagram_url: { type: 'url', public: true },
  snapchat_url: { type: 'url', public: true },
  facebook_url: { type: 'url', public: true },
  booking_window_days: { type: 'int', min: 1, max: 365, public: true },
  min_lead_minutes: { type: 'int', min: 0, max: 2880, public: true },
  hold_minutes: { type: 'int', min: 10, max: 180 },
  reminder_minutes_before: { type: 'int', min: 30, max: 2880 },
  payment_link_minutes_before: { type: 'int', min: 1, max: 240 },
  reschedule_limit_minutes: { type: 'int', min: 0, max: 10080, public: true },
  respect_engineer_unavailability: { type: 'bool' },
  notify_engineer_whatsapp: { type: 'bool' },
  invoice_prefix: { type: 'string', max: 8 },
  invoice_company_name: { type: 'string', max: 150 },
  invoice_address: { type: 'string', max: 255 },
  invoice_ninea: { type: 'string', max: 50 },
  invoice_rccm: { type: 'string', max: 50 },
  invoice_footer: { type: 'string', max: 500 }
};

let cache = null;
let cacheAt = 0;

export const getSettings = async () => {
  if (cache && Date.now() - cacheAt < 15000) return cache;
  const rows = await q('SELECT skey, svalue FROM settings');
  cache = Object.fromEntries(rows.map((r) => [r.skey, r.svalue]));
  cacheAt = Date.now();
  return cache;
};

export const getSetting = async (key, def = null) => {
  const s = await getSettings();
  return s[key] ?? def;
};

export const getInt = async (key, def) => {
  const n = Number(await getSetting(key, def));
  return Number.isFinite(n) ? n : def;
};

export const publicSettings = async () => {
  const s = await getSettings();
  return Object.fromEntries(Object.entries(SCHEMA).filter(([, d]) => d.public).map(([k]) => [k, s[k] ?? null]));
};

export const updateSettings = async (input) => {
  const updates = {};
  for (const [key, raw] of Object.entries(input || {})) {
    const def = SCHEMA[key];
    if (!def) continue;
    let v = raw === null || raw === undefined ? '' : String(raw).trim();
    if (def.type === 'int') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < def.min || n > def.max) throw badRequest(`Valeur invalide pour « ${key} » (${def.min}–${def.max})`);
      v = String(n);
    } else if (def.type === 'bool') {
      v = raw === true || v === '1' || v === 'true' ? '1' : '0';
    } else if (def.type === 'phone') {
      const p = intlPhone(v);
      if (!p) throw badRequest('Numéro WhatsApp invalide (format international, ex : +221 77 860 04 82)');
      v = p;
    } else if (def.type === 'url') {
      if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw badRequest(`URL invalide pour « ${key} »`);
    } else if (v.length > def.max) {
      throw badRequest(`« ${key} » trop long`);
    }
    updates[key] = v;
  }
  for (const [k, v] of Object.entries(updates)) {
    await q('INSERT INTO settings (skey, svalue) VALUES (?, ?) ON DUPLICATE KEY UPDATE svalue = VALUES(svalue)', [k, v]);
  }
  cache = null;
  return getSettings();
};

export const clearSettingsCache = () => {
  cache = null;
};
