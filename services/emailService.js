import nodemailer from 'nodemailer';
import { config, smtpConfigured } from '../config/env.js';
import { getSetting } from './settingsService.js';

let transporter = null;
const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass }
    });
  }
  return transporter;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const layout = (studio, title, bodyHtml) => `<!doctype html><html><body style="margin:0;background:#0b0b0d;font-family:Arial,Helvetica,sans-serif;color:#e7e5e4">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#141417;border:1px solid #27272a;border-radius:14px;overflow:hidden">
<tr><td style="padding:28px 32px;border-bottom:1px solid #27272a"><span style="font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#f97316">${esc(studio)}</span>
<h1 style="margin:10px 0 0;font-size:22px;color:#fafaf9">${esc(title)}</h1></td></tr>
<tr><td style="padding:28px 32px;font-size:15px;line-height:1.6;color:#d6d3d1">${bodyHtml}</td></tr>
</table></td></tr></table></body></html>`;

const button = (href, label) =>
  `<p style="margin:28px 0"><a href="${esc(href)}" style="background:linear-gradient(90deg,#f97316,#dc2626);color:#fff;text-decoration:none;padding:14px 26px;border-radius:999px;font-weight:bold;display:inline-block">${esc(label)}</a></p>`;

/**
 * Envoi réel via SMTP. Si le SMTP n'est pas configuré, rien n'est envoyé
 * et l'appelant reçoit { sent: false, reason }.
 */
export const sendMail = async ({ to, subject, html, text }) => {
  if (!smtpConfigured()) {
    console.warn(`✉️  SMTP non configuré : e-mail « ${subject} » non envoyé à ${to}`);
    return { sent: false, reason: 'smtp_not_configured' };
  }
  try {
    const studio = await getSetting('studio_name', 'Studio');
    await getTransporter().sendMail({ from: `"${studio}" <${config.smtp.from}>`, to, subject, html, text });
    return { sent: true };
  } catch (e) {
    console.error('❌ Envoi e-mail:', e.message);
    return { sent: false, reason: e.message };
  }
};

export const sendPasswordResetEmail = async (user, link) => {
  const studio = await getSetting('studio_name', 'Studio');
  return sendMail({
    to: user.email,
    subject: `${studio} — Réinitialisation de votre mot de passe`,
    text: `Bonjour ${user.first_name || ''},\n\nPour définir un nouveau mot de passe, ouvrez ce lien (valable 1 heure) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.`,
    html: layout(studio, 'Réinitialisation du mot de passe',
      `<p>Bonjour ${esc(user.first_name || '')},</p><p>Vous avez demandé à réinitialiser votre mot de passe. Ce lien est valable <strong>1 heure</strong> et ne peut être utilisé qu'une fois.</p>${button(link, 'Définir un nouveau mot de passe')}<p style="font-size:13px;color:#a8a29e">Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail : votre mot de passe actuel reste inchangé.</p>`)
  });
};

export const sendBookingEmail = async (to, { title, lines, link, linkLabel }) => {
  if (!to) return { sent: false, reason: 'no_email' };
  const studio = await getSetting('studio_name', 'Studio');
  return sendMail({
    to,
    subject: `${studio} — ${title}`,
    text: `${lines.join('\n')}${link ? `\n\n${link}` : ''}`,
    html: layout(studio, title, `${lines.map((l) => `<p style="margin:6px 0">${esc(l)}</p>`).join('')}${link ? button(link, linkLabel || 'Voir mon espace') : ''}`)
  });
};
