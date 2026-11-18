// Espace ingénieur du son : uniquement ses sessions, sans aucune donnée financière.
// Toutes les réponses passent par la projection forEngineer (liste blanche de champs).
import { Router } from 'express';
import { q } from '../config/db.js';
import { ah, badRequest, str } from '../lib/http.js';
import { isValidDate, isValidDateTime, normDateTime } from '../lib/time.js';
import { requireEngineer } from '../middleware/auth.js';
import { assertAssigned, forEngineer, getReservation, listReservations, setSessionStatus } from '../services/reservationService.js';
import { getHistory } from '../services/historyService.js';
import { listNotifications, markRead } from '../services/notificationService.js';

const router = Router();
router.use(requireEngineer);

router.get('/overview', ah(async (req, res) => {
  const all = await listReservations({ engineerId: req.user.id, order: 'asc' });
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const today = now.slice(0, 10);
  const active = all.filter((r) => r.statut === 'confirmee');
  res.json({
    today: active.filter((r) => r.start_at?.startsWith(today)).map(forEngineer),
    upcoming: active.filter((r) => r.start_at && r.start_at >= now).slice(0, 20).map(forEngineer),
    counts: {
      upcoming: active.filter((r) => r.start_at && r.start_at >= now).length,
      today: active.filter((r) => r.start_at?.startsWith(today)).length,
      completed: all.filter((r) => r.statut === 'terminee' || (r.statut === 'confirmee' && r.end_at && r.end_at < now)).length,
      rescheduled: all.filter((r) => r.reschedule_count > 0 && r.statut === 'confirmee').length
    }
  });
}));

router.get('/sessions', ah(async (req, res) => {
  const { from, to, statut } = req.query;
  const rows = await listReservations({
    engineerId: req.user.id, statut: statut || undefined, order: req.query.order === 'desc' ? 'desc' : 'asc',
    from: isValidDate(from) ? from : undefined, to: isValidDate(to) ? to : undefined
  });
  res.json({ sessions: rows.map(forEngineer) });
}));

router.get('/sessions/:id', ah(async (req, res) => {
  const r = assertAssigned(await getReservation(req.params.id), req.user);
  res.json({ session: forEngineer(r), history: await getHistory(r.id, { financial: false }) });
}));

router.post('/sessions/:id/status', ah(async (req, res) => {
  const r = assertAssigned(await getReservation(req.params.id), req.user);
  res.json({ session: forEngineer(await setSessionStatus(r, req.body?.status, req.user)) });
}));

// Notes pratiques de session (partagées avec l'administration)
router.patch('/sessions/:id/notes', ah(async (req, res) => {
  const r = assertAssigned(await getReservation(req.params.id), req.user);
  await q('UPDATE reservations SET internal_notes = ? WHERE id = ?', [str(req.body?.internal_notes, { max: 4000 }), r.id]);
  res.json({ session: forEngineer(await getReservation(r.id)) });
}));

// Absences personnelles
router.get('/unavailability', ah(async (req, res) => {
  res.json({ unavailability: await q('SELECT * FROM engineer_unavailability WHERE user_id = ? AND end_at >= UTC_TIMESTAMP() ORDER BY start_at', [req.user.id]) });
}));

router.post('/unavailability', ah(async (req, res) => {
  const { start_at, end_at, reason } = req.body || {};
  if (!isValidDateTime(start_at) || !isValidDateTime(end_at) || normDateTime(start_at) >= normDateTime(end_at)) throw badRequest('Période invalide');
  await q('INSERT INTO engineer_unavailability (user_id, start_at, end_at, reason) VALUES (?, ?, ?, ?)', [req.user.id, normDateTime(start_at), normDateTime(end_at), str(reason, { max: 255 })]);
  res.status(201).json({ success: true });
}));

router.delete('/unavailability/:id', ah(async (req, res) => {
  await q('DELETE FROM engineer_unavailability WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
  res.json({ success: true });
}));

router.get('/notifications', ah(async (req, res) => res.json(await listNotifications(req.user, { unreadOnly: req.query.unread === '1' }))));
router.post('/notifications/read', ah(async (req, res) => {
  await markRead(req.user, req.body?.ids === 'all' ? 'all' : req.body?.ids);
  res.json({ success: true });
}));

export default router;
