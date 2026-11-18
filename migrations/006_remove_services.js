// Retrait des services « Coaching vocal » et « Direction artistique » (demande du studio).
// Supprimés s'ils ne sont liés à aucune réservation ; sinon simplement masqués (historique conservé).
const SLUGS = ['coaching-vocal', 'direction-artistique'];

export default {
  id: '006_remove_services',
  async up(conn) {
    for (const slug of SLUGS) {
      const [[svc]] = await conn.query('SELECT id, image_url FROM services WHERE slug = ?', [slug]);
      if (!svc) continue;
      const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM reservations WHERE service_id = ?', [svc.id]);
      if (Number(n) > 0) await conn.query('UPDATE services SET is_active = 0, is_featured = 0 WHERE id = ?', [svc.id]);
      else await conn.query('DELETE FROM services WHERE id = ?', [svc.id]);
    }
  }
};
