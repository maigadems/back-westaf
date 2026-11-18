// Tests d'intégration de bout en bout sur un vrai MySQL (éphémère).
// PayTech et l'API WhatsApp de Meta sont remplacés, UNIQUEMENT ICI, par un serveur
// local qui enregistre les requêtes reçues pour vérifier ce que l'API envoie.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import { execFileSync } from 'child_process';

// --- Faux fournisseurs externes ---
const sent = { paytech: [], whatsapp: [] };
const mock = express();
mock.use(express.json());
mock.post('/payment/request-payment', (req, res) => {
  sent.paytech.push(req.body);
  res.json({ success: 1, token: `tok_${sent.paytech.length}`, redirect_url: `https://paytech.test/pay/${req.body.ref_command}` });
});
mock.post('/:version/:phoneId/messages', (req, res) => {
  sent.whatsapp.push(req.body);
  res.json({ messages: [{ id: `wamid.${sent.whatsapp.length}` }] });
});
const mockServer = await new Promise((r) => { const s = mock.listen(0, () => r(s)); });
const mockUrl = `http://127.0.0.1:${mockServer.address().port}`;

process.env.PAYTECH_BASE_URL = mockUrl;
process.env.WHATSAPP_API_BASE = mockUrl;
process.env.WHATSAPP_TOKEN = 'wa-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
process.env.PORT = '0';
await import('./env.js');
execFileSync(process.execPath, ['test/seed-legacy.mjs'], { stdio: 'ignore' });

const { start } = await import('../server.js');
const { pool } = await import('../config/db.js');
const { runReminders, runPaymentLinks } = await import('../services/scheduler.js');
const { toSql, addMinutes } = await import('../lib/time.js');
let server, base;

before(async () => {
  server = await start();
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.close();
  mockServer.close();
  await pool.end();
});

const api = async (method, path, { token, body, headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

const login = async (email, password) => {
  const r = await api('POST', '/auth/login', { body: { email, password } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.token;
};

const ipn = (payment, type = 'sale_complete') => {
  const key = process.env.PAYTECH_API_KEY, secret = process.env.PAYTECH_API_SECRET;
  const hmac = crypto.createHmac('sha256', secret).update(`${payment.item_price}|${payment.ref_command}|${key}`).digest('hex');
  return api('POST', '/ipn', { body: { type_event: type, ref_command: payment.ref_command, item_price: payment.item_price, payment_method: 'Wave', hmac_compute: hmac } });
};

const futureDay = (days) => {
  // Prochain jour ouvré (lundi–samedi) à J+days
  const d = new Date(Date.now() + days * 86400000);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const state = {};

test('comptes historiques : connexion par téléphone et par e-mail', async () => {
  state.legacyToken = await login('77 111 22 33', 'AncienMdp1');
  const byEmail = await login('awa@exemple.sn', 'AncienMdp1');
  const me = await api('GET', '/client/reservations', { token: byEmail });
  assert.equal(me.status, 200);
  assert.equal(me.data.reservations.length, 1, 'la réservation historique est rattachée au compte');
  assert.equal(me.data.reservations[0].payment_status, 'acompte');
});

test('inscription, doublon, connexion, profil', async () => {
  const reg = await api('POST', '/auth/register', { body: { first_name: 'Ibou', last_name: 'Fall', email: 'ibou@test.sn', password: 'MotDePasse1', phone: '77 222 33 44' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  assert.equal(reg.data.user.role, 'client');
  const dup = await api('POST', '/auth/register', { body: { first_name: 'X', last_name: 'Y', email: 'IBOU@test.sn', password: 'MotDePasse1' } });
  assert.equal(dup.status, 409);
  const weak = await api('POST', '/auth/register', { body: { first_name: 'X', last_name: 'Y', email: 'weak@test.sn', password: 'court' } });
  assert.equal(weak.status, 400);
  state.client = await login('ibou@test.sn', 'MotDePasse1');
  const bad = await api('POST', '/auth/login', { body: { email: 'ibou@test.sn', password: 'mauvais1' } });
  assert.equal(bad.status, 401);
  const me = await api('GET', '/auth/me', { token: state.client });
  assert.equal(me.data.user.phone, '221772223344');
});

test('compte créé depuis d’anciennes réservations : récupéré à l’inscription', async () => {
  const r = await api('POST', '/auth/register', { body: { first_name: 'Moussa', last_name: 'Ndiaye', email: 'moussa@exemple.sn', password: 'Moussa2024' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const list = await api('GET', '/client/reservations', { token: r.data.token });
  assert.equal(list.data.reservations.length, 2, 'historique retrouvé');
});

test('mot de passe oublié : lien à usage unique, sessions révoquées', async () => {
  const f = await api('POST', '/auth/forgot-password', { body: { email: 'ibou@test.sn' } });
  assert.equal(f.status, 200);
  const unknown = await api('POST', '/auth/forgot-password', { body: { email: 'inconnu@test.sn' } });
  assert.equal(unknown.status, 200, 'pas d’énumération des comptes');
  const [[row]] = await pool.query("SELECT COUNT(*) AS n FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE u.email = 'ibou@test.sn'");
  assert.equal(Number(row.n), 1);
  // Le lien réel n'est envoyé que par e-mail : on crée ici un jeton connu pour simuler le clic
  const token = crypto.randomBytes(32).toString('hex');
  const [[u]] = await pool.query("SELECT id FROM users WHERE email = 'ibou@test.sn'");
  await pool.query('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL 1 HOUR)', [u.id, crypto.createHash('sha256').update(token).digest('hex')]);
  const check = await api('GET', `/auth/reset-password/${token}`);
  assert.equal(check.data.valid, true);
  const reset = await api('POST', '/auth/reset-password', { body: { token, password: 'NouveauMdp2' } });
  assert.equal(reset.status, 200);
  const old = await api('GET', '/auth/me', { token: state.client });
  assert.equal(old.status, 401, 'ancienne session invalidée');
  const reuse = await api('POST', '/auth/reset-password', { body: { token, password: 'EncoreUn3' } });
  assert.equal(reuse.status, 400, 'lien à usage unique');
  state.client = await login('ibou@test.sn', 'NouveauMdp2');
});

test('Google : refus propre tant que GOOGLE_CLIENT_ID n’est pas configuré', async () => {
  const r = await api('POST', '/auth/google', { body: { credential: 'x' } });
  assert.equal(r.status, 503);
});

test('comptes initiaux et rôles', async () => {
  state.super = await login('super@studio.test', 'SuperPass123');
  state.admin = await login('jeuss@studio.test', 'JeussPass123');
  // Jeuss ne peut pas créer d'administrateur ; le super admin oui
  const no = await api('POST', '/admin/users', { token: state.admin, body: { role: 'admin', first_name: 'A', email: 'a@studio.test' } });
  assert.equal(no.status, 403);
  const yes = await api('POST', '/admin/users', { token: state.super, body: { role: 'admin', first_name: 'Adjoint', email: 'adjoint@studio.test' } });
  assert.equal(yes.status, 201);
  assert.ok(yes.data.temporaryPassword);
  // Jeuss crée un ingénieur du son
  const eng = await api('POST', '/admin/users', { token: state.admin, body: { role: 'engineer', first_name: 'Pape', last_name: 'Sarr', email: 'pape@studio.test', phone: '77 999 88 77', password: 'Inge2024ok' } });
  assert.equal(eng.status, 201, JSON.stringify(eng.data));
  state.engineerId = eng.data.user.id;
  state.engineer = await login('pape@studio.test', 'Inge2024ok');
});

test('contrôle d’accès côté serveur', async () => {
  assert.equal((await api('GET', '/admin/dashboard')).status, 401);
  assert.equal((await api('GET', '/admin/dashboard', { token: state.client })).status, 403);
  assert.equal((await api('GET', '/admin/dashboard', { token: state.engineer })).status, 403, 'ingénieur : pas de tableau de bord financier');
  assert.equal((await api('GET', '/admin/payments', { token: state.engineer })).status, 403);
  assert.equal((await api('GET', '/admin/reservations', { token: state.engineer })).status, 403);
  assert.equal((await api('GET', '/engineer/sessions', { token: state.client })).status, 403);
  assert.equal((await api('GET', '/client/reservations', { token: state.engineer })).status, 403);
  const forged = await api('GET', '/admin/dashboard', { token: state.client.replace(/.$/, 'x') });
  assert.equal(forged.status, 401);
});

test('disponibilités publiques', async () => {
  const s = await api('GET', '/public/services');
  state.studio = s.data.services.find((x) => x.slug === 'enregistrement-studio');
  state.mixage = s.data.services.find((x) => x.slug === 'mixage');
  assert.ok(state.studio && state.mixage);
  const days = await api('GET', `/public/availability/days?service_id=${state.studio.id}&hours=2`);
  assert.equal(days.status, 200);
  const sunday = days.data.days.find((d) => new Date(`${d.date}T00:00:00Z`).getUTCDay() === 0);
  if (sunday) assert.equal(sunday.open, false, 'fermé le dimanche');
  state.day = futureDay(3);
  const slots = await api('GET', `/public/availability/slots?service_id=${state.studio.id}&hours=2&date=${state.day}`);
  assert.equal(slots.status, 200);
  assert.ok(slots.data.slots.length > 0);
  assert.equal(slots.data.slots[0].start, `${state.day} 08:00:00`);
  assert.ok(!slots.data.slots.some((x) => x.start === `${state.day} 23:00:00`), 'une session de 2 h ne peut pas commencer à 23 h');
});

test('réservation + paiement PayTech + notifications WhatsApp', async () => {
  const before = sent.whatsapp.length;
  const r = await api('POST', '/client/reservations', { token: state.client, body: { service_id: state.studio.id, start: `${state.day} 10:00`, hours: 2, payment_option: 'deposit', message: 'Enregistrement voix' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.amountNow, 30000, 'acompte 50 %');
  assert.match(r.data.redirectUrl, /^https:\/\/paytech\.test\//);
  state.resId = r.data.reservation.id;
  const pay = sent.paytech.at(-1);
  assert.equal(pay.item_price, 30000);
  assert.equal(pay.ipn_url, 'https://api.test/ipn');

  // Créneau bloqué pendant le paiement : un autre client ne peut pas le prendre
  const other = await api('POST', '/client/reservations', { token: state.legacyToken, body: { service_id: state.studio.id, start: `${state.day} 11:00`, hours: 1 } });
  assert.ok([400, 409].includes(other.status), 'double réservation refusée');

  // IPN non authentique refusée
  const fake = await api('POST', '/ipn', { body: { type_event: 'sale_complete', ref_command: pay.ref_command, item_price: 30000, hmac_compute: 'abc' } });
  assert.equal(fake.status, 403);

  const ok = await ipn(pay);
  assert.equal(ok.status, 200);
  const again = await ipn(pay);
  assert.equal(again.status, 200, 'IPN rejouée sans effet');
  const [[res]] = await pool.query('SELECT statut, payment_status, montant_paye, session_status FROM reservations WHERE id = ?', [state.resId]);
  assert.deepEqual(res, { statut: 'confirmee', payment_status: 'acompte', montant_paye: 30000, session_status: 'planifiee' });

  const msgs = sent.whatsapp.slice(before);
  const toJeuss = msgs.find((m) => m.to === '221778600482');
  assert.ok(toJeuss, 'Jeuss notifié sur WhatsApp');
  assert.equal(toJeuss.template.name, 'studio_alerte_admin');
  const details = toJeuss.template.components[0].parameters[1].text;
  assert.match(details, /Ibou Fall/);
  assert.match(details, /\+221772223344/);
  assert.match(details, /10h00 – 12h00/);
  assert.ok(msgs.find((m) => m.to === '221772223344'), 'client notifié');
  assert.equal(msgs.filter((m) => m.to === '221778600482').length, 1, 'pas de doublon malgré l’IPN rejouée');

  const n = await api('GET', '/admin/notifications', { token: state.admin });
  assert.ok(n.data.notifications.some((x) => x.type === 'booking_new'));
});

test('concurrence : un seul des deux clients obtient le créneau', async () => {
  const day = futureDay(4);
  const [a, b] = await Promise.all([
    api('POST', '/client/reservations', { token: state.client, body: { service_id: state.studio.id, start: `${day} 15:00`, hours: 2 } }),
    api('POST', '/client/reservations', { token: state.legacyToken, body: { service_id: state.studio.id, start: `${day} 16:00`, hours: 1 } })
  ]);
  const okCount = [a, b].filter((x) => x.status === 201).length;
  assert.equal(okCount, 1, `${a.status} / ${b.status}`);
  const [locks] = await pool.query('SELECT reservation_id FROM slot_locks WHERE slot_start = ?', [`${day} 16:00:00`]);
  assert.equal(locks.length, 1);
});

test('report : libère l’ancien créneau, bloque le nouveau, limite des 2 h', async () => {
  const before = sent.whatsapp.length;
  const r = await api('POST', `/client/reservations/${state.resId}/reschedule`, { token: state.client, body: { start: `${state.day} 14:00` } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.reservation.start_at, `${state.day} 14:00:00`);
  const [locks] = await pool.query('SELECT slot_start FROM slot_locks WHERE reservation_id = ? ORDER BY slot_start', [state.resId]);
  assert.deepEqual(locks.map((l) => l.slot_start), [`${state.day} 14:00:00`, `${state.day} 15:00:00`]);
  const freed = await api('GET', `/public/availability/slots?service_id=${state.studio.id}&hours=2&date=${state.day}`);
  assert.equal(freed.data.slots.find((s) => s.start === `${state.day} 10:00:00`).available, true, 'ancien créneau libéré');
  assert.ok(sent.whatsapp.slice(before).some((m) => m.to === '221778600482'), 'Jeuss informé du report');

  // Un autre client ne peut pas reporter cette réservation
  const notMine = await api('POST', `/client/reservations/${state.resId}/reschedule`, { token: state.legacyToken, body: { start: `${state.day} 18:00` } });
  assert.equal(notMine.status, 404);

  // À moins de 2 h : bloqué
  const soon = toSql(new Date(Date.now() + 90 * 60000)).slice(0, 13) + ':00:00';
  await pool.query('DELETE FROM slot_locks WHERE reservation_id = ?', [state.resId]);
  await pool.query('UPDATE reservations SET start_at = ?, end_at = ? WHERE id = ?', [soon, addMinutes(soon, 120), state.resId]);
  const late = await api('POST', `/client/reservations/${state.resId}/reschedule`, { token: state.client, body: { start: `${futureDay(6)} 10:00` } });
  assert.equal(late.status, 403);
  const list = await api('GET', `/client/reservations/${state.resId}`, { token: state.client });
  assert.equal(list.data.reservation.can_reschedule, false);
});

test('ingénieur : affectation, aucune donnée financière', async () => {
  // Session à J+5 attribuée à l'ingénieur
  const day = futureDay(8);
  const r = await api('POST', '/admin/reservations', { token: state.admin, body: { service_id: state.studio.id, start: `${day} 14:00`, hours: 3, nom: 'Client Studio', telephone: '77 555 44 33', engineer_id: state.engineerId } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  state.engRes = r.data.reservation;
  assert.equal(state.engRes.montant_total, 90000);

  const list = await api('GET', '/engineer/sessions', { token: state.engineer });
  assert.equal(list.status, 200);
  assert.equal(list.data.sessions.length, 1);
  const s = list.data.sessions[0];
  const json = JSON.stringify(list.data);
  for (const forbiddenKey of ['montant_total', 'montant_paye', 'solde', 'payment_status', 'type_paiement', 'price']) {
    assert.ok(!(forbiddenKey in s), `champ financier exposé : ${forbiddenKey}`);
    assert.ok(!json.includes(`"${forbiddenKey}"`), `champ financier exposé : ${forbiddenKey}`);
  }
  assert.equal(s.autorisee_a_commencer, false);
  const detail = await api('GET', `/engineer/sessions/${state.engRes.id}`, { token: state.engineer });
  assert.ok(!JSON.stringify(detail.data).includes('90000'), 'aucun montant dans le détail');
  const other = await api('GET', `/engineer/sessions/${state.resId}`, { token: state.engineer });
  assert.equal(other.status, 404, 'session non attribuée inaccessible');
  const notif = await api('GET', '/engineer/notifications', { token: state.engineer });
  assert.ok(notif.data.notifications.some((n) => n.type === 'session_assigned'));
  assert.ok(!JSON.stringify(notif.data).match(/FCFA|payé/), 'notifications sans montant');

  // Démarrage interdit tant que le paiement n'est pas confirmé
  const start = await api('POST', `/engineer/sessions/${state.engRes.id}/status`, { token: state.engineer, body: { status: 'en_cours' } });
  assert.equal(start.status, 403);
});

test('paiement en espèces : demande, notification Jeuss, validation, « Autorisée à commencer »', async () => {
  const [[{ action_token }]] = await pool.query('SELECT action_token FROM reservations WHERE id = ?', [state.engRes.id]);
  const page = await api('GET', `/actions/${action_token}`);
  assert.equal(page.data.reservation.amount_due, 90000);
  const before = sent.whatsapp.length;
  const cash = await api('POST', `/actions/${action_token}/pay-cash`);
  assert.equal(cash.status, 200);
  assert.equal(cash.data.reservation.payment_status, 'en_attente_validation');
  assert.ok(sent.whatsapp.slice(before).some((m) => m.to === '221778600482' && /espèces/.test(JSON.stringify(m))), 'Jeuss notifié (WhatsApp)');
  const pending = await api('GET', '/admin/payments?status=awaiting_validation', { token: state.admin });
  assert.equal(pending.data.payments.length, 1);

  const v = await api('POST', `/admin/reservations/${state.engRes.id}/validate-cash`, { token: state.admin });
  assert.equal(v.status, 200);
  assert.equal(v.data.reservation.payment_status, 'paye');
  assert.equal(v.data.reservation.session_status, 'autorisee');
  const again = await api('POST', `/admin/reservations/${state.engRes.id}/validate-cash`, { token: state.admin });
  assert.equal(again.status, 400);

  const s = await api('GET', `/engineer/sessions/${state.engRes.id}`, { token: state.engineer });
  assert.equal(s.data.session.autorisee_a_commencer, true);
  assert.equal((await api('POST', `/engineer/sessions/${state.engRes.id}/status`, { token: state.engineer, body: { status: 'en_cours' } })).status, 200);
  const done = await api('POST', `/engineer/sessions/${state.engRes.id}/status`, { token: state.engineer, body: { status: 'terminee' } });
  assert.equal(done.data.session.statut, 'terminee');
});

test('solde en ligne via le lien de paiement', async () => {
  const [[{ action_token }]] = await pool.query('SELECT action_token FROM reservations WHERE id = ?', [state.resId]);
  const r = await api('POST', `/actions/${action_token}/pay-online`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const pay = sent.paytech.at(-1);
  assert.equal(pay.item_price, 30000, 'montant restant uniquement');
  await ipn(pay);
  const [[res]] = await pool.query('SELECT payment_status, session_status, montant_paye FROM reservations WHERE id = ?', [state.resId]);
  assert.deepEqual(res, { payment_status: 'paye', session_status: 'autorisee', montant_paye: 60000 });
});

test('rappel 2 h avant et lien de paiement 10 min avant (sans doublon)', async () => {
  // Le test tourne à toute heure : on ouvre le studio 24 h/24 via l'API des horaires
  const hours = await api('PUT', '/admin/hours', { token: state.admin, body: { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, is_open: true, open_time: '00:00', close_time: '24:00' })) } });
  assert.equal(hours.status, 200, JSON.stringify(hours.data));
  // Réservation confirmée qui commence dans 100 min, solde restant dû
  // Heure pleine située entre 60 et 120 min dans le futur
  const startAt = toSql(new Date(Math.ceil(Date.now() / 3600000) * 3600000 + 3600000)).slice(0, 16) + ':00';
  const r = await api('POST', '/admin/reservations', { token: state.admin, body: { service_id: state.studio.id, start: startAt, hours: 1, nom: 'Rappel Test', telephone: '77 123 45 67' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await pool.query('UPDATE reservations SET created_at = UTC_TIMESTAMP() - INTERVAL 1 DAY, montant_paye = 15000, payment_status = ? WHERE id = ?', ['acompte', r.data.reservation.id]);
  const before = sent.whatsapp.length;
  assert.equal(await runReminders(), 1);
  assert.equal(await runReminders(), 0, 'pas de second rappel');
  const reminder = sent.whatsapp.slice(before).find((m) => m.template?.name === 'studio_rappel_session');
  assert.ok(reminder);
  assert.equal(reminder.to, '221771234567');
  assert.equal(reminder.template.components[0].parameters[0].text, 'Rappel');
  const payload = reminder.template.components[1].parameters[0].payload;
  assert.match(payload, /^PRESENCE_OK:[a-f0-9]{48}$/);

  // Réponse « Confirmer ma présence » via le webhook signé
  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'wamid.in.1', from: '221771234567', type: 'button', button: { payload, text: 'Confirmer ma présence' } }] } }] }] });
  const badSig = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=00' }, body });
  assert.equal(badSig.status, 401);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'wa-app-secret').update(body).digest('hex');
  const ok = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body });
  assert.equal(ok.status, 200);
  await new Promise((r2) => setTimeout(r2, 300));
  await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body }); // rejoué
  await new Promise((r2) => setTimeout(r2, 300));
  const [[p]] = await pool.query('SELECT presence_status FROM reservations WHERE id = ?', [r.data.reservation.id]);
  assert.equal(p.presence_status, 'confirmee');
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM whatsapp_messages WHERE kind = 'reply_presence_ok'");
  assert.equal(Number(n), 1, 'webhook rejoué traité une seule fois');

  // Lien de paiement 10 min avant
  const soon = toSql(new Date(Date.now() + 8 * 60000)).slice(0, 16) + ':00';
  await pool.query('DELETE FROM slot_locks WHERE reservation_id = ?', [r.data.reservation.id]);
  await pool.query('UPDATE reservations SET start_at = ?, end_at = ? WHERE id = ?', [soon, addMinutes(soon, 60), r.data.reservation.id]);
  const b2 = sent.whatsapp.length;
  assert.equal(await runPaymentLinks(), 1);
  assert.equal(await runPaymentLinks(), 0);
  const link = sent.whatsapp.slice(b2).find((m) => m.template?.name === 'studio_lien_paiement');
  assert.ok(link);
  assert.match(link.template.components[0].parameters[1].text, /15 000 FCFA/);
  assert.equal(link.template.components[1].sub_type, 'url');
});

test('vérification du webhook Meta', async () => {
  const ok = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wa-verify&hub.challenge=42`);
  assert.equal(await ok.text(), '42');
  const ko = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=faux&hub.challenge=42`);
  assert.equal(ko.status, 403);
});

test('numéro WhatsApp de Jeuss modifiable depuis les paramètres', async () => {
  const bad = await api('PUT', '/admin/settings', { token: state.admin, body: { whatsapp_admin_number: 'abc' } });
  assert.equal(bad.status, 400);
  const r = await api('PUT', '/admin/settings', { token: state.admin, body: { whatsapp_admin_number: '+221 70 000 11 22' } });
  assert.equal(r.status, 200);
  const before = sent.whatsapp.length;
  const res = await api('POST', `/admin/reservations/${state.resId}/cancel`, { token: state.admin, body: { reason: 'Test' } });
  assert.equal(res.status, 200);
  assert.ok(sent.whatsapp.slice(before).some((m) => m.to === '221700001122'), 'notification envoyée au nouveau numéro');
  const [locks] = await pool.query('SELECT * FROM slot_locks WHERE reservation_id = ?', [state.resId]);
  assert.equal(locks.length, 0, 'créneau libéré à l’annulation');
});

test('tableau de bord : chiffres réels, finances réservées aux admins', async () => {
  const d = await api('GET', '/admin/dashboard', { token: state.admin });
  assert.equal(d.status, 200);
  assert.ok(d.data.finance, 'Jeuss voit les finances');
  assert.ok(d.data.reservations.total >= 5);
  assert.equal(d.data.activeEngineers, 1);
  assert.ok(d.data.finance.collected >= 90000);
  const o = await api('GET', '/engineer/overview', { token: state.engineer });
  assert.ok(!JSON.stringify(o.data).includes('montant'));
});

test('services, équipements et galerie gérés par l’admin, visibles publiquement', async () => {
  const s = await api('PATCH', `/admin/services/${state.mixage.id}`, { token: state.admin, body: { price: 160000, is_featured: false } });
  assert.equal(s.data.service.price, 160000);
  const off = await api('PATCH', `/admin/services/${state.mixage.id}`, { token: state.admin, body: { is_active: false } });
  assert.equal(off.status, 200);
  assert.ok(!(await api('GET', '/public/services')).data.services.some((x) => x.id === state.mixage.id), 'service désactivé masqué');
  await api('PATCH', `/admin/services/${state.mixage.id}`, { token: state.admin, body: { is_active: true } });
  const del = await api('DELETE', `/admin/services/${state.studio.id}`, { token: state.admin });
  assert.equal(del.status, 409, 'service lié à des réservations non supprimable');

  const eq = await api('GET', '/admin/equipment', { token: state.admin });
  const first = eq.data.equipment[0];
  await api('PATCH', `/admin/equipment/${first.id}`, { token: state.admin, body: { is_featured: true, description: 'Micro statique de référence' } });
  const pub = await api('GET', '/public/equipment?featured=1');
  assert.equal(pub.data.equipment.length, 1);
  await api('PATCH', `/admin/equipment/${first.id}`, { token: state.admin, body: { is_public: false } });
  assert.equal((await api('GET', '/public/equipment?featured=1')).data.equipment.length, 0, 'équipement masqué');

  // Import d'une vraie image PNG (1×1)
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf000000040001021e0b8b0000000049454e44ae426082', 'hex');
  const form = new FormData();
  form.append('photos', new Blob([png], { type: 'image/png' }), 'studio.png');
  form.append('title', 'Cabine');
  const up = await fetch(`${base}/admin/gallery`, { method: 'POST', headers: { Authorization: `Bearer ${state.admin}` }, body: form });
  assert.equal(up.status, 201);
  const photo = (await up.json()).photos[0];
  const img = await fetch(base + photo.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('cross-origin-resource-policy'), 'cross-origin');
  const fakeImg = new FormData();
  fakeImg.append('photos', new Blob([Buffer.from('pas une image')], { type: 'image/png' }), 'x.png');
  assert.equal((await fetch(`${base}/admin/gallery`, { method: 'POST', headers: { Authorization: `Bearer ${state.admin}` }, body: fakeImg })).status, 400);
  assert.equal((await api('GET', '/public/gallery')).data.photos.length, 1);
  const engUp = await fetch(`${base}/admin/gallery`, { method: 'POST', headers: { Authorization: `Bearer ${state.engineer}` }, body: form });
  assert.equal(engUp.status, 403);
});

test('désactivation d’un compte : sessions révoquées', async () => {
  const r = await api('PATCH', `/admin/users/${state.engineerId}`, { token: state.admin, body: { is_active: false } });
  assert.equal(r.status, 200);
  assert.equal((await api('GET', '/engineer/sessions', { token: state.engineer })).status, 401);
  const del = await api('DELETE', `/admin/users/${state.engineerId}`, { token: state.admin });
  assert.equal(del.status, 409, 'compte lié à des sessions conservé');
});

test('factures : émission, numérotation, cloisonnement', async () => {
  const all = await api('GET', '/admin/invoices', { token: state.admin });
  assert.equal(all.status, 200);
  const numbers = all.data.invoices.map((i) => i.number);
  assert.ok(numbers.length >= 4, `factures émises : ${numbers.length}`);
  assert.ok(numbers.every((n) => /^WR-\d{4}-\d{4}$/.test(n)), numbers.join(','));
  assert.equal(new Set(numbers).size, numbers.length, 'numéros uniques');

  // Réservation historique (acompte) : facture créée par la migration, partiellement payée
  const legacy = await api('GET', '/client/invoices', { token: state.legacyToken });
  assert.equal(legacy.data.invoices.length, 1);
  assert.equal(legacy.data.invoices[0].paid, 30000);
  assert.equal(legacy.data.invoices[0].status, 'partielle');

  // Client : acompte + solde en ligne (réservation annulée ensuite dans les tests)
  const mine = await api('GET', '/client/invoices', { token: state.client });
  const inv = mine.data.invoices.find((i) => i.reservation_id === state.resId);
  assert.ok(inv, 'facture du client');
  const detail = await api('GET', `/client/invoices/${inv.id}`, { token: state.client });
  assert.equal(detail.data.invoice.paid, 60000);
  assert.equal(detail.data.invoice.payments.length, 2);
  assert.equal(detail.data.invoice.lines[0].quantity, 2);
  assert.equal(detail.data.invoice.lines[0].unit_price, 30000);

  // Un client ne voit pas la facture d'un autre ; ni client ni ingénieur n'accèdent à la liste admin
  assert.equal((await api('GET', `/client/invoices/${inv.id}`, { token: state.legacyToken })).status, 404);
  assert.equal((await api('GET', '/admin/invoices', { token: state.client })).status, 403);

  // Paiement en espèces validé : facture soldée
  const cash = all.data.invoices.find((i) => i.reservation_id === state.engRes.id);
  assert.ok(cash);
  const c = await api('GET', `/admin/invoices/${cash.id}`, { token: state.admin });
  assert.equal(c.data.invoice.status, 'payee');
  assert.match(c.data.invoice.payments[0].label, /Espèces/);

  // Émission manuelle refusée sans encaissement
  const day = futureDay(9);
  const r = await api('POST', '/admin/reservations', { token: state.admin, body: { service_id: state.studio.id, start: `${day} 12:00`, hours: 1, nom: 'Sans paiement', telephone: '77 000 11 22' } });
  assert.equal((await api('POST', `/admin/reservations/${r.data.reservation.id}/invoice`, { token: state.admin })).status, 400);
});

test('factures : téléchargement PDF (client, admin) et contrôle d’accès', async () => {
  const mine = await api('GET', '/client/invoices', { token: state.client });
  const inv = mine.data.invoices[0];
  const get = (path, token) => fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const r = await get(`/client/invoices/${inv.id}/pdf`, state.client);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), new RegExp(`facture-${inv.number}\.pdf`));
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await get(`/client/invoices/${inv.id}/pdf`, state.legacyToken)).status, 404, 'facture d’un autre client');
  assert.equal((await get(`/client/invoices/${inv.id}/pdf`)).status, 401);
  assert.equal((await get(`/admin/invoices/${inv.id}/pdf`, state.admin)).status, 200, 'Jeuss');
  assert.equal((await get(`/admin/invoices/${inv.id}/pdf`, state.super)).status, 200, 'super admin');
  assert.equal((await get(`/admin/invoices/${inv.id}/pdf`, state.client)).status, 403);
});

test('session de plusieurs heures : créneaux, blocage complet, facture', async () => {
  const day = futureDay(11);
  const svc = (await api('GET', '/public/services')).data.services.find((s) => s.slug === 'enregistrement-studio');
  assert.equal(svc.max_hours, 16, 'jusqu’à 16 h consécutives (08h–00h)');
  const full = await api('GET', `/public/availability/slots?service_id=${svc.id}&hours=16&date=${day}`);
  // Une session de 16 h doit finir au plus tard à minuit : dernier début possible 08:00
  const labels = full.data.slots.filter((s) => s.available).map((s) => s.label);
  assert.ok(labels.includes('08:00 – 00:00'), labels.join(','));
  assert.ok(!full.data.slots.some((s) => s.start > `${day} 08:00:00`), 'aucune session ne déborde après minuit');

  const r = await api('POST', '/client/reservations', { token: state.client, body: { service_id: svc.id, start: `${day} 10:00`, hours: 6, payment_option: 'full' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.amountNow, 180000);
  const [locks] = await pool.query('SELECT slot_start FROM slot_locks WHERE reservation_id = ? ORDER BY slot_start', [r.data.reservation.id]);
  assert.equal(locks.length, 6, '6 heures bloquées');
  assert.equal(locks[5].slot_start, `${day} 15:00:00`);

  // Un autre client ne peut pas prendre une heure au milieu de la session
  const clash = await api('POST', '/client/reservations', { token: state.legacyToken, body: { service_id: svc.id, start: `${day} 13:00`, hours: 1 } });
  assert.ok([400, 409].includes(clash.status));
  // Une session de 3 h qui se terminerait pendant la session n'est pas proposée
  const slots = await api('GET', `/public/availability/slots?service_id=${svc.id}&hours=3&date=${day}`);
  assert.equal(slots.data.slots.find((s) => s.start === `${day} 08:00:00`).available, false);
  assert.equal(slots.data.slots.find((s) => s.start === `${day} 16:00:00`).available, true);

  // Paiement → facture avec la bonne quantité
  await ipn(sent.paytech.at(-1));
  const inv = (await api('GET', '/client/invoices', { token: state.client })).data.invoices.find((i) => i.reservation_id === r.data.reservation.id);
  const detail = await api('GET', `/client/invoices/${inv.id}`, { token: state.client });
  assert.equal(detail.data.invoice.lines[0].quantity, 6);
  assert.equal(detail.data.invoice.total, 180000);
});
