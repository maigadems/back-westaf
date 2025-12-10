import { supabase } from '../config/supabase.js';

/**
 * Créer une réservation dans Supabase après confirmation de paiement
 */
export const createReservation = async (reservationData) => {
  try {
    console.log('📝 Création de la réservation:', reservationData);

    const { data, error } = await supabase
      .from('reservations')
      .insert([{
        nom: reservationData.nom,
        email: reservationData.email,
        telephone: reservationData.telephone,
        message: reservationData.message || '',
        date_reservation: reservationData.date_reservation,
        creneaux: reservationData.creneaux || null,
        duree_heures: reservationData.duree_heures || null,
        montant_total: reservationData.montant_total,
        type_service: reservationData.type_service,
        nombre_titres: reservationData.nombre_titres || null,
        statut: 'confirmee' // Statut confirmé car paiement validé
      }])
      .select()
      .single();

    if (error) {
      console.error('❌ Erreur Supabase lors de la création:', error);
      return { success: false, error: error.message };
    }

    console.log('✅ Réservation créée avec succès:', data.id);
    return { success: true, data };

  } catch (error) {
    console.error('❌ Erreur lors de la création de la réservation:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Vérifier si une réservation existe déjà pour éviter les doublons
 */
export const checkDuplicateReservation = async (email, date_reservation, type_service) => {
  try {
    const { data, error } = await supabase
      .from('reservations')
      .select('id')
      .eq('email', email)
      .eq('date_reservation', date_reservation)
      .eq('type_service', type_service)
      .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString()); // 5 minutes

    if (error) {
      console.error('❌ Erreur lors de la vérification des doublons:', error);
      return false;
    }

    return data && data.length > 0;
  } catch (error) {
    console.error('❌ Erreur lors de la vérification:', error);
    return false;
  }
};