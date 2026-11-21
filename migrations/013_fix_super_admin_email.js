// Correction de l'adresse du super admin : « paapamatarndiaye@esp.sn » (faute de frappe) → « papamatarndiaye@esp.sn ».
// Un compte client avait été créé sur le site avec la bonne adresse : il est supprimé (ou, s'il a déjà des
// réservations, désactivé et son adresse libérée), puis le super admin reprend la bonne adresse avec son mot de passe.
const TYPO = 'paapamatarndiaye@esp.sn';
const GOOD = 'papamatarndiaye@esp.sn';

export default {
  id: '013_fix_super_admin_email',
  async up(conn) {
    const [[typo]] = await conn.query('SELECT id FROM users WHERE email = ?', [TYPO]);
    const [[good]] = await conn.query('SELECT id, role FROM users WHERE email = ?', [GOOD]);
    if (!typo) {
      // Pas de compte mal orthographié : on s'assure seulement que la bonne adresse n'est pas un compte client
      if (good && good.role === 'client') {
        await conn.query("UPDATE users SET role = 'super_admin', is_active = 1, token_version = token_version + 1 WHERE id = ?", [good.id]);
      }
      return;
    }
    if (good && good.id !== typo.id) {
      const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM reservations WHERE user_id = ?', [good.id]);
      if (Number(n) === 0) {
        await conn.query('DELETE FROM notifications WHERE user_id = ?', [good.id]);
        await conn.query('DELETE FROM users WHERE id = ?', [good.id]);
      } else {
        // Historique conservé : compte désactivé, adresse libérée
        await conn.query('UPDATE users SET is_active = 0, email = ?, token_version = token_version + 1 WHERE id = ?', [`client-${good.id}@compte-desactive.local`, good.id]);
      }
    }
    await conn.query('UPDATE users SET email = ?, token_version = token_version + 1 WHERE id = ?', [GOOD, typo.id]);
  }
};
