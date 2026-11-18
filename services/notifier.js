// Diffusion des événements de réservation : WhatsApp (Jeuss, client, ingénieur),
// notifications du tableau de bord et e-mails. Une erreur de notification ne bloque
// jamais l'opération principale ; les échecs WhatsApp sont visibles dans l'administration.
import { config } from '../config/env.js';
import { formatFr, formatHour } from '../lib/time.js';
import { getSetting } from './settingsService.js';
import { notifyStaff, notifyUser } from './notificationService.js';
import { sendTemplate, sendText } from './whatsappService.js';
import { sendBookingEmail } from './emailService.js';

const tpl = config.whatsapp.templates;
const fcfa = (n) => `${Number(n || 0).toLocaleString('fr-FR').replace(/ | /g, ' ')} FCFA`;
const spaceLink = () => `${config.frontendUrl}/mon-espace/reservations`;

const when = (r) =>
  r.start_at ? `${formatFr(r.start_at)}, ${formatHour(r.start_at)} – ${formatHour(r.end_at)} (${r.duree_heures} h)` : `${r.nombre_titres || 1} titre(s)`;

// Résumé pour Jeuss (avec informations financières)
const adminDetails = (r, extra = []) =>
  [
    `Client : ${r.nom}`,
    `Tél : +${String(r.telephone).replace(/^\+/, '')}`,
    `Service : ${r.service_name}`,
    r.start_at ? `Date : ${formatFr(r.start_at)}` : null,
    r.start_at ? `Horaire : ${formatHour(r.start_at)} – ${formatHour(r.end_at)} (${r.duree_heures} h)` : `Titres : ${r.nombre_titres || 1}`,
    `Montant : ${fcfa(r.montant_total)} (payé ${fcfa(r.montant_paye)})`,
    r.engineer_name ? `Ingénieur : ${r.engineer_name}` : null,
    r.message ? `Note : ${String(r.message).slice(0, 300)}` : null,
    `Réf : ${r.id.slice(0, 8)}`,
    ...extra
  ].filter(Boolean).join(' · ');

// Résumé pour l'ingénieur (sans aucune donnée financière)
const engineerDetails = (r, extra = []) =>
  [
    `Client : ${r.nom}`,
    `Tél : +${String(r.telephone).replace(/^\+/, '')}`,
    `Service : ${r.service_name}`,
    r.start_at ? `Date : ${formatFr(r.start_at)}` : null,
    r.start_at ? `Horaire : ${formatHour(r.start_at)} – ${formatHour(r.end_at)}` : null,
    ...extra
  ].filter(Boolean).join(' · ');

const safe = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    console.error('❌ Notification:', e.message);
    return null;
  }
};

const waAdmin = async (r, kind, title, details, dedupeKey) => {
  const to = await getSetting('whatsapp_admin_number');
  if (!to) return null;
  return sendTemplate({ to, template: tpl.adminAlert, params: [title, details], kind, reservationId: r?.id, dedupeKey });
};

const waEngineer = async (r, kind, title, details, dedupeKey) => {
  if (!r.engineer_id || !r.engineer_phone) return null;
  if ((await getSetting('notify_engineer_whatsapp', '1')) !== '1') return null;
  return sendTemplate({ to: r.engineer_phone, template: tpl.adminAlert, params: [title, details], kind, reservationId: r.id, dedupeKey });
};

const waClient = (r, kind, text, dedupeKey) =>
  sendTemplate({ to: r.telephone, template: tpl.clientUpdate, params: [r.first_name || r.nom, text], kind, reservationId: r.id, dedupeKey });

// ---------------------------------------------------------------------------

export const bookingConfirmed = safe(async (r, amount) => {
  const title = 'Nouvelle réservation';
  await notifyStaff({ type: 'booking_new', title: `${title} — ${r.nom}`, body: adminDetails(r), reservationId: r.id, financial: true });
  await waAdmin(r, 'admin_new_booking', title, adminDetails(r, [`Paiement reçu : ${fcfa(amount)}`]), `admin_new:${r.id}`);
  const text = r.start_at
    ? `votre réservation « ${r.service_name} » est confirmée pour le ${when(r)}. Montant réglé : ${fcfa(amount)}${r.solde ? `, reste à payer : ${fcfa(r.solde)}` : ''}. Retrouvez-la dans votre espace : ${spaceLink()}`
    : `votre commande « ${r.service_name} » (${r.nombre_titres} titre(s)) est confirmée. Montant réglé : ${fcfa(amount)}. Suivi : ${spaceLink()}`;
  await waClient(r, 'client_booking_confirmed', text, `client_confirm:${r.id}`);
  await sendBookingEmail(r.client_email || r.email, {
    title: 'Réservation confirmée',
    lines: [`Bonjour ${r.first_name || ''},`, `Service : ${r.service_name}`, r.start_at ? `Date : ${when(r)}` : `Titres : ${r.nombre_titres}`,
      `Montant total : ${fcfa(r.montant_total)}`, `Montant réglé : ${fcfa(r.montant_paye)}`, r.solde ? `Reste à payer : ${fcfa(r.solde)}` : 'Réservation entièrement réglée.'],
    link: spaceLink(),
    linkLabel: 'Voir ma réservation'
  });
});

export const paymentConflict = safe(async (r, amount) => {
  const title = 'Paiement reçu sur un créneau déjà pris';
  const body = adminDetails(r, [`Paiement : ${fcfa(amount)}`, 'Action requise : proposer un autre créneau ou rembourser']);
  await notifyStaff({ type: 'payment_conflict', title, body, reservationId: r.id, financial: true });
  await waAdmin(r, 'admin_payment_conflict', title, body, `admin_conflict:${r.id}`);
});

export const balancePaid = safe(async (r, amount, method) => {
  const title = method === 'cash' ? 'Paiement en espèces validé' : 'Solde payé en ligne';
  await notifyStaff({ type: 'payment_done', title: `${title} — ${r.nom}`, body: `${fcfa(amount)} · Session autorisée à commencer`, reservationId: r.id, financial: true });
  if (method === 'online') await waAdmin(r, 'admin_balance_paid', title, adminDetails(r, [`Solde : ${fcfa(amount)}`, 'Session autorisée à commencer']), `admin_balance:${r.id}`);
  if (r.engineer_id) {
    await notifyUser(r.engineer_id, { type: 'session_authorized', title: `Session autorisée à commencer — ${r.nom}`, body: engineerDetails(r), reservationId: r.id });
    await waEngineer(r, 'engineer_authorized', 'Session autorisée à commencer', engineerDetails(r), `eng_auth:${r.id}:${r.start_at}`);
  }
  await waClient(r, 'client_payment_received', `nous avons bien reçu votre paiement. Votre session « ${r.service_name} » est autorisée à commencer. Bonne session !`, `client_paid:${r.id}`);
});

export const cashRequested = safe(async (r) => {
  const title = 'Demande de paiement en espèces';
  const body = adminDetails(r, [`Montant à encaisser : ${fcfa(r.solde)}`, 'Validez la réception depuis l’administration']);
  await notifyStaff({ type: 'cash_request', title: `${title} — ${r.nom}`, body, reservationId: r.id, financial: true });
  await waAdmin(r, 'admin_cash_request', title, body, `admin_cash:${r.id}:${r.start_at}`);
});

export const rescheduled = safe(async (r, from, actor, engineerWarning) => {
  const byClient = actor?.role === 'client';
  const title = byClient ? 'Session reportée par le client' : 'Session reportée';
  const extra = [`Ancien créneau : ${formatFr(from)} ${formatHour(from)}`];
  if (engineerWarning) extra.push(`⚠ Ingénieur ${engineerWarning === 'absent' ? 'indisponible' : 'déjà occupé'} sur le nouveau créneau`);
  await notifyStaff({ type: 'booking_rescheduled', title: `${title} — ${r.nom}`, body: adminDetails(r, extra), reservationId: r.id, financial: true });
  const key = `${r.id}:${r.start_at}:${r.reschedule_count}`;
  await waAdmin(r, 'admin_rescheduled', title, adminDetails(r, extra), `admin_resched:${key}`);
  if (r.engineer_id) {
    await notifyUser(r.engineer_id, { type: 'booking_rescheduled', title: `Session reportée — ${r.nom}`, body: engineerDetails(r, extra.slice(0, 1)), reservationId: r.id });
    await waEngineer(r, 'engineer_rescheduled', 'Session reportée', engineerDetails(r, extra.slice(0, 1)), `eng_resched:${key}`);
  }
  await waClient(r, 'client_rescheduled', `votre session « ${r.service_name} » a bien été reportée au ${when(r)}. Détails : ${spaceLink()}`, `client_resched:${key}`);
  await sendBookingEmail(r.client_email || r.email, {
    title: 'Report de votre session confirmé',
    lines: [`Bonjour ${r.first_name || ''},`, `Votre session « ${r.service_name} » a été reportée.`, `Nouveau créneau : ${when(r)}`],
    link: spaceLink()
  });
});

export const cancelled = safe(async (r, actor, reason) => {
  const title = 'Réservation annulée';
  const extra = reason ? [`Motif : ${reason}`] : [];
  await notifyStaff({ type: 'booking_cancelled', title: `${title} — ${r.nom}`, body: adminDetails(r, extra), reservationId: r.id, financial: true });
  await waAdmin(r, 'admin_cancelled', title, adminDetails(r, extra), `admin_cancel:${r.id}`);
  if (r.engineer_id) {
    await notifyUser(r.engineer_id, { type: 'booking_cancelled', title: `Session annulée — ${r.nom}`, body: engineerDetails(r), reservationId: r.id });
    await waEngineer(r, 'engineer_cancelled', 'Session annulée', engineerDetails(r), `eng_cancel:${r.id}`);
  }
  if (actor?.role !== 'client') {
    await waClient(r, 'client_cancelled', `votre réservation « ${r.service_name} » (${when(r)}) a été annulée par le studio.${reason ? ` Motif : ${reason}.` : ''} Pour toute question, contactez-nous.`, `client_cancel:${r.id}`);
  }
});

export const engineerAssigned = safe(async (r, eng) => {
  await notifyUser(eng.id, { type: 'session_assigned', title: `Nouvelle session attribuée — ${r.nom}`, body: engineerDetails(r), reservationId: r.id });
  if (eng.phone && (await getSetting('notify_engineer_whatsapp', '1')) === '1') {
    await sendTemplate({ to: eng.phone, template: tpl.adminAlert, params: ['Nouvelle session attribuée', engineerDetails(r)], kind: 'engineer_assigned', reservationId: r.id, dedupeKey: `eng_assign:${r.id}:${eng.id}:${r.start_at}` });
  }
});

export const sessionStatusChanged = safe(async (r, status, actor) => {
  const labels = { en_cours: 'Session démarrée', terminee: 'Session terminée', absent: 'Client absent' };
  if (actor?.role === 'engineer') {
    await notifyStaff({ type: 'session_status', title: `${labels[status]} — ${r.nom}`, body: `Mis à jour par ${actor.first_name}`, reservationId: r.id });
  }
});

export const presenceAnswered = safe(async (r, status) => {
  if (status === 'confirmee') {
    await notifyStaff({ type: 'presence_confirmed', title: `Présence confirmée — ${r.nom}`, body: when(r), reservationId: r.id });
    if (r.engineer_id) await notifyUser(r.engineer_id, { type: 'presence_confirmed', title: `Présence confirmée — ${r.nom}`, body: when(r), reservationId: r.id });
  } else {
    const title = 'Le client souhaite reporter sa session';
    await notifyStaff({ type: 'reschedule_wish', title: `${title} — ${r.nom}`, body: adminDetails(r), reservationId: r.id, financial: true });
    await waAdmin(r, 'admin_reschedule_wish', title, adminDetails(r), `admin_wish:${r.id}:${r.start_at}`);
  }
});

// --- Messages planifiés ---

export const sendReminder = async (r) => {
  const studio = await getSetting('studio_name', 'studio');
  return sendTemplate({
    to: r.telephone,
    template: tpl.reminder,
    params: [r.first_name || r.nom, studio, formatHour(r.start_at)],
    buttons: [{ type: 'quick_reply', payload: `PRESENCE_OK:${r.action_token}` }, { type: 'quick_reply', payload: `PRESENCE_RESCHEDULE:${r.action_token}` }],
    kind: 'client_reminder',
    reservationId: r.id,
    dedupeKey: `reminder:${r.id}:${r.start_at}`
  });
};

export const sendPaymentLink = async (r) => {
  const studio = await getSetting('studio_name', 'studio');
  return sendTemplate({
    to: r.telephone,
    template: tpl.paymentLink,
    params: [r.first_name || r.nom, fcfa(r.solde), studio],
    // Bouton 1 : URL dynamique {FRONTEND_URL}/paiement/{{1}} — Bouton 2 : réponse rapide « Payer en espèces »
    buttons: [{ type: 'url', text: r.action_token }, { type: 'quick_reply', payload: `PAY_CASH:${r.action_token}` }],
    kind: 'client_payment_link',
    reservationId: r.id,
    dedupeKey: `paylink:${r.id}:${r.start_at}`
  });
};

// Réponses en texte libre (fenêtre de 24 h ouverte par le clic du client)
export const replyText = (to, text, r, kind) => sendText({ to, text, kind, reservationId: r?.id || null });

export const scheduledFailure = safe(async (r, what, result) => {
  await notifyStaff({
    type: 'whatsapp_failed',
    title: `${what} non envoyé — ${r.nom}`,
    body: `Statut : ${result?.status || 'erreur'}${result?.error ? ` (${result.error})` : ''}. Contactez le client au +${r.telephone}.`,
    reservationId: r.id
  });
});
