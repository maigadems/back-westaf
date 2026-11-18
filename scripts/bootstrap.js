// Création des comptes initiaux à partir des variables d'environnement (une seule fois).
//  - SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD : créé s'il n'existe aucun super admin
//  - ADMIN_EMAIL / ADMIN_PASSWORD : compte administrateur de Jeuss, créé s'il n'existe aucun admin
// Les comptes sont créés avec « changement de mot de passe obligatoire » à la première connexion.
import { q } from '../config/db.js';
import { config } from '../config/env.js';
import { validateNewPassword } from '../lib/password.js';
import { createUser, findUserByEmail } from '../services/userService.js';

const ensure = async (role, email, password, firstName) => {
  if (!email || !password) return;
  const [{ n }] = await q('SELECT COUNT(*) AS n FROM users WHERE role = ?', [role]);
  if (Number(n) > 0) return;
  if (!email.includes('@')) return console.warn(`⚠️  ${role} : adresse e-mail invalide dans .env`);
  const err = validateNewPassword(password);
  if (err) return console.warn(`⚠️  ${role} non créé : ${err}`);
  const existing = await findUserByEmail(email);
  if (existing) {
    await q('UPDATE users SET role = ?, is_active = 1, token_version = token_version + 1 WHERE id = ?', [role, existing.id]);
    return console.log(`👤 Compte existant ${email} promu ${role}`);
  }
  await createUser({ role, first_name: firstName, last_name: '', email, password, must_change_password: 1 });
  console.log(`👤 Compte ${role} créé : ${email} (mot de passe à changer à la première connexion)`);
};

export const bootstrapAccounts = async () => {
  const b = config.bootstrap;
  await ensure('super_admin', b.superAdminEmail, b.superAdminPassword, 'Super');
  await ensure('admin', b.adminEmail, b.adminPassword, b.adminFirstName);
};
