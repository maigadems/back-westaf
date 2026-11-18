// Administration : Jeuss (admin) et super administrateur. Accès complet, y compris finances.
import { Router } from 'express';
import { q, one, pool } from '../config/db.js';
import { config, paytechConfigured, smtpConfigured, whatsappConfigured } from '../config/env.js';
import { ah, badRequest, bool, conflict, email as vEmail, forbidden, int, notFound, str } from '../lib/http.js';
import { generatePassword, randomToken, sha256, validateNewPassword } from '../lib/password.js';
import { intlPhone } from '../lib/phone.js';
import { isValidDate, isValidDateTime, normDateTime } from '../lib/time.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  adminCreateBooking, adminUpdateReservation, assignEngineer, cancelReservation, forAdmin, getReservation, listReservations,
  rescheduleReservation, setSessionStatus, validateCashPayment
} from '../services/reservationService.js';
import { getHistory } from '../services/historyService.js';
import { dashboardStats } from '../services/statsService.js';
import { listPayments } from '../services/paymentService.js';
import { listNotifications, markRead } from '../services/notificationService.js';
import { listMessages, sendTemplate } from '../services/whatsappService.js';
import { getSettings, updateSettings } from '../services/settingsService.js';
import { getDaySlots, getOpeningHours, saveOpeningHours } from '../services/availabilityService.js';
import { canManageRole, createUser, deleteUserByAdmin, findUserById, listUsers, publicUser, setUserPassword, updateUserByAdmin } from '../services/userService.js';
import { sendPasswordResetEmail } from '../services/emailService.js';
import { imageUpload, publicPathFor, removeUpload } from '../services/mediaService.js';
import { serializeService } from './public.js';
import { getInvoice, issueManually, listInvoices } from '../services/invoiceService.js';
import { invoiceFilename, renderInvoicePdf } from '../services/invoicePdf.js';

const router = Router();
router.use(requireAdmin);

const load = async (id) => {
  const r = await getReservation(id);
  if (!r) throw notFound('Réservation introuvable');
  return r;
};

// ---------------------------------------------------------------- Tableau de bord
router.get('/dashboard', ah(async (_req, res) => res.json(await dashboardStats({ finance: true }))));

// ---------------------------------------------------------------- Réservations
router.get('/reservations', ah(async (req, res) => {
  const f = req.query;
  res.json({
    reservations: (await listReservations({
      search: f.search, statut: f.statut, serviceId: f.service_id, paymentStatus: f.payment_status, engineerId: f.engineer_id,
      from: isValidDate(f.from) ? f.from : undefined, to: isValidDate(f.to) ? f.to : undefined, order: f.order, includeHolds: f.include_holds === '1'
    })).map(forAdmin)
  });
}));

router.post('/reservations', ah(async (req, res) => res.status(201).json({ reservation: await adminCreateBooking(req.user, req.body || {}) })));

router.get('/calendar', ah(async (req, res) => {
  const { from, to } = req.query;
  if (!isValidDate(from) || !isValidDate(to)) throw badRequest('Période invalide');
  const [reservations, closures, unavailability] = await Promise.all([
    listReservations({ from, to, order: 'asc', includeHolds: true }),
    q('SELECT * FROM closures WHERE start_at <= ? AND end_at >= ? ORDER BY start_at', [`${to} 23:59:59`, `${from} 00:00:00`]),
    q(`SELECT u.*, TRIM(CONCAT(e.first_name,' ',e.last_name)) AS engineer_name FROM engineer_unavailability u JOIN users e ON e.id = u.user_id
       WHERE u.start_at <= ? AND u.end_at >= ? ORDER BY u.start_at`, [`${to} 23:59:59`, `${from} 00:00:00`])
  ]);
  res.json({ reservations: reservations.filter((r) => r.start_at && r.statut !== 'expiree'), closures, unavailability });
}));

router.get('/reservations/:id', ah(async (req, res) => {
  const r = await load(req.params.id);
  const [history, payments, messages] = await Promise.all([
    getHistory(r.id),
    q(`SELECT p.*, TRIM(CONCAT(COALESCE(v.first_name,''),' ',COALESCE(v.last_name,''))) AS validated_by_name
       FROM payments p LEFT JOIN users v ON v.id = p.validated_by WHERE p.reservation_id = ? ORDER BY p.id DESC`, [r.id]),
    listMessages({ reservationId: r.id, limit: 50 })
  ]);
  const invoice = await one('SELECT id, number FROM invoices WHERE reservation_id = ?', [r.id]);
  res.json({ reservation: r, history, payments, messages, invoice });
}));

router.patch('/reservations/:id', ah(async (req, res) => res.json({ reservation: await adminUpdateReservation(await load(req.params.id), req.body || {}, req.user) })));

router.post('/reservations/:id/cancel', ah(async (req, res) => {
  res.json({ reservation: await cancelReservation(await load(req.params.id), req.user, str(req.body?.reason, { max: 255 }) || '') });
}));

router.post('/reservations/:id/reschedule', ah(async (req, res) => {
  res.json({ reservation: await rescheduleReservation(await load(req.params.id), req.body?.start, req.user, { enforceClientRules: false }) });
}));

router.get('/reservations/:id/availability', ah(async (req, res) => {
  const r = await load(req.params.id);
  if (!isValidDate(req.query.date)) throw badRequest('Date invalide');
  const hours = Number(req.query.hours) || r.duree_heures || 1;
  res.json({ slots: await getDaySlots(req.query.date, hours, { excludeReservationId: r.id, ignoreLeadTime: true, ignoreWindow: true }) });
}));

router.get('/availability', ah(async (req, res) => {
  if (!isValidDate(req.query.date)) throw badRequest('Date invalide');
  res.json({ slots: await getDaySlots(req.query.date, Number(req.query.hours) || 1, { ignoreLeadTime: true, ignoreWindow: true }) });
}));

router.post('/reservations/:id/assign', ah(async (req, res) => {
  const id = req.body?.engineer_id ? Number(req.body.engineer_id) : null;
  res.json({ reservation: await assignEngineer(await load(req.params.id), id, req.user) });
}));

router.post('/reservations/:id/validate-cash', ah(async (req, res) => res.json({ reservation: await validateCashPayment(await load(req.params.id), req.user) })));

router.post('/reservations/:id/session-status', ah(async (req, res) => {
  res.json({ reservation: await setSessionStatus(await load(req.params.id), req.body?.status, req.user) });
}));

// Suppression réservée aux réservations annulées / expirées sans paiement encaissé
router.delete('/reservations/:id', ah(async (req, res) => {
  const r = await load(req.params.id);
  if (!['annulee', 'expiree'].includes(r.statut)) throw badRequest('Annulez d’abord la réservation (les réservations actives ne peuvent pas être supprimées)');
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM payments WHERE reservation_id = ? AND status = 'completed'", [r.id]);
  if (Number(n) > 0) throw conflict('Cette réservation comporte un paiement encaissé : elle est conservée pour la comptabilité');
  await q('DELETE FROM slot_locks WHERE reservation_id = ?', [r.id]);
  await q('DELETE FROM reservations WHERE id = ?', [r.id]);
  res.json({ success: true });
}));

// ---------------------------------------------------------------- Factures
router.get('/invoices', ah(async (req, res) => {
  const f = req.query;
  res.json({ invoices: await listInvoices({ search: f.search, status: f.status, from: isValidDate(f.from) ? f.from : undefined, to: isValidDate(f.to) ? f.to : undefined }) });
}));
router.get('/invoices/:id', ah(async (req, res) => res.json({ invoice: await getInvoice(req.params.id) })));
router.get('/invoices/:id/pdf', ah(async (req, res) => {
  const inv = await getInvoice(req.params.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoiceFilename(inv)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  renderInvoicePdf(inv, res);
}));
router.post('/reservations/:id/invoice', ah(async (req, res) => {
  const r = await load(req.params.id);
  res.json({ invoice: await getInvoice(await issueManually(r.id)) });
}));

// ---------------------------------------------------------------- Paiements
router.get('/payments', ah(async (req, res) => res.json({ payments: await listPayments({ status: req.query.status, method: req.query.method }) })));

// ---------------------------------------------------------------- Notifications
router.get('/notifications', ah(async (req, res) => res.json(await listNotifications(req.user, { unreadOnly: req.query.unread === '1' }))));
router.post('/notifications/read', ah(async (req, res) => {
  await markRead(req.user, req.body?.ids === 'all' ? 'all' : req.body?.ids);
  res.json({ success: true });
}));

// ---------------------------------------------------------------- Clients
router.get('/clients', ah(async (req, res) => {
  const rows = await listUsers({ role: 'client', search: req.query.search, active: req.query.active });
  const totals = await q("SELECT r.user_id, COALESCE(SUM(p.amount),0) AS paid FROM payments p JOIN reservations r ON r.id = p.reservation_id WHERE p.status = 'completed' GROUP BY r.user_id");
  const paid = Object.fromEntries(totals.map((t) => [t.user_id, Number(t.paid)]));
  res.json({ clients: rows.map((u) => ({ ...publicUser(u), nb_reservations: Number(u.nb_reservations), derniere_session: u.derniere_session, total_paye: paid[u.id] || 0 })) });
}));

router.get('/clients/:id', ah(async (req, res) => {
  const u = await findUserById(req.params.id);
  if (!u || u.role !== 'client') throw notFound('Client introuvable');
  res.json({ client: publicUser(u), reservations: await listReservations({ userId: u.id, includeHolds: true }) });
}));

router.patch('/clients/:id', ah(async (req, res) => {
  const u = await findUserById(req.params.id);
  if (!u || u.role !== 'client') throw notFound('Client introuvable');
  res.json({ client: publicUser(await updateUserByAdmin(req.user, u.id, cleanUserInput(req.body, { allowRole: false }))) });
}));

// Envoie au client un lien sécurisé pour définir lui-même son mot de passe
router.post('/clients/:id/send-reset-link', ah(async (req, res) => {
  const u = await findUserById(req.params.id);
  if (!u || u.role !== 'client' || !u.email) throw badRequest('Ce client n’a pas d’adresse e-mail');
  const token = randomToken(32);
  await q('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL 1 HOUR)', [u.id, sha256(token)]);
  const r = await sendPasswordResetEmail(u, `${config.frontendUrl}/reinitialiser-mot-de-passe?token=${token}`);
  if (!r.sent) throw badRequest(r.reason === 'smtp_not_configured' ? 'L’envoi d’e-mails (SMTP) n’est pas configuré' : 'Échec de l’envoi de l’e-mail');
  res.json({ success: true });
}));

// ---------------------------------------------------------------- Équipe (ingénieurs, administrateurs)
const cleanUserInput = (b = {}, { allowRole = true } = {}) => {
  const out = {};
  if (b.first_name !== undefined) out.first_name = str(b.first_name, { field: 'prénom', required: true, max: 100 });
  if (b.last_name !== undefined) out.last_name = str(b.last_name, { field: 'nom', max: 100 }) || '';
  if (b.email !== undefined) out.email = vEmail(b.email);
  if (b.phone !== undefined) {
    out.phone = b.phone ? intlPhone(b.phone) : null;
    if (b.phone && !out.phone) throw badRequest('Téléphone invalide');
  }
  if (b.is_active !== undefined) out.is_active = bool(b.is_active);
  if (allowRole && b.role !== undefined) {
    if (!['super_admin', 'admin', 'engineer'].includes(b.role)) throw badRequest('Rôle invalide');
    out.role = b.role;
  }
  return out;
};

router.get('/users', ah(async (req, res) => {
  const roles = req.query.role ? [req.query.role] : ['super_admin', 'admin', 'engineer'];
  if (roles.some((r) => !['super_admin', 'admin', 'engineer'].includes(r))) throw badRequest('Rôle invalide');
  const rows = await listUsers({ role: roles, search: req.query.search });
  res.json({ users: rows.map((u) => ({ ...publicUser(u), nb_sessions_a_venir: Number(u.nb_sessions_a_venir) })) });
}));

router.post('/users', ah(async (req, res) => {
  const input = cleanUserInput(req.body);
  if (!input.role) throw badRequest('Rôle requis');
  if (!input.email || !input.first_name) throw badRequest('Prénom et e-mail requis');
  if (!canManageRole(req.user, input.role)) throw forbidden('Seul le super administrateur peut créer des administrateurs');
  let password = req.body?.password ? String(req.body.password) : null;
  let generated = false;
  if (password) {
    const err = validateNewPassword(password);
    if (err) throw badRequest(err);
  } else {
    password = generatePassword();
    generated = true;
  }
  const user = await createUser({ ...input, password, must_change_password: 1 });
  // Le mot de passe provisoire n'est renvoyé qu'une seule fois, à communiquer à la personne
  res.status(201).json({ user: publicUser(user), temporaryPassword: generated ? password : undefined });
}));

router.patch('/users/:id', ah(async (req, res) => res.json({ user: publicUser(await updateUserByAdmin(req.user, Number(req.params.id), cleanUserInput(req.body))) })));

router.delete('/users/:id', ah(async (req, res) => {
  await deleteUserByAdmin(req.user, Number(req.params.id));
  res.json({ success: true });
}));

router.post('/users/:id/reset-password', ah(async (req, res) => {
  const u = await findUserById(req.params.id);
  if (!u || u.role === 'client') throw notFound('Compte introuvable');
  if (!canManageRole(req.user, u.role) || u.id === req.user.id) throw forbidden();
  const password = generatePassword();
  await setUserPassword(u.id, password, { mustChange: 1 });
  res.json({ temporaryPassword: password });
}));

// Absences des ingénieurs
router.get('/unavailability', ah(async (req, res) => {
  res.json({
    unavailability: await q(
      `SELECT u.*, TRIM(CONCAT(e.first_name,' ',e.last_name)) AS engineer_name FROM engineer_unavailability u JOIN users e ON e.id = u.user_id
       WHERE u.end_at >= UTC_TIMESTAMP() ${req.query.user_id ? 'AND u.user_id = ?' : ''} ORDER BY u.start_at`,
      req.query.user_id ? [Number(req.query.user_id)] : []
    )
  });
}));

router.post('/unavailability', ah(async (req, res) => {
  const { user_id, start_at, end_at, reason } = req.body || {};
  const eng = await one("SELECT id FROM users WHERE id = ? AND role = 'engineer'", [Number(user_id)]);
  if (!eng) throw badRequest('Ingénieur invalide');
  if (!isValidDateTime(start_at) || !isValidDateTime(end_at) || normDateTime(start_at) >= normDateTime(end_at)) throw badRequest('Période invalide');
  await q('INSERT INTO engineer_unavailability (user_id, start_at, end_at, reason) VALUES (?, ?, ?, ?)', [eng.id, normDateTime(start_at), normDateTime(end_at), str(reason, { max: 255 })]);
  res.status(201).json({ success: true });
}));

router.delete('/unavailability/:id', ah(async (req, res) => {
  await q('DELETE FROM engineer_unavailability WHERE id = ?', [Number(req.params.id)]);
  res.json({ success: true });
}));

// ---------------------------------------------------------------- Services
const serviceInput = (b = {}) => {
  const out = {};
  if (b.name !== undefined) out.name = str(b.name, { field: 'nom', required: true, max: 150 });
  if (b.slug !== undefined) {
    out.slug = String(b.slug || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    if (!out.slug) throw badRequest('Identifiant d’URL invalide');
  }
  if (b.tagline !== undefined) out.tagline = str(b.tagline, { max: 255 });
  if (b.description !== undefined) out.description = str(b.description, { max: 5000 });
  if (b.booking_mode !== undefined) {
    if (!['slot', 'per_track', 'quote'].includes(b.booking_mode)) throw badRequest('Mode de réservation invalide');
    out.booking_mode = b.booking_mode;
  }
  if (b.price !== undefined) out.price = b.price === '' || b.price === null ? null : int(b.price, { min: 0, max: 100000000, field: 'tarif' });
  if (b.price_unit !== undefined) out.price_unit = str(b.price_unit, { max: 30 });
  if (b.min_hours !== undefined) out.min_hours = int(b.min_hours, { min: 1, max: 16, field: 'durée minimale' });
  if (b.max_hours !== undefined) out.max_hours = int(b.max_hours, { min: 1, max: 16, field: 'durée maximale' });
  if (b.allow_deposit !== undefined) out.allow_deposit = bool(b.allow_deposit) ? 1 : 0;
  if (b.deposit_percent !== undefined) out.deposit_percent = int(b.deposit_percent, { min: 1, max: 100, field: 'acompte' });
  if (b.features !== undefined) {
    const list = Array.isArray(b.features) ? b.features : String(b.features || '').split('\n');
    out.features = JSON.stringify(list.map((f) => String(f).trim()).filter(Boolean).slice(0, 20));
  }
  if (b.is_active !== undefined) out.is_active = bool(b.is_active) ? 1 : 0;
  if (b.is_featured !== undefined) out.is_featured = bool(b.is_featured) ? 1 : 0;
  if (b.sort_order !== undefined) out.sort_order = int(b.sort_order, { min: 0, max: 10000 }) ?? 0;
  if (out.min_hours && out.max_hours && out.min_hours > out.max_hours) throw badRequest('Durée minimale supérieure à la durée maximale');
  return out;
};

const updateRow = async (table, id, fields) => {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await q(`UPDATE \`${table}\` SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => fields[k]), id]);
};

router.get('/services', ah(async (_req, res) => {
  const rows = await q(`SELECT s.*, (SELECT COUNT(*) FROM reservations r WHERE r.service_id = s.id) AS nb_reservations FROM services s ORDER BY sort_order, id`);
  res.json({ services: rows.map((s) => ({ ...serializeService(s), nb_reservations: Number(s.nb_reservations) })) });
}));

router.post('/services', ah(async (req, res) => {
  const f = serviceInput({ booking_mode: 'quote', ...req.body, slug: req.body?.slug || req.body?.name });
  if (!f.name) throw badRequest('Nom requis');
  if (f.booking_mode !== 'quote' && !f.price) throw badRequest('Un tarif est requis pour un service réservable en ligne');
  if (await one('SELECT id FROM services WHERE slug = ?', [f.slug])) throw conflict('Un service utilise déjà cet identifiant');
  const keys = Object.keys(f);
  const [r] = await pool.query(`INSERT INTO services (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => f[k]));
  res.status(201).json({ service: serializeService(await one('SELECT * FROM services WHERE id = ?', [r.insertId])) });
}));

router.patch('/services/:id', ah(async (req, res) => {
  const s = await one('SELECT * FROM services WHERE id = ?', [Number(req.params.id)]);
  if (!s) throw notFound('Service introuvable');
  const f = serviceInput(req.body);
  if (f.slug && f.slug !== s.slug && (await one('SELECT id FROM services WHERE slug = ? AND id <> ?', [f.slug, s.id]))) throw conflict('Identifiant déjà utilisé');
  const mode = f.booking_mode || s.booking_mode;
  const price = f.price !== undefined ? f.price : s.price;
  if (mode !== 'quote' && !price) throw badRequest('Un tarif est requis pour un service réservable en ligne');
  await updateRow('services', s.id, f);
  res.json({ service: serializeService(await one('SELECT * FROM services WHERE id = ?', [s.id])) });
}));

router.delete('/services/:id', ah(async (req, res) => {
  const s = await one('SELECT * FROM services WHERE id = ?', [Number(req.params.id)]);
  if (!s) throw notFound('Service introuvable');
  const [{ n }] = await q('SELECT COUNT(*) AS n FROM reservations WHERE service_id = ?', [s.id]);
  if (Number(n) > 0) throw conflict('Ce service est lié à des réservations : désactivez-le plutôt que de le supprimer.');
  await q('DELETE FROM services WHERE id = ?', [s.id]);
  removeUpload(s.image_url);
  res.json({ success: true });
}));

router.post('/services/:id/image', imageUpload.single('image'), ah(async (req, res) => {
  const s = await one('SELECT * FROM services WHERE id = ?', [Number(req.params.id)]);
  if (!s) throw notFound('Service introuvable');
  if (!req.file) throw badRequest('Image manquante');
  const url = publicPathFor(req.file);
  await q('UPDATE services SET image_url = ? WHERE id = ?', [url, s.id]);
  removeUpload(s.image_url);
  res.json({ image_url: url });
}));

router.delete('/services/:id/image', ah(async (req, res) => {
  const s = await one('SELECT * FROM services WHERE id = ?', [Number(req.params.id)]);
  if (!s) throw notFound('Service introuvable');
  await q('UPDATE services SET image_url = NULL WHERE id = ?', [s.id]);
  removeUpload(s.image_url);
  res.json({ success: true });
}));

// ---------------------------------------------------------------- Équipements
const equipmentInput = (b = {}) => {
  const out = {};
  if (b.name !== undefined) out.name = str(b.name, { field: 'nom', required: true, max: 150 });
  if (b.category !== undefined) out.category = str(b.category, { max: 80 });
  if (b.description !== undefined) out.description = str(b.description, { max: 5000 });
  if (b.is_public !== undefined) out.is_public = bool(b.is_public) ? 1 : 0;
  if (b.is_featured !== undefined) out.is_featured = bool(b.is_featured) ? 1 : 0;
  if (b.sort_order !== undefined) out.sort_order = int(b.sort_order, { min: 0, max: 100000 }) ?? 0;
  return out;
};

const equipmentWithPhotos = async (id) => {
  const e = await one('SELECT * FROM equipment WHERE id = ?', [id]);
  if (!e) return null;
  return { ...e, is_public: !!e.is_public, is_featured: !!e.is_featured, photos: await q('SELECT * FROM equipment_photos WHERE equipment_id = ? ORDER BY sort_order, id', [id]) };
};

router.get('/equipment', ah(async (_req, res) => {
  const items = await q('SELECT * FROM equipment ORDER BY sort_order, id');
  const photos = await q('SELECT * FROM equipment_photos ORDER BY sort_order, id');
  res.json({ equipment: items.map((e) => ({ ...e, is_public: !!e.is_public, is_featured: !!e.is_featured, photos: photos.filter((p) => p.equipment_id === e.id) })) });
}));

router.post('/equipment', imageUpload.array('photos', 12), ah(async (req, res) => {
  const f = equipmentInput(req.body);
  if (!f.name) throw badRequest('Nom requis');
  if (f.sort_order === undefined) f.sort_order = Number((await one('SELECT COALESCE(MAX(sort_order),0) + 1 AS n FROM equipment')).n);
  const keys = Object.keys(f);
  const [r] = await pool.query(`INSERT INTO equipment (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => f[k]));
  let i = 0;
  for (const file of req.files || []) await q('INSERT INTO equipment_photos (equipment_id, url, sort_order) VALUES (?, ?, ?)', [r.insertId, publicPathFor(file), i++]);
  res.status(201).json({ equipment: await equipmentWithPhotos(r.insertId) });
}));

router.patch('/equipment/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await one('SELECT id FROM equipment WHERE id = ?', [id]))) throw notFound('Équipement introuvable');
  await updateRow('equipment', id, equipmentInput(req.body));
  res.json({ equipment: await equipmentWithPhotos(id) });
}));

router.delete('/equipment/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const photos = await q('SELECT url FROM equipment_photos WHERE equipment_id = ?', [id]);
  await q('DELETE FROM equipment WHERE id = ?', [id]);
  photos.forEach((p) => removeUpload(p.url));
  res.json({ success: true });
}));

router.post('/equipment/:id/photos', imageUpload.array('photos', 12), ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await one('SELECT id FROM equipment WHERE id = ?', [id]))) throw notFound('Équipement introuvable');
  if (!req.files?.length) throw badRequest('Aucune image reçue');
  // replace=1 : remplace toutes les photos existantes
  if (req.body?.replace === '1') {
    const old = await q('SELECT url FROM equipment_photos WHERE equipment_id = ?', [id]);
    await q('DELETE FROM equipment_photos WHERE equipment_id = ?', [id]);
    old.forEach((p) => removeUpload(p.url));
  }
  let order = Number((await one('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM equipment_photos WHERE equipment_id = ?', [id])).n);
  for (const file of req.files) await q('INSERT INTO equipment_photos (equipment_id, url, sort_order) VALUES (?, ?, ?)', [id, publicPathFor(file), order++]);
  res.json({ equipment: await equipmentWithPhotos(id) });
}));

router.delete('/equipment/:id/photos/:photoId', ah(async (req, res) => {
  const p = await one('SELECT * FROM equipment_photos WHERE id = ? AND equipment_id = ?', [Number(req.params.photoId), Number(req.params.id)]);
  if (!p) throw notFound('Photo introuvable');
  await q('DELETE FROM equipment_photos WHERE id = ?', [p.id]);
  removeUpload(p.url);
  res.json({ equipment: await equipmentWithPhotos(Number(req.params.id)) });
}));

const saveOrder = async (table, ids, extraWhere = '', extraParams = []) => {
  if (!Array.isArray(ids)) throw badRequest('Ordre invalide');
  let i = 0;
  for (const id of ids) await q(`UPDATE \`${table}\` SET sort_order = ? WHERE id = ? ${extraWhere}`, [i++, Number(id), ...extraParams]);
};

router.put('/equipment-order', ah(async (req, res) => { await saveOrder('equipment', req.body?.ids); res.json({ success: true }); }));
router.put('/equipment/:id/photos-order', ah(async (req, res) => {
  await saveOrder('equipment_photos', req.body?.ids, 'AND equipment_id = ?', [Number(req.params.id)]);
  res.json({ equipment: await equipmentWithPhotos(Number(req.params.id)) });
}));

// ---------------------------------------------------------------- Galerie
const galleryInput = (b = {}) => {
  const out = {};
  if (b.title !== undefined) out.title = str(b.title, { max: 150 });
  if (b.description !== undefined) out.description = str(b.description, { max: 2000 });
  if (b.is_featured !== undefined) out.is_featured = bool(b.is_featured) ? 1 : 0;
  if (b.is_public !== undefined) out.is_public = bool(b.is_public) ? 1 : 0;
  if (b.width !== undefined) out.width = int(b.width, { min: 1, max: 20000 });
  if (b.height !== undefined) out.height = int(b.height, { min: 1, max: 20000 });
  return out;
};

const galleryRow = (p) => p && { ...p, is_featured: !!p.is_featured, is_public: !!p.is_public };

router.get('/gallery', ah(async (_req, res) => res.json({ photos: (await q('SELECT * FROM gallery_photos ORDER BY sort_order, id')).map(galleryRow) })));

router.post('/gallery', imageUpload.array('photos', 12), ah(async (req, res) => {
  if (!req.files?.length) throw badRequest('Aucune image reçue');
  const base = galleryInput(req.body);
  // Dimensions envoyées par le navigateur pour chaque fichier (utile pour la grille)
  let dims = [];
  try { dims = JSON.parse(req.body?.dimensions || '[]'); } catch { dims = []; }
  let order = Number((await one('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM gallery_photos')).n);
  const created = [];
  for (const [i, file] of req.files.entries()) {
    const d = dims[i] || {};
    const [r] = await pool.query('INSERT INTO gallery_photos (url, title, description, is_featured, is_public, sort_order, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      publicPathFor(file), base.title || null, base.description || null, base.is_featured || 0, base.is_public ?? 1, order++,
      Number.isInteger(d.width) ? d.width : null, Number.isInteger(d.height) ? d.height : null
    ]);
    created.push(r.insertId);
  }
  res.status(201).json({ photos: (await q('SELECT * FROM gallery_photos WHERE id IN (?)', [created])).map(galleryRow) });
}));

router.patch('/gallery/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await one('SELECT id FROM gallery_photos WHERE id = ?', [id]))) throw notFound('Photo introuvable');
  await updateRow('gallery_photos', id, galleryInput(req.body));
  res.json({ photo: galleryRow(await one('SELECT * FROM gallery_photos WHERE id = ?', [id])) });
}));

router.post('/gallery/:id/replace', imageUpload.single('photo'), ah(async (req, res) => {
  const p = await one('SELECT * FROM gallery_photos WHERE id = ?', [Number(req.params.id)]);
  if (!p) throw notFound('Photo introuvable');
  if (!req.file) throw badRequest('Image manquante');
  const url = publicPathFor(req.file);
  await q('UPDATE gallery_photos SET url = ?, width = ?, height = ? WHERE id = ?', [url, Number(req.body?.width) || null, Number(req.body?.height) || null, p.id]);
  removeUpload(p.url);
  res.json({ photo: galleryRow(await one('SELECT * FROM gallery_photos WHERE id = ?', [p.id])) });
}));

router.delete('/gallery/:id', ah(async (req, res) => {
  const p = await one('SELECT * FROM gallery_photos WHERE id = ?', [Number(req.params.id)]);
  if (!p) throw notFound('Photo introuvable');
  await q('DELETE FROM gallery_photos WHERE id = ?', [p.id]);
  removeUpload(p.url);
  res.json({ success: true });
}));

router.put('/gallery-order', ah(async (req, res) => { await saveOrder('gallery_photos', req.body?.ids); res.json({ success: true }); }));

// ---------------------------------------------------------------- Paramètres, horaires, fermetures
router.get('/settings', ah(async (_req, res) => {
  res.json({
    settings: await getSettings(),
    integrations: {
      whatsapp: whatsappConfigured(),
      whatsappWebhook: !!(config.whatsapp.verifyToken && config.whatsapp.appSecret),
      paytech: paytechConfigured(),
      smtp: smtpConfigured(),
      google: !!config.google.clientId,
      templates: config.whatsapp.templates
    }
  });
}));

router.put('/settings', ah(async (req, res) => res.json({ settings: await updateSettings(req.body || {}) })));

router.get('/hours', ah(async (_req, res) => res.json({ hours: Object.values(await getOpeningHours()) })));
router.put('/hours', ah(async (req, res) => res.json({ hours: Object.values(await saveOpeningHours(req.body?.hours)) })));

router.get('/closures', ah(async (_req, res) => res.json({ closures: await q('SELECT * FROM closures WHERE end_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY ORDER BY start_at') })));

router.post('/closures', ah(async (req, res) => {
  const { start_at, end_at, reason } = req.body || {};
  if (!isValidDateTime(start_at) || !isValidDateTime(end_at) || normDateTime(start_at) >= normDateTime(end_at)) throw badRequest('Période invalide');
  const s = normDateTime(start_at), e = normDateTime(end_at);
  // Signale les réservations déjà confirmées sur la période (elles ne sont pas annulées automatiquement)
  const impacted = await q("SELECT id, nom, start_at FROM reservations WHERE statut = 'confirmee' AND start_at < ? AND end_at > ?", [e, s]);
  await q('INSERT INTO closures (start_at, end_at, reason, created_by) VALUES (?, ?, ?, ?)', [s, e, str(reason, { max: 255 }), req.user.id]);
  res.status(201).json({ success: true, impacted });
}));

router.delete('/closures/:id', ah(async (req, res) => {
  await q('DELETE FROM closures WHERE id = ?', [Number(req.params.id)]);
  res.json({ success: true });
}));

// ---------------------------------------------------------------- WhatsApp
router.get('/whatsapp/messages', ah(async (req, res) => res.json({ messages: await listMessages({ limit: Math.min(Number(req.query.limit) || 100, 500) }) })));

router.post('/whatsapp/test', ah(async (req, res) => {
  const to = intlPhone(req.body?.to) || (await getSettings()).whatsapp_admin_number;
  const result = await sendTemplate({
    to, template: config.whatsapp.templates.adminAlert, kind: 'test',
    params: ['Message de test', `Envoyé depuis l’administration par ${req.user.first_name} — la configuration WhatsApp fonctionne.`]
  });
  res.status(result.ok ? 200 : 502).json(result);
}));

export default router;
