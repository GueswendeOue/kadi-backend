require("dotenv").config();
const express = require("express");
const app = express();

// 📌 MIDDLEWARE CRITIQUE
app.use(express.json({ 
  limit: "2mb",
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.urlencoded({ extended: true }));

const { handleIncomingMessage } = require("./kadiEngine");

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "kadi_verify_12345";

// ✅ Routes de santé
app.get("/", (req, res) => {
  console.log("✅ GET / appelé");
  res.status(200).send("✅ Kadi backend is running");
});

app.get("/health", (req, res) => {
  console.log("✅ GET /health appelé");
  res.status(200).json({ 
    ok: true, 
    service: "kadi-backend",
    webhook: "https://kadi-backend-1gqg.onrender.com/webhook"
  });
});

// ✅ Webhook verification (GET - Meta)
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

// ✅ Webhook receive (POST - Meta messages)
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
      req.rawBody?.substring(0, 300) || "VIDE");
    
    // Parse le JSON
    const body = req.body || {};
    console.log("📦 Body parsé keys:", Object.keys(body));
    
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    
    if (!value) {
      console.log("⚠️  Aucun 'value' dans le payload");
      console.log("⚠️  Structure complète:", JSON.stringify(body, null, 2));
      return;
    }
    
    console.log("✅ Payload valide, appel du moteur...");
    
    // Appel asynchrone au moteur de traitement
    handleIncomingMessage(value).catch(err => {
      console.error(`💥 Erreur dans handleIncomingMessage:`, err.message);
    });
    
  } catch (error) {
    console.error(`💥 ERREUR FATALE dans webhook [${requestId}]:`, error.message);
    console.error("Stack:", error.stack);
  }
  
  console.log(`📩 === FIN WEBHOOK [${requestId}] ===\n`);
});

// 🚀 Démarrage du serveur
app.listen(PORT, () => {
  console.log(`\n🚀 ==========================================`);
  console.log(`🚀 Serveur Kadi démarré sur le port ${PORT}`);
  console.log(`🚀 URL: https://kadi-backend-1gqg.onrender.com`);
  console.log(`🚀 Webhook: https://kadi-backend-1gqg.onrender.com/webhook`);
  console.log(`🚀 Health: https://kadi-backend-1gqg.onrender.com/health`);
  console.log(`🚀 ==========================================\n`);
  
  // Log des variables critiques (sans les valeurs)
  console.log("🔧 Configuration chargée:");
  console.log(`🔧 VERIFY_TOKEN: ${VERIFY_TOKEN ? "PRÉSENT" : "MANQUANT"}`);
  console.log(`🔧 PORT: ${PORT}`);
});