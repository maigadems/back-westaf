// === server.js ===
// Backend d'intégration PayTech conforme à la documentation officielle
// Documentation : https://docs.intech.sn/doc_paytech.php

import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import morgan from "morgan";
import crypto from "crypto";


// Charger les variables d'environnement
dotenv.config();

// === Initialisation serveur ===
const app = express();
const PORT = process.env.PORT || 5000;

// === Configuration PayTech (selon documentation) ===
const PAYTECH_BASE_URL = process.env.PAYTECH_BASE_URL || "https://paytech.sn/api";
const PAYTECH_API_KEY = process.env.PAYTECH_API_KEY;
const PAYTECH_API_SECRET = process.env.PAYTECH_API_SECRET; // ⚠️ Nom corrigé
const PAYTECH_ENV = process.env.PAYTECH_ENV || "prod"; // "test" ou "prod"

// === Vérification des variables essentielles ===
if (!PAYTECH_API_KEY || !PAYTECH_API_SECRET) {
  console.error("❌ Clés PayTech manquantes. Vérifie ton fichier .env");
  process.exit(1);
}

// === Middlewares ===
app.use(helmet());
app.use(cors({
  origin: ["https://westafrecords.com", "https://harmonious-florentine-0eff6a.netlify.app"],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Pour traiter les IPN
app.use(morgan("dev"));

// === Headers PayTech (selon documentation) ===
function paytechHeaders() {
  return {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "API_KEY": PAYTECH_API_KEY,        // ⚠️ Format header corrigé
    "API_SECRET": PAYTECH_API_SECRET   // ⚠️ Format header corrigé
  };
}

// === [1] Créer une requête de paiement (conforme à la doc) ===
app.post("/create-payment", async (req, res) => {
  try {
    const { 
      amount, 
      date,
      name,
      description, 
      target_payment,
      user_phone,      // Nouveau : pour auto-fill
      user_firstname,  // Nouveau : pour auto-fill
      user_lastname    // Nouveau : pour auto-fill
    } = req.body;

    // Validation
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ 
        error: true, 
        message: "Montant invalide" 
      });
    }

    const ref_command = `CMD_${Date.now()}`;
    const whatsappNumber = "221710162323";
    const whatsappMessage = `✅ Bonjour, je confirme ma réservation pour le ${encodeURIComponent(date)}.\n💰 Montant payé : ${amount} XOF\n👤 Nom : ${encodeURIComponent(name)}`;
    const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(whatsappMessage)}`;
    // Payload selon documentation PayTech
    const payload = {
      item_name: description || "Commande boutique Westaf Records",
      item_price: Number(amount),
      currency: "XOF",
      ref_command: ref_command,
      command_name: description || "Paiement boutique",
      env: PAYTECH_ENV,
      ipn_url: process.env.PAYTECH_IPN_URL,
      success_url: whatsappUrl,
      cancel_url: process.env.PAYTECH_CANCEL_URL,
      custom_field: JSON.stringify({ 
        order_id: ref_command,
        timestamp: Date.now(),
        note: "Paiement Westaf Records" 
      })
    };

    // Ajouter target_payment si spécifié (voir doc: méthodes de paiement ciblées)
    if (target_payment) {
      payload.target_payment = target_payment; // ex: "Wave", "Orange Money"
    }

    // Ajouter refund_notif_url si défini
    if (process.env.PAYTECH_REFUND_NOTIF_URL) {
      payload.refund_notif_url = process.env.PAYTECH_REFUND_NOTIF_URL;
    }

    console.log("📤 Envoi requête PayTech:", payload);

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

    // Structure de réponse selon doc: { success: 1, token: "...", redirect_url: "..." }
    if (data.success !== 1 || !data.redirect_url) {
      return res.status(502).json({
        error: true,
        message: "Réponse inattendue de PayTech",
        raw: data
      });
    }

    let redirectUrl = data.redirect_url;

    // Auto-fill si méthode unique et infos utilisateur fournies (selon doc)
    if (target_payment && 
        !target_payment.includes(',') && 
        user_phone && 
        user_firstname && 
        user_lastname) {
      
      const queryParams = new URLSearchParams({
        'pn': user_phone,                                    // +221777777777
        'nn': user_phone.startsWith('+221') ? user_phone.slice(4) : user_phone,
        'fn': `${user_firstname} ${user_lastname}`,         // Nom complet
        'tp': target_payment,                               // Même valeur que target_payment
        'nac': target_payment === 'Carte Bancaire' ? '0' : '1' // Auto-submit
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

// === [2] Réception IPN (Webhook PayTech) - Sécurisé selon doc ===
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

    // === MÉTHODE 1: Vérification HMAC-SHA256 (Recommandée par la doc) ===
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
    // === MÉTHODE 2: Vérification SHA256 (Alternative) ===
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

    // Décoder custom_field depuis Base64 (selon doc)
    let customData = {};
    try {
      const decodedCustomField = Buffer.from(custom_field, 'base64').toString('utf-8');
      customData = JSON.parse(decodedCustomField);
    } catch (e) {
      console.log("⚠️ Custom field non-JSON ou non encodé:", custom_field);
    }

    // Traitement selon type d'événement
    if (type_event === 'sale_complete') {
      console.log(`✅ Paiement réussi pour ${ref_command}`);
      console.log(`💰 Montant: ${final_item_price || item_price} XOF`);
      console.log(`📱 Méthode: ${payment_method}`);
      console.log(`📞 Client: ${client_phone}`);
      
      if (promo_enabled) {
        console.log(`🎉 Promotion appliquée: ${promo_value_percent}%`);
        console.log(`   Prix initial: ${initial_item_price} XOF → Prix final: ${final_item_price} XOF`);
      }

      // TODO: Mettre à jour votre base de données
      // updateOrderStatus(ref_command, 'paid', {
      //   finalPrice: final_item_price,
      //   paymentMethod: payment_method,
      //   customData: customData
      // });

      // TODO: Envoyer email de confirmation
      // sendConfirmationEmail(customData.email);

    } else if (type_event === 'sale_canceled') {
      console.log(`❌ Paiement annulé pour ${ref_command}`);
      
      // TODO: Mettre à jour votre base de données
      // updateOrderStatus(ref_command, 'canceled');
    }

    // Réponse obligatoire selon doc
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

// === [5] Route de test (sanity check) ===
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
  console.log("\n⚠️  N'oubliez pas de configurer vos URLs IPN en HTTPS!\n");
});