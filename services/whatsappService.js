// Intégration WhatsApp Cloud API (Meta). Aucun envoi n'est simulé : si l'API n'est pas
// configurée, le message est journalisé avec le statut « not_configured » et l'équipe
// voit l'échec dans l'administration.
import axios from 'axios';
import crypto from 'crypto';
import { q, pool } from '../config/db.js';
import { config, whatsappConfigured } from '../config/env.js';
import { intlPhone } from '../lib/phone.js';
import { getSetting } from './settingsService.js';

// Mode manuel (par défaut) : aucun message automatique n'est envoyé ni journalisé
export const whatsappAutoEnabled = async () => (await getSetting('whatsapp_auto', '0')) === '1';

const apiBase = () => (process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com').replace(/\/$/, '');

// Contraintes Meta sur les paramètres de modèle : pas de retour à la ligne, de tabulation
// ni plus de 4 espaces consécutifs ; 1024 caractères maximum.
export const cleanParam = (s) =>
  String(s ?? '')
    .replace(/[\r\n\t]+/g, ' · ')
    .replace(/ {4,}/g, '   ')
    .trim()
    .slice(0, 1000) || '-';

const postToApi = async (body) => {
  const url = `${apiBase()}/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;
  const res = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });
  return res.data?.messages?.[0]?.id || null;
};

/**
 * Envoie un message (modèle ou texte libre) et le journalise.
 * dedupeKey : un même message ne part jamais deux fois (contrainte UNIQUE).
 */
const send = async ({ to, kind, reservationId = null, dedupeKey = null, template = null, body }) => {
  if (!(await whatsappAutoEnabled())) return { ok: false, status: 'manual', skipped: true };
  const phone = intlPhone(to);
  if (!phone) {
    await q('INSERT INTO whatsapp_messages (direction, kind, reservation_id, to_phone, template, status, error) VALUES (?,?,?,?,?,?,?)', [
      'out', kind, reservationId, String(to || '').slice(0, 20), template, 'failed', 'Numéro de téléphone invalide'
    ]);
    return { ok: false, status: 'failed', error: 'invalid_phone' };
  }
  body.to = phone;

  let logId;
  try {
    const [res] = await pool.query(
      'INSERT INTO whatsapp_messages (direction, dedupe_key, kind, reservation_id, to_phone, template, payload, status) VALUES (?,?,?,?,?,?,?,?)',
      ['out', dedupeKey, kind, reservationId, phone, template, JSON.stringify(body).slice(0, 8000), 'pending']
    );
    logId = res.insertId;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return { ok: true, status: 'duplicate', skipped: true };
    throw e;
  }

  if (!whatsappConfigured()) {
    await q("UPDATE whatsapp_messages SET status = 'not_configured', error = ? WHERE id = ?", [
      'WhatsApp Cloud API non configurée (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)', logId
    ]);
    return { ok: false, status: 'not_configured' };
  }

  try {
    const providerId = await postToApi(body);
    await q("UPDATE whatsapp_messages SET status = 'sent', provider_id = ? WHERE id = ?", [providerId, logId]);
    return { ok: true, status: 'sent', providerId };
  } catch (e) {
    const err = e.response?.data?.error?.message || e.message;
    console.error(`❌ WhatsApp (${kind}) vers ${phone}:`, err);
    await q("UPDATE whatsapp_messages SET status = 'failed', error = ? WHERE id = ?", [String(err).slice(0, 2000), logId]);
    return { ok: false, status: 'failed', error: err };
  }
};

/**
 * Message basé sur un modèle approuvé (obligatoire hors fenêtre de 24 h).
 * buttons : [{ type: 'quick_reply', payload }] ou [{ type: 'url', text }] dans l'ordre des boutons du modèle.
 */
export const sendTemplate = ({ to, template, params = [], buttons = [], kind, reservationId, dedupeKey }) => {
  const components = [];
  if (params.length) components.push({ type: 'body', parameters: params.map((p) => ({ type: 'text', text: cleanParam(p) })) });
  buttons.forEach((b, index) => {
    if (!b) return;
    components.push(
      b.type === 'url'
        ? { type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: b.text }] }
        : { type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload: b.payload }] }
    );
  });
  return send({
    to, kind, reservationId, dedupeKey, template,
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      type: 'template',
      template: { name: template, language: { code: config.whatsapp.lang }, components }
    }
  });
};

// Texte libre : uniquement dans les 24 h suivant un message du client (réponse aux boutons)
export const sendText = ({ to, text, kind, reservationId, dedupeKey }) =>
  send({
    to, kind, reservationId, dedupeKey,
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', type: 'text', text: { preview_url: true, body: String(text).slice(0, 4000) } }
  });

// Vérification de la signature X-Hub-Signature-256 des webhooks Meta
export const verifyWebhookSignature = (rawBody, header) => {
  if (!config.whatsapp.appSecret) return false;
  if (!rawBody || !header || !String(header).startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
  const got = String(header).slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
};

// Extrait les événements utiles d'un webhook Meta
export const parseWebhook = (body) => {
  const inbound = [];
  const statuses = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const m of v.messages || []) {
        let payload = null;
        let text = null;
        if (m.type === 'button') { payload = m.button?.payload || null; text = m.button?.text || null; }
        else if (m.type === 'interactive') { payload = m.interactive?.button_reply?.id || null; text = m.interactive?.button_reply?.title || null; }
        else if (m.type === 'text') text = m.text?.body || null;
        inbound.push({ id: m.id, from: m.from, type: m.type, payload, text });
      }
      for (const s of v.statuses || []) statuses.push({ id: s.id, status: s.status, error: s.errors?.[0]?.title || null });
    }
  }
  return { inbound, statuses };
};

export const recordInbound = async (msg) => {
  try {
    await q('INSERT INTO whatsapp_messages (direction, dedupe_key, kind, to_phone, payload, status, provider_id) VALUES (?,?,?,?,?,?,?)', [
      'in', `in:${msg.id}`, msg.payload ? 'button_reply' : 'text', msg.from, JSON.stringify(msg).slice(0, 4000), 'received', msg.id
    ]);
    return true;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return false; // webhook déjà traité (Meta renvoie parfois les événements)
    throw e;
  }
};

export const recordStatus = async (s) => {
  await q('UPDATE whatsapp_messages SET status = ?, error = COALESCE(?, error) WHERE provider_id = ? AND direction = ?', [
    s.status, s.error, s.id, 'out'
  ]);
};

export const listMessages = async ({ limit = 100, reservationId } = {}) =>
  q(
    `SELECT id, direction, kind, reservation_id, to_phone, template, status, error, created_at FROM whatsapp_messages
     ${reservationId ? 'WHERE reservation_id = ?' : ''} ORDER BY id DESC LIMIT ?`,
    reservationId ? [reservationId, limit] : [limit]
  );
