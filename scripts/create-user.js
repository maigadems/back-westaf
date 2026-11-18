// Création manuelle d'un compte d'équipe :
//   npm run create-user -- --role super_admin --email moi@exemple.com --first "Prénom" --last "Nom" [--password "..."]
// Sans --password, un mot de passe provisoire est généré et affiché une seule fois.
import '../config/env.js';
import { pool } from '../config/db.js';
import { runMigrations } from '../migrations/index.js';
import { generatePassword, validateNewPassword } from '../lib/password.js';
import { createUser } from '../services/userService.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);

try {
  const role = args.role || 'admin';
  if (!['super_admin', 'admin', 'engineer'].includes(role)) throw new Error('--role doit être super_admin, admin ou engineer');
  if (!args.email) throw new Error('--email requis');
  const password = args.password || generatePassword();
  const err = validateNewPassword(password);
  if (err) throw new Error(err);
  await runMigrations({ log: () => {} });
  const u = await createUser({ role, email: args.email, first_name: args.first || '', last_name: args.last || '', password, must_change_password: 1 });
  console.log(`✅ Compte ${role} créé : ${u.email}`);
  if (!args.password) console.log(`🔑 Mot de passe provisoire : ${password}`);
} catch (e) {
  console.error('❌', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
