// Factures : émission automatique au premier encaissement, consultation client / admin.
import { q, one, tx } from '../config/db.js';
import { notFound, badRequest } from '../lib/http.js';
import { getSettings } from './settingsService.js';
import { getReservation } from './reservationService.js';
import { config } from '../config/env.js';
import { sendInvoiceEmail } from './emailService.js';
import { renderInvoicePdfBuffer } from './invoicePdf.js';
import { sendTemplate } from './whatsappService.js';

/**
 * Émet la facture d'une réservation si elle n'existe pas encore (idempotent).
 * Le numéro est attribué dans une transaction : aucune rupture ni doublon de numérotation.
 */
export const ensureInvoice = async (reservationId) => {
  const existing = await one('SELECT id FROM invoices WHERE reservation_id = ?', [reservationId]);
  if (existing) return existing.id;
  const r = await one('SELECT id, user_id, nom, email, telephone FROM reservations WHERE id = ?', [reservationId]);
  if (!r) return null;
  const prefix = ((await getSettings()).invoice_prefix || 'WR').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'WR';
  try {
    return await tx(async (conn) => {
      const year = new Date().getUTCFullYear();
      await conn.query('INSERT INTO invoice_counters (year, last_number) VALUES (?, 0) ON DUPLICATE KEY UPDATE year = year', [year]);
      const [[c]] = await conn.query('SELECT last_number FROM invoice_counters WHERE year = ? FOR UPDATE', [year]);
      const n = c.last_number + 1;
      await conn.query('UPDATE invoice_counters SET last_number = ? WHERE year = ?', [n, year]);
      const [ins] = await conn.query(
        'INSERT INTO invoices (number, reservation_id, user_id, client_name, client_email, client_phone, issued_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
        [`${prefix}-${year}-${String(n).padStart(4, '0')}`, r.id, r.user_id, r.nom, r.email || null, r.telephone || null]
      );
      return ins.insertId;
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return (await one('SELECT id FROM invoices WHERE reservation_id = ?', [reservationId]))?.id || null;
    throw e;
  }
};

// Émission « silencieuse » après un paiement : ne bloque jamais l'encaissement
export const issueAfterPayment = async (reservationId) => {
  try {
    const id = await ensureInvoice(reservationId);
    // Après chaque paiement réussi, la facture à jour est envoyée au client (e-mail + WhatsApp)
    if (id) await sendInvoice(id, { email: true, whatsapp: true, reason: 'payment' });
  } catch (e) {
    console.error('❌ Facture non émise ou non envoyée pour', reservationId, e.message);
  }
};

export const invoiceShareUrl = (token) => `${config.frontendUrl}/facture/${token}`;

/**
 * Envoie la facture au client : e-mail (PDF joint) et/ou WhatsApp (lien de téléchargement).
 * Retourne le résultat par canal : 'sent' | 'not_configured' | 'no_contact' | 'failed'.
 */
export const sendInvoice = async (invoiceId, { email = true, whatsapp = true, reason = 'manual' } = {}) => {
  const inv = await getInvoice(invoiceId);
  const r = await one('SELECT action_token, telephone, email FROM reservations WHERE id = ?', [inv.reservation.id]);
  const link = invoiceShareUrl(r.action_token);
  const result = {};
  if (email) {
    const to = inv.client.email || r.email;
    if (!to) result.email = 'no_contact';
    else {
      const sent = await sendInvoiceEmail(to, inv, await renderInvoicePdfBuffer(inv), link);
      result.email = sent.sent ? 'sent' : sent.reason === 'smtp_not_configured' ? 'not_configured' : 'failed';
    }
  }
  if (whatsapp) {
    const phone = inv.client.phone || r.telephone;
    if (!phone) result.whatsapp = 'no_contact';
    else {
      const money = (n) => `${Number(n || 0).toLocaleString('fr-FR')} FCFA`;
      const text = `votre facture N° ${inv.number} (${inv.reservation.service_name}) est disponible. Réglé : ${money(inv.paid)}${inv.due > 0 ? `, reste à payer : ${money(inv.due)}` : ' (soldée)'}. Téléchargez-la ici : ${link}`;
      const wa = await sendTemplate({
        to: phone, template: config.whatsapp.templates.clientUpdate, params: [inv.client.name.split(' ')[0] || inv.client.name, text],
        kind: 'client_invoice', reservationId: inv.reservation.id,
        // Un seul envoi automatique par état de paiement de la facture ; les envois manuels ne sont pas dédoublonnés
        dedupeKey: reason === 'payment' ? `invoice:${inv.id}:${inv.paid}` : null
      });
      result.whatsapp = wa.skipped ? 'sent' : wa.ok ? 'sent' : wa.status === 'not_configured' ? 'not_configured' : 'failed';
    }
  }
  return result;
};

export const getInvoiceByToken = async (token) => {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) throw notFound('Lien invalide');
  const row = await one('SELECT i.id FROM invoices i JOIN reservations r ON r.id = i.reservation_id WHERE r.action_token = ?', [token]);
  if (!row) throw notFound('Aucune facture pour le moment');
  return getInvoice(row.id);
};

const METHOD = { cash: 'Espèces', online: 'Paiement en ligne' };

const buildLines = (r, service) => {
  if (r.addon_service_id && r.addon_unit_price) {
    const qty = Number(r.nombre_titres || 1);
    const addonTotal = Number(r.addon_unit_price) * qty;
    const mainTotal = Number(r.montant_total) - addonTotal;
    const mainUnit = qty > 0 && mainTotal % qty === 0 ? mainTotal / qty : null;
    return [
      mainUnit !== null
        ? { label: r.base_service_name, detail: null, quantity: qty, unit: 'titre', unit_price: mainUnit, total: mainTotal }
        : { label: r.base_service_name, detail: `${qty} titre(s)`, quantity: 1, unit: 'forfait', unit_price: mainTotal, total: mainTotal },
      { label: r.addon_name || 'Mastering', detail: 'En option avec le mixage', quantity: qty, unit: 'titre', unit_price: Number(r.addon_unit_price), total: addonTotal }
    ];
  }
  const total = Number(r.montant_total);
  const qty = r.booking_mode === 'slot' ? Number(r.duree_heures || 1) : Number(r.nombre_titres || 1);
  const unit = r.booking_mode === 'slot' ? 'heure' : 'titre';
  const detail = r.start_at ? `Session du ${r.start_at.slice(8, 10)}/${r.start_at.slice(5, 7)}/${r.start_at.slice(0, 4)}, ${r.start_at.slice(11, 16)} – ${String(r.end_at).slice(11, 16)}` : null;
  // Tarif unitaire affiché seulement s'il correspond exactement au total
  const unitPrice = qty > 0 && total % qty === 0 ? total / qty : null;
  if (unitPrice !== null && (!service?.price || service.price === unitPrice)) {
    return [{ label: r.base_service_name || r.service_name, detail, quantity: qty, unit, unit_price: unitPrice, total }];
  }
  return [{ label: r.base_service_name || r.service_name, detail: detail ? `${detail} · ${qty} ${unit}(s)` : `${qty} ${unit}(s)`, quantity: 1, unit: 'forfait', unit_price: total, total }];
};

const statusOf = (r, paid) => (['annulee'].includes(r.statut) ? 'annulee' : paid >= Number(r.montant_total) ? 'payee' : 'partielle');

export const getInvoice = async (id) => {
  const inv = await one('SELECT * FROM invoices WHERE id = ?', [Number(id)]);
  if (!inv) throw notFound('Facture introuvable');
  const r = await getReservation(inv.reservation_id);
  const service = r?.service_id ? await one('SELECT price FROM services WHERE id = ?', [r.service_id]) : null;
  const payments = await q(
    `SELECT p.id, p.amount, p.method, p.provider_method, p.kind, p.ref_command, p.completed_at, m.label AS milestone_label
     FROM payments p LEFT JOIN order_milestones m ON m.id = p.milestone_id
     WHERE p.reservation_id = ? AND p.status = 'completed' ORDER BY p.completed_at, p.id`,
    [inv.reservation_id]
  );
  const paid = payments.reduce((s, p) => s + Number(p.amount), 0);
  const s = await getSettings();
  return {
    id: inv.id,
    number: inv.number,
    issued_at: inv.issued_at,
    user_id: inv.user_id,
    share_url: invoiceShareUrl((await one('SELECT action_token FROM reservations WHERE id = ?', [inv.reservation_id]))?.action_token),
    status: statusOf(r, paid),
    currency: 'FCFA',
    issuer: {
      name: s.invoice_company_name || s.studio_name,
      address: s.invoice_address || s.address,
      phone: s.contact_phone,
      email: s.contact_email,
      ninea: s.invoice_ninea || null,
      rccm: s.invoice_rccm || null,
      footer: s.invoice_footer || null
    },
    client: { name: inv.client_name, email: inv.client_email, phone: inv.client_phone },
    reservation: { id: r.id, service_name: r.service_name, start_at: r.start_at, end_at: r.end_at, statut: r.statut },
    lines: buildLines(r, service),
    total: Number(r.montant_total),
    paid,
    due: Math.max(0, Number(r.montant_total) - paid),
    payments: payments.map((p) => ({
      id: p.id, date: p.completed_at, amount: Number(p.amount), reference: p.ref_command,
      label: `${p.milestone_label || (p.kind === 'initial' ? 'Paiement à la réservation' : 'Solde')} · ${p.method === 'online' && p.provider_method ? p.provider_method : METHOD[p.method]}`
    }))
  };
};

export const listInvoices = async ({ userId, search, from, to, status } = {}) => {
  const where = [];
  const params = [];
  if (userId) { where.push('i.user_id = ?'); params.push(userId); }
  if (search) { where.push('(i.number LIKE ? OR i.client_name LIKE ? OR i.client_email LIKE ? OR i.client_phone LIKE ?)'); const s = `%${search}%`; params.push(s, s, s, s); }
  if (from) { where.push('DATE(i.issued_at) >= ?'); params.push(from); }
  if (to) { where.push('DATE(i.issued_at) <= ?'); params.push(to); }
  const rows = await q(
    `SELECT i.id, i.number, i.issued_at, i.client_name, i.client_email, i.reservation_id, r.montant_total, r.statut,
            COALESCE(s.name, r.type_service) AS service_name, r.start_at,
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.reservation_id = r.id AND p.status = 'completed'), 0) AS paid
     FROM invoices i JOIN reservations r ON r.id = i.reservation_id LEFT JOIN services s ON s.id = r.service_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.issued_at DESC, i.id DESC LIMIT 2000`,
    params
  );
  const out = rows.map((r) => {
    const paid = Number(r.paid);
    const total = Number(r.montant_total);
    return { id: r.id, number: r.number, issued_at: r.issued_at, client_name: r.client_name, client_email: r.client_email, reservation_id: r.reservation_id,
      service_name: r.service_name, start_at: r.start_at, total, paid, due: Math.max(0, total - paid), status: statusOf(r, paid) };
  });
  return status ? out.filter((i) => i.status === status) : out;
};

// Émission manuelle par l'administration (réservation avec au moins un paiement encaissé)
export const issueManually = async (reservationId) => {
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM payments WHERE reservation_id = ? AND status = 'completed'", [reservationId]);
  if (!Number(n)) throw badRequest('Aucun paiement encaissé : la facture est émise au premier encaissement');
  return ensureInvoice(reservationId);
};
