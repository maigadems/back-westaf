// Génération du PDF d'une facture (A4) avec pdfkit.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import { Writable } from 'stream';

const LOGO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'invoice-logo.jpg');
const INK = '#18181b';
const MUTED = '#71717a';
const LINE = '#e4e4e7';
const ACCENT = '#D9531A';

// Les polices PDF standard ne connaissent pas l'espace fine insécable utilisée par fr-FR
const money = (n) => `${Number(n || 0).toLocaleString('fr-FR').replace(/[  ]/g, ' ')} F CFA`;
const dateFr = (s) => (s ? `${String(s).slice(8, 10)}/${String(s).slice(5, 7)}/${String(s).slice(0, 4)}` : '');
const phone = (p) => {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 9) d = `221${d}`;
  return d.length === 12 && d.startsWith('221') ? `+221 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8, 10)} ${d.slice(10)}` : d ? `+${d}` : '';
};
const STATUS = { payee: 'Payée', partielle: 'Partiellement payée', annulee: 'Réservation annulée' };

export const invoiceFilename = (inv) => `facture-${inv.number}.pdf`;

/** Écrit le PDF de la facture dans le flux `out` (réponse HTTP). */
export const renderInvoicePdf = (inv, out) => {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Facture ${inv.number}`, Author: inv.issuer.name } });
  doc.pipe(out);
  const L = 50;
  const R = doc.page.width - 50;
  const W = R - L;

  // --- En-tête : émetteur à gauche, titre à droite
  let y = 50;
  if (fs.existsSync(LOGO)) doc.image(LOGO, L, y, { width: 46, height: 46 });
  const ix = fs.existsSync(LOGO) ? L + 58 : L;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(inv.issuer.name.toUpperCase(), ix, y, { width: 260 });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  const issuerLines = [inv.issuer.address, inv.issuer.phone, inv.issuer.email,
    inv.issuer.ninea && `NINEA : ${inv.issuer.ninea}`, inv.issuer.rccm && `RCCM : ${inv.issuer.rccm}`].filter(Boolean);
  doc.text(issuerLines.join('\n'), ix, y + 18, { width: 260, lineGap: 2 });

  doc.font('Helvetica-Bold').fontSize(24).fillColor(INK).text('FACTURE', L, y - 2, { width: W, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(10).text(`N° ${inv.number}`, L, y + 30, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    .text(`Date : ${dateFr(inv.issued_at)}`, L, y + 45, { width: W, align: 'right' })
    .text(`Réf. réservation : ${inv.reservation.id.slice(0, 8).toUpperCase()}`, L, y + 58, { width: W, align: 'right' });

  y = Math.max(doc.y, y + 80) + 18;
  doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).lineWidth(1).stroke();

  // --- Client / statut
  y += 18;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('FACTURÉ À', L, y);
  doc.text('STATUT', L, y, { width: W, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(inv.client.name, L, y + 13, { width: 300 });
  doc.text(STATUS[inv.status] || inv.status, L, y + 13, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text([inv.client.email, phone(inv.client.phone)].filter(Boolean).join('\n'), L, y + 29, { width: 300, lineGap: 2 });

  // --- Lignes
  y = Math.max(doc.y, y + 40) + 24;
  const col = { label: L, qty: L + W * 0.52, unit: L + W * 0.66, total: L + W * 0.82 };
  doc.rect(L, y, W, 22).fill('#f4f4f5');
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
  doc.text('DÉSIGNATION', col.label + 8, y + 7);
  doc.text('QTÉ', col.qty, y + 7, { width: W * 0.12, align: 'right' });
  doc.text('PRIX UNITAIRE', col.unit, y + 7, { width: W * 0.15, align: 'right' });
  doc.text('MONTANT', col.total, y + 7, { width: W * 0.18 - 8, align: 'right' });
  y += 30;
  for (const l of inv.lines) {
    const qty = l.unit === 'forfait' ? '1' : `${l.quantity} ${l.unit}${l.quantity > 1 ? 's' : ''}`;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(l.label, col.label + 8, y, { width: W * 0.5 - 8 });
    const afterLabel = doc.y;
    if (l.detail) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(l.detail, col.label + 8, afterLabel + 1, { width: W * 0.5 - 8 });
    const rowEnd = doc.y;
    doc.font('Helvetica').fontSize(10).fillColor(INK).text(qty, col.qty, y, { width: W * 0.12, align: 'right' });
    doc.text(money(l.unit_price), col.unit, y, { width: W * 0.15, align: 'right' });
    doc.font('Helvetica-Bold').text(money(l.total), col.total, y, { width: W * 0.18 - 8, align: 'right' });
    y = Math.max(rowEnd, y + 14) + 10;
    doc.moveTo(L, y).lineTo(R, y).strokeColor(LINE).stroke();
    y += 10;
  }

  // --- Totaux
  const tx = L + W * 0.55;
  const tw = W * 0.45;
  const totalRow = (label, value, bold = false, size = 10) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(INK);
    doc.text(label, tx, y, { width: tw / 2 });
    doc.text(value, tx + tw / 2, y, { width: tw / 2, align: 'right' });
    y += size + 9;
  };
  y += 6;
  totalRow('Total', money(inv.total), true);
  totalRow('Déjà réglé', money(inv.paid));
  doc.moveTo(tx, y - 2).lineTo(R, y - 2).strokeColor(INK).lineWidth(0.8).stroke();
  y += 6;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(inv.due > 0 ? ACCENT : INK);
  doc.text('Reste à payer', tx, y, { width: tw / 2 });
  doc.text(money(inv.due), tx + tw / 2, y, { width: tw / 2, align: 'right' });
  y += 34;

  // --- Règlements
  if (inv.payments.length) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('RÈGLEMENTS REÇUS', L, y);
    y += 16;
    for (const p of inv.payments) {
      doc.font('Helvetica').fontSize(9).fillColor(INK);
      doc.text(dateFr(p.date), L, y, { width: 70 });
      doc.text(p.label, L + 75, y, { width: W - 75 - 110 });
      doc.text(money(p.amount), R - 110, y, { width: 110, align: 'right' });
      y = Math.max(doc.y, y + 12) + 6;
      doc.moveTo(L, y - 3).lineTo(R, y - 3).strokeColor('#f4f4f5').lineWidth(1).stroke();
    }
  }

  // --- Pied de page
  doc.page.margins.bottom = 0; // évite un saut de page automatique pour le pied de page
  const fy = doc.page.height - 80;
  doc.moveTo(L, fy).lineTo(R, fy).strokeColor(LINE).stroke();
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  if (inv.issuer.footer) doc.text(inv.issuer.footer, L, fy + 12, { width: W, align: 'center' });
  doc.text('Montants en francs CFA (XOF).', L, fy + (inv.issuer.footer ? 26 : 12), { width: W, align: 'center' });

  doc.end();
};

/** Génère le PDF en mémoire (Buffer), pour l'envoyer par e-mail. */
export const renderInvoicePdfBuffer = (inv) => new Promise((resolve, reject) => {
  const chunks = [];
  const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
  sink.on('finish', () => resolve(Buffer.concat(chunks)));
  sink.on('error', reject);
  renderInvoicePdf(inv, sink);
});
