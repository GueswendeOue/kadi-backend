require("dotenv").config();
const express = require("express");
const app = express();

// 📌 MIDDLEWARE CRITIQUE : Parse JSON et conserve le corps brut pour débogage
app.use(express.json({ 
  limit: "2mb",
  verify: (req, res, buf) => {
    req.rawBody = buf.toString(); // Sauvegarde pour vérification
  }
}));
app.use(express.urlencoded({ extended: true }));

// Import du moteur de traitement
const { handleIncomingMessage } = require("./kadiEngine");

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN;

// ✅ Route de santé pour Render
app.get("/", (req, res) => res.status(200).send("✅ Kadi backend is running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ✅ Vérification du webhook (GET - Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const ok = mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN;
  console.log("[GET /webhook] verify:", { mode, ok });

  if (ok) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ✅ Réception des messages (POST - Meta)
app.post("/webhook", async (req, res) => {
  // 🔍 LOGS DE DÉBOGAGE COMPLETS
  console.log("\n🔧 === NOUVELLE REQUÊTE WEBHOOK ===");
  console.log("🔧 Content-Type header:", req.headers["content-type"]);
  console.log("🔧 Raw body (first 500 chars):", req.rawBody?.substring(0, 500) || "UNDEFINED");

  // Répondre IMMÉDIATEMENT à Meta pour éviter les timeout
  res.status(200).send("EVENT_RECEIVED");

  try {
    const body = req.body || {};
    console.log("📩 INCOMING WEBHOOK - Body keys:", Object.keys(body));

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Vérifier si le payload contient des données
    if (!value) {
      console.log("❌ No 'value' found in payload structure.");
      console.log("❌ Full entry structure:", JSON.stringify(entry || {}, null, 2));
      return;
    }

    // 📱 Si c'est un message texte
    if (value.messages && value.messages[0]) {
      const msg = value.messages[0];
      console.log(`✅ MESSAGE DÉTECTÉ!`);
      console.log(`   De: ${msg.from}`);
      console.log(`   Texte: ${msg.text?.body}`);
      console.log(`   Type: ${msg.type}`);
      console.log(`   ID: ${msg.id}`);

      // Déléguer le traitement au moteur principal
      await handleIncomingMessage(value);
    } 
    // 🔄 Si c'est un statut de message (livraison, lecture, etc.)
    else if (value.statuses && value.statuses[0]) {
      console.log(`📊 STATUT REÇU: ${value.statuses[0].status}`);
    }
    // ❌ Si le payload est inattendu
    else {
      console.log("⚠️  Payload reçu mais sans 'messages' ni 'statuses':", JSON.stringify(value, null, 2));
    }

  } catch (error) {
    console.error("💥 ERREUR CRITIQUE dans le traitement du webhook:");
    console.error("   Message:", error.message);
    console.error("   Stack:", error.stack);
  }
});

// 🚀 Démarrer le serveur
app.listen(PORT, () => {
  console.log(`\n🚀 Serveur Kadi démarré sur le port ${PORT}`);
  console.log(`🔗 URL: https://kadi-backend-1gqg.onrender.com`);
  console.log(`✅ Webhook: https://kadi-backend-1gqg.onrender.com/webhook\n`);
});