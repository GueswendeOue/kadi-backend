const express = require("express");
const dotenv = require("dotenv");
const { getSession, setMode, resetSession } = require("./kadiState");
const { sendTextMessage } = require("./whatsapp");

dotenv.config();

const app = express();

// IMPORTANT: Meta envoie du JSON en POST webhook
app.use(express.json({ limit: "5mb" }));

// Petit ping
app.get("/", (req, res) => {
  res.status(200).send("Kadi backend is running ✅");
});

/**
 * DEBUG ENV (ne montre pas les secrets, juste si c'est présent)
 * Tu l'as déjà, je le garde, mais en version safe.
 */
app.get("/debug-env", (req, res) => {
  const safe = (v) => (v ? "set" : "missing");
  res.json({
    NODE_ENV: process.env.NODE_ENV || "unknown",
    VERIFY_TOKEN: safe(process.env.VERIFY_TOKEN),
    WHATSAPP_TOKEN: safe(process.env.WHATSAPP_TOKEN),
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || "missing",
    WHATSAPP_WABA_ID: safe(process.env.WHATSAPP_WABA_ID),
    GRAPH_VERSION: process.env.GRAPH_VERSION || "v22.0",
  });
});

/**
 * WEBHOOK VERIFY (Meta -> GET)
 * Meta envoie: hub.mode, hub.verify_token, hub.challenge
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const ok =
    mode === "subscribe" && token && token === process.env.VERIFY_TOKEN;

  console.log("[GET /webhook] verify:", {
    mode,
    token_ok: !!token && token === process.env.VERIFY_TOKEN,
  });

  if (ok) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }

  console.log("❌ Webhook verify failed");
  return res.sendStatus(403);
});

/**
 * WEBHOOK EVENTS (Meta -> POST)
 * Ici tu reçois les messages entrants et statuts.
 */
app.post("/webhook", async (req, res) => {
  try {
    // Toujours répondre 200 vite, sinon Meta va retry
    res.sendStatus(200);

    console.log("📩 Incoming webhook:", JSON.stringify(req.body, null, 2));

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const phoneNumberId = value?.metadata?.phone_number_id;
    const messages = value?.messages || [];
    const message = messages[0];

    // Si pas un message entrant, on ignore (ex: status updates)
    if (!message) return;

    const from = message.from; // wa_id expéditeur
    const text = message?.text?.body?.trim();

    console.log("💬 Message reçu:", { from, text, phoneNumberId });

    if (!text) return;

    // --- LOGIQUE KADI SIMPLE ---
    // Exemple : si l'utilisateur écrit "Menu", on répond.
    if (text.toLowerCase() === "menu") {
      await sendTextMessage(from, `✅ Kadi est en ligne.\nChoisis:\n1) Devis\n2) Facture\n3) Reçu\nTape 1, 2 ou 3.`);
      return;
    }

    if (text === "1") {
      setMode(from, "devis");
      await sendTextMessage(from, "🧾 Mode DEVIS activé. Dis-moi: Nom client + montant + description.");
      return;
    }

    if (text === "2") {
      setMode(from, "facture");
      await sendTextMessage(from, "🧾 Mode FACTURE activé. Dis-moi: Nom client + montant + description.");
      return;
    }

    if (text === "3") {
      setMode(from, "recu");
      await sendTextMessage(from, "🧾 Mode REÇU activé. Dis-moi: Nom client + montant + motif.");
      return;
    }

    if (text.toLowerCase() === "reset") {
      resetSession(from);
      await sendTextMessage(from, "🔄 Session réinitialisée. Tape Menu.");
      return;
    }

    // Fallback
    await sendTextMessage(from, `Je n’ai pas compris. Tape "Menu" (ou "reset").`);
  } catch (err) {
    // Ici Meta a déjà eu 200, donc c'est juste pour toi
    console.error("❌ Error in POST /webhook:", err);
  }
});

/**
 * Endpoint de test pour envoyer un message (tu l'utilises déjà)
 * /send-test?to=22670626055&text=TEST_KADI_OK
 */
app.get("/send-test", async (req, res) => {
  try {
    const to = (req.query.to || "").toString().trim();
    const text = (req.query.text || "TEST").toString();

    if (!to) return res.status(400).json({ ok: false, error: "Missing ?to=" });

    const data = await sendTextMessage(to, text);
    return res.json({ ok: true, data });
  } catch (err) {
    console.error("❌ Error /send-test:", err?.response?.data || err);
    return res.status(500).json({ ok: false, error: "send failed" });
  }
});

// Render: PORT obligatoire
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});