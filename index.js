require("dotenv").config();
const express = require("express");
const app = express();

// 📌 MIDDLEWARE CRITIQUE : Parse JSON et conserve le corps brut
app.use(express.json({ 
  limit: "2mb",
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true }));

// Import du moteur de traitement
const { handleIncomingMessage } = require("./kadiEngine");

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "kadi_verify_12345";

// ✅ Route de santé
app.get("/", (req, res) => {
  console.log("✅ GET / appelé");
  res.status(200).send("✅ Kadi backend is running");
});

app.get("/health", (req, res) => {
  console.log("✅ GET /health appelé");
  res.status(200).json({ 
    ok: true, 
    service: "kadi-backend",
    webhook: "https://kadi-backend-1gqg.onrender.com/webhook",
    timestamp: new Date().toISOString()
  });
});

// ✅ Webhook verification (GET) - Pour Meta
app.get("/webhook", (req, res) => {
  console.log("\n🔍 === META VALIDATION REQUEST ===");
  console.log("🔍 Query params:", req.query);
  
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log(`🔍 Mode: ${mode}, Token reçu: ${token}, Challenge: ${challenge}`);
  console.log(`🔍 VERIFY_TOKEN configuré: ${VERIFY_TOKEN}`);

  const ok = mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN;
  
  console.log(`🔍 Validation: ${ok ? "✅ SUCCÈS" : "❌ ÉCHEC"}`);

  if (ok) {
    console.log("✅ Envoi du challenge à Meta");
    return res.status(200).send(challenge);
  }
  
  console.log("❌ Token invalide ou mode incorrect");
  return res.sendStatus(403);
});

// ✅ Webhook receive (POST) - Pour les messages Meta
app.post("/webhook", async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`\n📩 === POST WEBHOOK [${requestId}] ===`);
  console.log(`📩 Heure: ${new Date().toISOString()}`);
  
  // FORCE l'envoi immédiat de la réponse à Meta
  res.status(200).send("EVENT_RECEIVED");
  console.log("📩 Réponse 'EVENT_RECEIVED' envoyée à Meta");
  
  try {
    // Log des headers
    console.log("📩 Headers:", {
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"],
      "x-forwarded-for": req.headers["x-forwarded-for"]
    });
    
    // Log du body brut
    console.log(`📩 Raw Body (${req.rawBody?.length || 0} chars):`, 
      req.rawBody?.substring(0, 500) || "VIDE");
    
    // Parse le JSON
    const body = req.body || {};
    console.log("📦 Body parsé keys:", Object.keys(body));
    
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    
    if (!value) {
      console.log("⚠️  Aucun 'value' trouvé dans le payload");
      console.log("⚠️  Structure complète:", JSON.stringify(body, null, 2));
      return;
    }
    
    console.log("✅ Payload valide, appel du moteur...");
    
    // Appel asynchrone au moteur de traitement
    handleIncomingMessage(value).catch(err => {
      console.error(`💥 Erreur dans handleIncomingMessage:`, err.message);
      console.error("Stack:", err.stack);
    });
    
  } catch (error) {
    console.error(`💥 ERREUR FATALE dans webhook [${requestId}]:`, error.message);
    console.error("Stack:", error.stack);
  }
  
  console.log(`📩 === FIN WEBHOOK [${requestId}] ===\n`);
});

// ==========================================
// ✅ ROUTE DE TEST MANUEL (SIMULATION META)
// ==========================================
app.post("/test-meta", async (req, res) => {
  console.log("\n🧪 === TEST MANUEL - SIMULATION META ===");
  
  // Crée un payload IDENTIQUE à ce que Meta envoie
  const testPayload = {
    object: "whatsapp_business_account",
    entry: [{
      id: "1391377726000371",
      changes: [{
        value: {
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: "15551845266",
            phone_number_id: process.env.PHONE_NUMBER_ID || "878545622015226"
          },
          contacts: [{
            profile: { name: "Test" },
            wa_id: "22670626055"
          }],
          messages: [{
            from: "22670626055",
            id: "wamid.test.123",
            timestamp: "1767479215",
            text: { body: "Menu" },
            type: "text"
          }]
        },
        field: "messages"
      }]
    }]
  };
  
  try {
    console.log("🧪 Envoi du payload au moteur...");
    await handleIncomingMessage(testPayload.entry[0].changes[0].value);
    console.log("🧪 Test RÉUSSI ! Le code fonctionne correctement.");
    res.json({ 
      ok: true, 
      message: "Test exécuté avec succès",
      conclusion: "✅ Ton code fonctionne. Le problème est dans la config Meta."
    });
  } catch (error) {
    console.error("🧪 ERREUR dans le test:", error.message);
    console.error("Stack:", error.stack);
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      conclusion: "❌ Ton code a un bug. Vérifie kadiEngine.js"
    });
  }
  
  console.log("🧪 === FIN TEST MANUEL ===\n");
});

// ==========================================
// ✅ ROUTE DE TEST SIMPLE (CURL)
// ==========================================
app.post("/test-simple", (req, res) => {
  console.log("\n🔧 === TEST SIMPLE ===");
  console.log("🔧 Body reçu:", req.body);
  console.log("🔧 Headers:", req.headers);
  res.json({ 
    ok: true, 
    message: "Test simple réussi",
    received: req.body,
    timestamp: new Date().toISOString()
  });
  console.log("🔧 === FIN TEST SIMPLE ===\n");
});

// 🚀 Démarrage du serveur
app.listen(PORT, () => {
  const baseUrl = "https://kadi-backend-1gqg.onrender.com";
  
  console.log("\n" + "=".repeat(50));
  console.log("🚀 SERVEUR KADI DÉMARRÉ");
  console.log("=".repeat(50));
  console.log(`📌 Port: ${PORT}`);
  console.log(`🌐 URL: ${baseUrl}`);
  console.log(`🔗 Webhook: ${baseUrl}/webhook`);
  console.log(`🏥 Health: ${baseUrl}/health`);
  console.log(`🧪 Test Meta: ${baseUrl}/test-meta`);
  console.log(`🔧 Test Simple: ${baseUrl}/test-simple`);
  console.log("=".repeat(50));
  console.log("\n🔍 Configuration:");
  console.log(`   VERIFY_TOKEN: ${VERIFY_TOKEN ? "✅ PRÉSENT" : "❌ MANQUANT"}`);
  console.log(`   PORT: ${PORT}`);
  console.log("\n⚠️  IMPORTANT: Vérifie que Meta Webhooks est configuré avec:");
  console.log(`   URL: ${baseUrl}/webhook`);
  console.log(`   Token: ${VERIFY_TOKEN}`);
  console.log(`   Abonnement: "messages" ✅`);
  console.log("=".repeat(50) + "\n");
});