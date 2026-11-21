// Option ajoutée à une commande : ex. mastering commandé en même temps que le mixage d'un titre.
// Le tarif unitaire de l'option est figé au moment de la commande.
export default {
  id: '008_order_addon',
  async up(conn, h) {
    await h.addColumn('reservations', 'addon_service_id', 'INT UNSIGNED NULL AFTER service_id');
    await h.addColumn('reservations', 'addon_unit_price', 'INT NULL AFTER addon_service_id');
  }
};
