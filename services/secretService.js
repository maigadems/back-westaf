// Secrets persistés en base, créés une seule fois au premier démarrage (table app_secrets).
// Ils ne sont jamais renvoyés par l'API ni écrits dans le code.
import { one, q } from '../config/db.js';

export const getOrCreateSecret = async (name, make) => {
  const row = await one('SELECT value FROM app_secrets WHERE name = ?', [name]);
  if (row) return row.value;
  // INSERT IGNORE : si deux instances démarrent en même temps, la première valeur écrite gagne
  await q('INSERT IGNORE INTO app_secrets (name, value) VALUES (?, ?)', [name, make()]);
  return (await one('SELECT value FROM app_secrets WHERE name = ?', [name])).value;
};
