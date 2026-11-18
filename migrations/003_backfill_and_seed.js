// Rattache les données existantes au nouveau schéma et insère la configuration
// initiale réelle du studio (services, horaires et équipements repris du site actuel).
import crypto from 'crypto';
import { legacySlotsToRange, hoursBetween } from '../lib/time.js';
import { intlPhone, localPhone } from '../lib/phone.js';

const SERVICES = [
  {
    slug: 'enregistrement-studio', legacy: 'horaire', name: 'Enregistrement studio', booking_mode: 'slot',
    price: 30000, price_unit: 'heure', min_hours: 1, max_hours: 8, allow_deposit: 1, deposit_percent: 50,
    tagline: 'Réservez le studio à l’heure, du lundi au samedi.',
    description: 'Sessions d’enregistrement en cabine avec un ingénieur du son. Voix, instruments, podcasts : réservez le nombre d’heures dont vous avez besoin, sur des créneaux consécutifs.',
    features: ['Enregistrement professionnel', 'Support technique', 'Fichiers de vos sessions', 'Acompte de 50 % possible'],
    is_featured: 1, sort_order: 1
  },
  {
    slug: 'mixage', legacy: 'mixage', name: 'Mixage de titre', booking_mode: 'per_track',
    price: 150000, price_unit: 'titre', tagline: 'Mixage professionnel de votre titre.',
    description: 'Équilibre, égalisation, dynamique et effets : votre titre prend sa forme définitive, prêt pour le mastering.',
    features: ['Mixage professionnel', 'Égalisation avancée', 'Effets et traitements', '3 révisions incluses', 'Paiement échelonné possible'],
    is_featured: 1, sort_order: 2
  },
  {
    slug: 'mastering', legacy: 'mastering', name: 'Mastering', booking_mode: 'per_track',
    price: 70000, price_unit: 'titre', tagline: 'Finalisation de votre titre.',
    description: 'Dernière étape avant la sortie : niveau, cohérence et optimisation pour la diffusion radio et streaming.',
    features: ['Mastering professionnel', 'Optimisation pour diffusion', 'Loudness standardisé', 'Formats multiples', 'Qualité radio/streaming'],
    is_featured: 1, sort_order: 3
  },
  { slug: 'composition-musicale', name: 'Composition musicale', booking_mode: 'quote', tagline: 'Création de productions originales.', features: [], sort_order: 4 },
  { slug: 'voix-off', name: 'Voix off', booking_mode: 'quote', tagline: 'Enregistrement de voix off publicitaires et institutionnelles.', features: [], sort_order: 5 },
  { slug: 'conception-jingle', name: 'Conception de jingle', booking_mode: 'quote', tagline: 'Identités sonores pour radios, marques et événements.', features: [], sort_order: 6 }
];

// Matériel listé sur le site actuel (section « Équipement Pro ») + filtre anti-pop visible sur les photos du studio
const EQUIPMENT = [
  ['Microphones', ['Neumann TLM 103', 'AKG 414', 'Série Shure SM58', 'Série Shure SM57']],
  ['Préamplis & interfaces', ['Neve 1073SPX', 'Universal Audio', 'Universal Audio Apollo X8', 'Universal Audio Apollo Twin']],
  ['Monitoring', ['Adam Audio T7V', 'Avantone']],
  ['Instruments', ['Guitare basse', 'Guitare électrique', 'Guitare nylon', 'Yamaha DX7', 'Korg Kross']],
  ['Casques', ['Focal MG Pro', 'Focal Celestee']],
  ['Accessoires', ['Filtre anti-pop Alctron PF06']]
];

const SETTINGS = {
  studio_name: 'Westaf Records',
  whatsapp_admin_number: '221778600482',
  contact_phone: '+221 77 860 04 82',
  contact_phone_2: '+221 33 825 79 51',
  contact_email: 'contact@westafrecords.com',
  contact_email_2: 'prod@westafrecords.com',
  address: 'Almadies, Dakar',
  maps_url: 'https://www.google.com/maps?q=14.7370071411133,-17.49489402771',
  instagram_url: 'https://www.instagram.com/westafrecords',
  snapchat_url: 'https://t.snapchat.com/Y4O4g5fy',
  booking_window_days: '30',
  min_lead_minutes: '20',
  hold_minutes: '30',
  reminder_minutes_before: '120',
  payment_link_minutes_before: '10',
  reschedule_limit_minutes: '120',
  respect_engineer_unavailability: '1',
  notify_engineer_whatsapp: '1'
};

export default {
  id: '003_backfill_and_seed',
  async up(conn) {
    // --- Paramètres ---
    for (const [k, v] of Object.entries(SETTINGS)) {
      await conn.query('INSERT IGNORE INTO settings (skey, svalue) VALUES (?, ?)', [k, v]);
    }

    // --- Horaires : lundi–samedi 08h–00h, dimanche fermé (règles du calendrier actuel) ---
    for (let d = 0; d < 7; d++) {
      await conn.query(
        'INSERT IGNORE INTO opening_hours (weekday, is_open, open_time, close_time) VALUES (?, ?, ?, ?)',
        [d, d === 0 ? 0 : 1, '08:00', '24:00']
      );
    }

    // --- Services ---
    const serviceIds = {};
    for (const s of SERVICES) {
      await conn.query(
        `INSERT IGNORE INTO services (slug, name, tagline, description, booking_mode, price, price_unit, min_hours, max_hours,
           allow_deposit, deposit_percent, features, is_active, is_featured, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [s.slug, s.name, s.tagline || null, s.description || null, s.booking_mode, s.price ?? null, s.price_unit || null,
          s.min_hours || 1, s.max_hours || 8, s.allow_deposit || 0, s.deposit_percent ?? 50, JSON.stringify(s.features || []),
          s.is_featured || 0, s.sort_order]
      );
      const [[row]] = await conn.query('SELECT id FROM services WHERE slug = ?', [s.slug]);
      if (s.legacy) serviceIds[s.legacy] = row.id;
    }

    // --- Équipements ---
    const [[{ n: eqCount }]] = await conn.query('SELECT COUNT(*) AS n FROM equipment');
    if (!eqCount) {
      let order = 0;
      for (const [category, names] of EQUIPMENT) {
        for (const name of names) {
          await conn.query('INSERT INTO equipment (name, category, is_public, is_featured, sort_order) VALUES (?, ?, 1, 0, ?)', [name, category, ++order]);
        }
      }
    }

    // --- Comptes clients historiques (clé = téléphone) -> users ---
    const [clients] = await conn.query('SELECT * FROM clients');
    for (const c of clients) {
      const [[exists]] = await conn.query('SELECT id FROM users WHERE legacy_phone = ?', [c.telephone]);
      if (exists) continue;
      // E-mail retrouvé dans les réservations de ce numéro
      const [resEmails] = await conn.query(
        `SELECT LOWER(email) AS email FROM reservations
         WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(telephone, '+', ''), ' ', ''), '-', ''), '.', ''), '00221', '') IN (?, ?)
         ORDER BY created_at DESC`,
        [c.telephone, `221${c.telephone}`]
      );
      let email = null;
      for (const r of resEmails) {
        const [[taken]] = await conn.query('SELECT id FROM users WHERE email = ?', [r.email]);
        if (!taken && r.email && r.email.includes('@')) { email = r.email; break; }
      }
      const [first, ...rest] = String(c.nom || '').trim().split(/\s+/);
      await conn.query(
        `INSERT INTO users (role, first_name, last_name, email, phone, legacy_phone, password_hash, must_change_password, created_at)
         VALUES ('client', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [first || '', rest.join(' '), email, intlPhone(c.telephone), c.telephone, c.password_hash, c.must_change_password ? 1 : 0, c.created_at]
      );
    }

    // --- Réservations historiques ---
    const [reservations] = await conn.query('SELECT * FROM reservations');
    for (const r of reservations) {
      const mail = String(r.email || '').trim().toLowerCase();
      let [[user]] = await conn.query('SELECT id FROM users WHERE email = ?', [mail]);
      if (!user) [[user]] = await conn.query('SELECT id FROM users WHERE legacy_phone = ?', [localPhone(r.telephone)]);
      if (!user && mail.includes('@')) {
        // Client ayant réservé avant la création des comptes : compte sans mot de passe,
        // récupérable via « Mot de passe oublié » ou Google avec le même e-mail.
        const [first, ...rest] = String(r.nom || '').trim().split(/\s+/);
        const [ins] = await conn.query(
          "INSERT INTO users (role, first_name, last_name, email, phone) VALUES ('client', ?, ?, ?, ?)",
          [first || '', rest.join(' '), mail, intlPhone(r.telephone)]
        );
        user = { id: ins.insertId };
      }

      let range = null;
      if (r.creneaux) {
        try { range = legacySlotsToRange(String(r.date_reservation).slice(0, 10), JSON.parse(r.creneaux)); } catch { range = null; }
      }
      const paid = Number(r.montant_paye) >= Number(r.montant_total) && Number(r.montant_total) > 0;
      const paymentStatus = paid ? 'paye' : Number(r.montant_paye) > 0 ? 'acompte' : 'non_paye';
      const sessionStatus = r.statut === 'annulee' ? 'annulee' : paid && range ? 'autorisee' : 'planifiee';

      await conn.query(
        `UPDATE reservations SET user_id = COALESCE(user_id, ?), service_id = COALESCE(service_id, ?),
           start_at = COALESCE(start_at, ?), end_at = COALESCE(end_at, ?), payment_status = ?, session_status = ?,
           action_token = COALESCE(action_token, ?)
         WHERE id = ?`,
        [user?.id || null, serviceIds[r.type_service] || null, range?.start || null, range?.end || null,
          paymentStatus, sessionStatus, crypto.randomBytes(24).toString('hex'), r.id]
      );

      if (range && r.statut !== 'annulee') {
        for (const hour of hoursBetween(range.start, range.end)) {
          await conn.query('INSERT IGNORE INTO slot_locks (slot_start, reservation_id) VALUES (?, ?)', [hour, r.id]);
        }
      }
      if (Number(r.montant_paye) > 0) {
        await conn.query(
          `INSERT IGNORE INTO payments (reservation_id, ref_command, kind, method, amount, status, created_at, completed_at)
           VALUES (?, ?, 'initial', 'online', ?, 'completed', ?, ?)`,
          [r.id, `LEGACY_${r.id}`, r.montant_paye, r.created_at, r.created_at]
        );
      }
      await conn.query(
        "INSERT INTO reservation_history (reservation_id, actor_role, action, details) VALUES (?, 'system', 'migration', ?)",
        [r.id, JSON.stringify({ message: 'Réservation reprise depuis l’ancien système' })]
      );
    }
  }
};
