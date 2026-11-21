import { Router } from 'express';
import { q, one } from '../config/db.js';
import { config } from '../config/env.js';
import { ah, badRequest, notFound } from '../lib/http.js';
import { isValidDate, todayStr } from '../lib/time.js';
import { publicSettings, getInt } from '../services/settingsService.js';
import { getDaySlots, getDaysSummary, getOpeningHours } from '../services/availabilityService.js';
import { vapidPublicKey } from '../services/pushService.js';

const router = Router();

export const serializeService = (s) => {
  let features = [];
  try { features = JSON.parse(s.features || '[]'); } catch { features = []; }
  return { ...s, features, is_active: !!s.is_active, is_featured: !!s.is_featured, allow_deposit: !!s.allow_deposit };
};

router.get('/config', ah(async (_req, res) => {
  const hours = await getOpeningHours();
  res.json({
    settings: await publicSettings(),
    openingHours: Object.values(hours),
    googleClientId: config.google.clientId || null,
    vapidPublicKey: vapidPublicKey()
  });
}));

router.get('/services', ah(async (_req, res) => {
  const rows = await q('SELECT * FROM services WHERE is_active = 1 ORDER BY sort_order, id');
  res.json({ services: rows.map(serializeService) });
}));

router.get('/services/:slug', ah(async (req, res) => {
  const s = await one('SELECT * FROM services WHERE slug = ? AND is_active = 1', [req.params.slug]);
  if (!s) throw notFound('Service introuvable');
  res.json({ service: serializeService(s) });
}));

router.get('/equipment', ah(async (req, res) => {
  const featuredOnly = req.query.featured === '1';
  const items = await q(`SELECT id, name, category, description, is_featured, sort_order FROM equipment WHERE is_public = 1 ${featuredOnly ? 'AND is_featured = 1' : ''} ORDER BY sort_order, id`);
  const photos = items.length ? await q('SELECT id, equipment_id, url FROM equipment_photos WHERE equipment_id IN (?) ORDER BY sort_order, id', [items.map((i) => i.id)]) : [];
  res.json({ equipment: items.map((i) => ({ ...i, is_featured: !!i.is_featured, photos: photos.filter((p) => p.equipment_id === i.id) })) });
}));

router.get('/productions', ah(async (req, res) => {
  const featuredOnly = req.query.featured === '1';
  const rows = await q(`SELECT id, title, artist, description, cover_url, audio_url, link_url, platform, release_date, is_featured FROM productions
    WHERE is_public = 1 ${featuredOnly ? 'AND is_featured = 1' : ''} ORDER BY sort_order, id`);
  res.json({ productions: rows.map((p) => ({ ...p, is_featured: !!p.is_featured })) });
}));

router.get('/gallery', ah(async (req, res) => {
  const featuredOnly = req.query.featured === '1';
  const photos = await q(`SELECT id, url, title, description, is_featured, width, height FROM gallery_photos WHERE is_public = 1 ${featuredOnly ? 'AND is_featured = 1' : ''} ORDER BY sort_order, id`);
  res.json({ photos: photos.map((p) => ({ ...p, is_featured: !!p.is_featured })) });
}));

const durationFor = async (serviceId, hours) => {
  const s = await one("SELECT * FROM services WHERE id = ? AND is_active = 1 AND booking_mode = 'slot'", [Number(serviceId)]);
  if (!s) throw badRequest('Service invalide');
  const h = Number(hours) || s.min_hours;
  if (!Number.isInteger(h) || h < s.min_hours || h > s.max_hours) throw badRequest(`Durée invalide (${s.min_hours} à ${s.max_hours} h)`);
  return h;
};

// Jours disponibles
router.get('/availability/days', ah(async (req, res) => {
  const hours = await durationFor(req.query.service_id, req.query.hours);
  const windowDays = await getInt('booking_window_days', 30);
  const from = isValidDate(req.query.from) ? req.query.from : todayStr();
  res.json({ days: await getDaysSummary(from, Math.min(Number(req.query.days) || windowDays, windowDays + 1), hours) });
}));

// Créneaux d'une journée
router.get('/availability/slots', ah(async (req, res) => {
  const hours = await durationFor(req.query.service_id, req.query.hours);
  if (!isValidDate(req.query.date)) throw badRequest('Date invalide');
  res.json({ date: req.query.date, hours, slots: await getDaySlots(req.query.date, hours) });
}));

export default router;
