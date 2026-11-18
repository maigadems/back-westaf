// Import d'images (services, équipements, galerie) sur le disque du serveur.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { config } from '../config/env.js';
import { badRequest } from '../lib/http.js';

export const uploadRoot = path.resolve(config.uploadDir);
fs.mkdirSync(uploadRoot, { recursive: true });

const MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif' };

export const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadRoot),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${MIME[file.mimetype]}`)
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 12 },
  fileFilter: (_req, file, cb) => {
    if (!MIME[file.mimetype]) return cb(badRequest('Format d’image non accepté (JPEG, PNG, WebP ou AVIF)'));
    cb(null, true);
  }
});

// Vérifie la signature binaire (le type MIME envoyé par le navigateur n'est pas fiable)
const looksLikeImage = (file) => {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0);
    fs.closeSync(fd);
    const hex = b.toString('hex');
    return hex.startsWith('ffd8ff') || hex.startsWith('89504e47') || (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') || b.toString('ascii', 4, 12).startsWith('ftypavi');
  } catch {
    return false;
  }
};

export const publicPathFor = (file) => {
  if (!looksLikeImage(file.path)) {
    fs.rmSync(file.path, { force: true });
    throw badRequest('Le fichier n’est pas une image valide');
  }
  return `/uploads/${file.filename}`;
};

export const removeUpload = (url) => {
  if (!url || !String(url).startsWith('/uploads/')) return;
  const name = path.basename(String(url));
  fs.rm(path.join(uploadRoot, name), { force: true }, () => {});
};
