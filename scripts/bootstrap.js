// Création des comptes initiaux à partir des variables d'environnement (une seule fois).
//  - SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD : créé s'il n'existe aucun super admin
//  - ADMIN_EMAIL / ADMIN_PASSWORD : compte administrateur de Jeuss, créé s'il n'existe aucun admin
//  - sans SUPER_ADMIN_EMAIL : les identifiants de l'ancien serveur (ADMIN_LOGIN / ADMIN_PASSWORD) deviennent
//    le super admin, avec le même mot de passe qu'avant (aucune variable à ajouter sur l'hébergement)
// Les comptes sont créés avec « changement de mot de passe obligatoire » à la première connexion.
import { q } from '../config/db.js';
import { config } from '../config/env.js';
import { validateNewPassword } from '../lib/password.js';
import { createUser, findUserByEmail } from '../services/userService.js';

const ensure = async (role, email, password, firstName, { legacy = false } = {}) => {
  if (!email || !password) return;
  const [{ n }] = await q('SELECT COUNT(*) AS n FROM users WHERE role = ?', [role]);
  if (Number(n) > 0) return;
  if (!legacy) {
    if (!email.includes('@')) return console.warn(`⚠️  ${role} : adresse e-mail invalide dans .env`);
    const err = validateNewPassword(password);
    if (err) return console.warn(`⚠️  ${role} non créé : ${err}`);
  }
  const existing = await findUserByEmail(email);
  if (existing) {
    await q('UPDATE users SET role = ?, is_active = 1, token_version = token_version + 1 WHERE id = ?', [role, existing.id]);
    return console.log(`👤 Compte existant ${email} promu ${role}`);
  }
  // Ancien compte : mot de passe déjà choisi par le studio, pas de changement imposé
  await createUser({ role, first_name: firstName, last_name: '', email, password, must_change_password: legacy ? 0 : 1 });
  console.log(`👤 Compte ${role} créé : ${email}${legacy ? ' (identifiants de l’ancien serveur)' : ' (mot de passe à changer à la première connexion)'}`);
};

export const bootstrapAccounts = async () => {
  const b = config.bootstrap;
  if (b.superAdminEmail) await ensure('super_admin', b.superAdminEmail, b.superAdminPassword, 'Super');
  else await ensure('super_admin', b.legacyLogin.trim(), b.adminPassword, b.adminFirstName, { legacy: true });
  if (b.adminEmail) await ensure('admin', b.adminEmail, b.adminPassword, b.adminFirstName);
};
