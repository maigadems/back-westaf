// Sessions longues : l'ancien calendrier permettait d'enchaîner tous les créneaux consécutifs
// (08h–00h, soit 16 h). On rétablit ce maximum pour l'enregistrement studio, uniquement si la
// valeur initiale (8 h) n'a pas été modifiée depuis l'administration.
export default {
  id: '005_long_sessions',
  async up(conn) {
    await conn.query("UPDATE services SET max_hours = 16 WHERE slug = 'enregistrement-studio' AND max_hours = 8");
  }
};
