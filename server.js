// === server.js ===
// Backend d'intégration PayTech avec création de réservation après paiement

import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import morgan from "morgan";
import crypto from "crypto";
import {
  createReservation,
  checkDuplicateReservation,
  getAllReservations,
  getBookedSlotsForDate,
  getReservationStats,
  updateReservationStatus,
  deleteReservation
} from "./services/reservationService.js";

// Charger les variables d'environnement
dotenv.config();

// === Initialisation serveur ===
const app = express();
const PORT = process.env.PORT || 5000;

// === Configuration PayTech ===
const PAYTECH_BASE_URL = process.env.PAYTECH_BASE_URL || "https://paytech.sn/api";
const PAYTECH_API_KEY = process.env.PAYTECH_API_KEY;
const PAYTECH_API_SECRET = process.env.PAYTECH_API_SECRET;
const PAYTECH_ENV = process.env.PAYTECH_ENV || "prod";
const FRONTEND_URL = (process.env.FRONTEND_URL || "https://westafrecords.com").replace(/\/$/, "");

// === Vérification des variables essentielles ===
if (!PAYTECH_API_KEY || !PAYTECH_API_SECRET) {
  console.error("❌ Clés PayTech manquantes. Vérifie ton fichier .env");
  process.exit(1);
}

// === Middlewares ===
app.use(helmet());
app.set("trust proxy", 1);
const allowedOrigins = (process.env.CORS_ORIGINS ||
  "https://westafrecords.com,https://harmonious-florentine-0eff6a.netlify.app")
  .split(",").map((o) => o.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins,
  allowedHeaders: ["Content-Type", "Authorization"],
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

// === Headers PayTech ===
function paytechHeaders() {
  return {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "API_KEY": PAYTECH_API_KEY,
    "API_SECRET": PAYTECH_API_SECRET
  };
}

// === [1] Créer une requête de paiement ===
app.post("/create-payment", async (req, res) => {
  try {
    const { 
      amount, 
      date,
      name,
      description, 
      target_payment,
      user_phone,
      user_firstname,
      user_lastname,
      reservationData // ✅ NOUVEAU: Données de réservation
    } = req.body;

    // Validation
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ 
        error: true, 
        message: "Montant invalide" 
      });
    }

    // ✅ Validation des données de réservation
    if (!reservationData || !reservationData.nom || !reservationData.email) {
      return res.status(400).json({
        error: true,
        message: "Données de réservation manquantes"
      });
    }

    const ref_command = `CMD_${Date.now()}`;
    const whatsappNumber = "221710162323";
    // Construire le message WhatsApp sans emojis problématiques
    const whatsappMessage = `Bonjour, je confirme ma reservation pour le ${date}. Montant paye : ${amount} XOF. Nom : ${name}`;
    // Encoder correctement pour WhatsApp
    const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(whatsappMessage)}`;


    // ✅ Encoder les données de réservation dans custom_field
    const customFieldData = {
      order_id: ref_command,
      timestamp: Date.now(),
      note: "Paiement Westaf Records",
      reservationData: reservationData // ✅ Inclure toutes les données de réservation
    };

    // Payload PayTech
    const payload = {
      item_name: description || "Commande boutique Westaf Records",
      item_price: Number(amount),
      currency: "XOF",
      ref_command: ref_command,
      command_name: description || "Paiement boutique",
      env: PAYTECH_ENV,
      ipn_url: process.env.PAYTECH_IPN_URL,
      success_url: `${FRONTEND_URL}/?payment=success&ref=${ref_command}`,
      cancel_url: process.env.PAYTECH_CANCEL_URL || `${FRONTEND_URL}/?payment=cancel&ref=${ref_command}`,
      custom_field: JSON.stringify(customFieldData) // ✅ Données encodées
    };

    if (target_payment) {
      payload.target_payment = target_payment;
    }

    if (process.env.PAYTECH_REFUND_NOTIF_URL) {
      payload.refund_notif_url = process.env.PAYTECH_REFUND_NOTIF_URL;
    }

    console.log("📤 Envoi requête PayTech avec données de réservation");

    const response = await axios.post(
      `${PAYTECH_BASE_URL}/payment/request-payment`,
      payload,
      { 
        headers: paytechHeaders(), 
        timeout: 15000 
      }
    );

    const data = response.data;
    console.log("📥 Réponse PayTech:", data);

    if (data.success !== 1 || !data.redirect_url) {
      return res.status(502).json({
        error: true,
        message: "Réponse inattendue de PayTech",
        raw: data
      });
    }

    let redirectUrl = data.redirect_url;

    // Auto-fill si nécessaire
    if (target_payment && 
        !target_payment.includes(',') && 
        user_phone && 
        user_firstname && 
        user_lastname) {
      
      const queryParams = new URLSearchParams({
        'pn': user_phone,
        'nn': user_phone.startsWith('+221') ? user_phone.slice(4) : user_phone,
        'fn': `${user_firstname} ${user_lastname}`,
        'tp': target_payment,
        'nac': target_payment === 'Carte Bancaire' ? '0' : '1'
      });

      redirectUrl += '?' + queryParams.toString();
      console.log("✨ URL avec auto-fill activé");
    }

    res.json({
      success: true,
      token: data.token,
      redirectUrl: redirectUrl,
      ref_command: ref_command
    });

  } catch (error) {
    console.error("❌ Erreur /create-payment:", error.response?.data || error.message);
    res.status(500).json({
      error: true,
      message: error.response?.data?.message || "Erreur lors de la création du paiement",
      details: error.response?.data
    });
  }
});

// === [2] Réception IPN (Webhook PayTech) - AVEC CRÉATION DE RÉSERVATION ===
app.post("/ipn", async (req, res) => {
  try {
    console.log("📩 IPN reçu:", req.body);

    const {
      type_event,
      custom_field,
      ref_command,
      item_name,
      item_price,
      final_item_price,
      initial_item_price,
      promo_enabled,
      promo_value_percent,
      token,
      payment_method,
      client_phone,
      api_key_sha256,
      api_secret_sha256,
      hmac_compute
    } = req.body;

    // === Vérification HMAC-SHA256 ===
    if (hmac_compute) {
      const message = `${final_item_price || item_price}|${ref_command}|${PAYTECH_API_KEY}`;
      const expectedHmac = crypto
        .createHmac('sha256', PAYTECH_API_SECRET)
        .update(message)
        .digest('hex');

      if (expectedHmac !== hmac_compute) {
        console.error("❌ HMAC invalide - IPN non authentique");
        return res.status(403).json({ success: 0, message: "HMAC invalide" });
      }
      console.log("✅ IPN authentifié via HMAC");
    } 
    // === Vérification SHA256 ===
    else if (api_key_sha256 && api_secret_sha256) {
      const expectedApiKey = crypto
        .createHash('sha256')
        .update(PAYTECH_API_KEY)
        .digest('hex');
      
      const expectedApiSecret = crypto
        .createHash('sha256')
        .update(PAYTECH_API_SECRET)
        .digest('hex');

      if (expectedApiKey !== api_key_sha256 || expectedApiSecret !== api_secret_sha256) {
        console.error("❌ Clés SHA256 invalides - IPN non authentique");
        return res.status(403).json({ success: 0, message: "Authentification échouée" });
      }
      console.log("✅ IPN authentifié via SHA256");
    } 
    else {
      console.error("❌ Aucune méthode de vérification trouvée");
      return res.status(403).json({ success: 0, message: "Vérification impossible" });
    }

    // ✅ Décoder custom_field
    let customData = {};
    let reservationData = null;
    
    try {
      // Essayer de parser directement (si JSON)
      customData = JSON.parse(custom_field);
      reservationData = customData.reservationData;
    } catch (e) {
      // Sinon, essayer de décoder depuis Base64
      try {
        const decodedCustomField = Buffer.from(custom_field, 'base64').toString('utf-8');
        customData = JSON.parse(decodedCustomField);
        reservationData = customData.reservationData;
      } catch (e2) {
        console.log("⚠️ Custom field non-JSON ou non encodé:", custom_field);
      }
    }

    // === Traitement selon type d'événement ===
    if (type_event === 'sale_complete') {
      console.log(`✅ Paiement réussi pour ${ref_command}`);
      console.log(`💰 Montant: ${final_item_price || item_price} XOF`);
      console.log(`📱 Méthode: ${payment_method}`);
      console.log(`📞 Client: ${client_phone}`);
      
      if (promo_enabled) {
        console.log(`🎉 Promotion appliquée: ${promo_value_percent}%`);
        console.log(`   Prix initial: ${initial_item_price} XOF → Prix final: ${final_item_price} XOF`);
      }

      // ✅ CRÉER LA RÉSERVATION DANS MYSQL
      if (reservationData) {
        console.log('🎯 Création de la réservation après paiement confirmé...');
        
        // Vérifier les doublons
        const isDuplicate = await checkDuplicateReservation(
          reservationData.email,
          reservationData.date_reservation,
          reservationData.type_service
        );

        if (isDuplicate) {
          console.log('⚠️ Réservation déjà existante, doublon évité');
        } else {
          const result = await createReservation(reservationData);
          
          if (result.success) {
            console.log('✅ Réservation créée avec succès:', result.data.id);
          } else {
            console.error('❌ Échec de la création de la réservation:', result.error);
          }
        }
      } else {
        console.error('❌ Aucune donnée de réservation trouvée dans custom_field');
      }

    } else if (type_event === 'sale_canceled') {
      console.log(`❌ Paiement annulé pour ${ref_command}`);
      console.log('ℹ️ Aucune réservation ne sera créée');
    }

    // Réponse obligatoire
    res.status(200).json({ success: 1, message: "IPN traité avec succès" });

  } catch (err) {
    console.error("❌ Erreur IPN:", err.message);
    res.status(500).json({ success: 0, message: "Erreur serveur" });
  }
});

// === [3] Vérifier le statut d'un paiement ===
app.get("/payment-status", async (req, res) => {
  const { token } = req.query;
  
  if (!token) {
    return res.status(400).json({ 
      error: true, 
      message: "Token requis" 
    });
  }

  try {
    const response = await axios.get(
      `${PAYTECH_BASE_URL}/payment/get-status?token_payment=${encodeURIComponent(token)}`,
      { 
        headers: paytechHeaders(), 
        timeout: 10000 
      }
    );

    res.json({ 
      success: true, 
      data: response.data 
    });

  } catch (err) {
    console.error("❌ Erreur /payment-status:", err.response?.data || err.message);
    res.status(500).json({ 
      error: true, 
      message: err.response?.data?.message || "Erreur lors de la vérification du statut" 
    });
  }
});

// === [4] Remboursement d'un paiement ===
app.post("/refund", async (req, res) => {
  const { ref_command } = req.body;
  
  if (!ref_command) {
    return res.status(400).json({ 
      error: true, 
      message: "ref_command requis" 
    });
  }

  try {
    const response = await axios.post(
      `${PAYTECH_BASE_URL}/payment/refund-payment`,
      { ref_command },
      { 
        headers: paytechHeaders(),
        timeout: 10000
      }
    );

    console.log("✅ Remboursement initié:", response.data);
    res.json({ 
      success: true, 
      data: response.data 
    });

  } catch (err) {
    console.error("❌ Erreur /refund:", err.response?.data || err.message);
    res.status(500).json({ 
      error: true, 
      message: err.response?.data?.message || "Erreur lors du remboursement" 
    });
  }
});

// === Réservations : routes publiques ===
app.get("/reservations/slots", async (req, res) => {
  const { date } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    return res.status(400).json({ error: true, message: "Date invalide" });
  }
  try {
    res.json({ slots: await getBookedSlotsForDate(date) });
  } catch (err) {
    console.error("❌ /reservations/slots:", err.message);
    res.status(500).json({ error: true, message: "Erreur serveur" });
  }
});

app.get("/reservations/stats", async (req, res) => {
  try {
    res.json(await getReservationStats());
  } catch (err) {
    console.error("❌ /reservations/stats:", err.message);
    res.status(500).json({ error: true, message: "Erreur serveur" });
  }
});

// === Admin (authentification vérifiée côté serveur) ===
const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
const signToken = (exp) =>
  `${exp}.${crypto.createHmac("sha256", ADMIN_TOKEN_SECRET).update(String(exp)).digest("hex")}`;

const safeEqual = (a, b) => {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const requireAdmin = (req, res, next) => {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  const [exp, sig] = token.split(".");
  if (ADMIN_TOKEN_SECRET && exp && sig && Number(exp) > Date.now() && safeEqual(token, signToken(exp))) {
    return next();
  }
  res.status(401).json({ error: true, message: "Non autorisé" });
};

app.post("/admin/login", (req, res) => {
  const { login, password } = req.body || {};
  if (!ADMIN_TOKEN_SECRET || !process.env.ADMIN_LOGIN || !process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: true, message: "Admin non configuré" });
  }
  if (safeEqual(login, process.env.ADMIN_LOGIN) && safeEqual(password, process.env.ADMIN_PASSWORD)) {
    return res.json({ token: signToken(Date.now() + 8 * 60 * 60 * 1000) });
  }
  res.status(401).json({ error: true, message: "Identifiants incorrects" });
});

app.get("/admin/reservations", requireAdmin, async (req, res) => {
  try {
    res.json({ reservations: await getAllReservations() });
  } catch (err) {
    console.error("❌ /admin/reservations:", err.message);
    res.status(500).json({ error: true, message: "Erreur serveur" });
  }
});

app.patch("/admin/reservations/:id", requireAdmin, async (req, res) => {
  const { statut } = req.body || {};
  if (!["en_attente", "confirmee", "annulee"].includes(statut)) {
    return res.status(400).json({ error: true, message: "Statut invalide" });
  }
  try {
    const ok = await updateReservationStatus(req.params.id, statut);
    res.status(ok ? 200 : 404).json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: true, message: "Erreur serveur" });
  }
});

app.delete("/admin/reservations/:id", requireAdmin, async (req, res) => {
  try {
    const ok = await deleteReservation(req.params.id);
    res.status(ok ? 200 : 404).json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: true, message: "Erreur serveur" });
  }
});

// === [5] Route de test ===
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    environment: PAYTECH_ENV,
    timestamp: new Date().toISOString(),
    paytech_configured: !!(PAYTECH_API_KEY && PAYTECH_API_SECRET)
  });
});

// === Gestion des erreurs 404 ===
app.use((req, res) => {
  res.status(404).json({ 
    error: true, 
    message: "Route non trouvée" 
  });
});

// === Lancement du serveur ===
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║   🚀 Backend PayTech lancé avec succès!      ║
╠═══════════════════════════════════════════════╣
║   Port        : ${PORT.toString().padEnd(29)}║
║   Environnement: ${PAYTECH_ENV.padEnd(29)}║
║   Base URL    : ${PAYTECH_BASE_URL.padEnd(29)}║
╚═══════════════════════════════════════════════╝
  `);
  
  console.log("\n📋 Routes disponibles:");
  console.log("  POST /create-payment      → Créer un paiement");
  console.log("  POST /ipn                 → Webhook PayTech (IPN)");
  console.log("  GET  /payment-status      → Vérifier statut paiement");
  console.log("  POST /refund              → Rembourser un paiement");
  console.log("  GET  /health              → Vérifier l'état du serveur");
  console.log("\n✅ Réservations créées automatiquement après paiement confirmé!\n");
});