// ✅ Webhook receive (Meta)
app.post("/webhook", async (req, res) => {
  console.log("📩 INCOMING WEBHOOK - Body keys:", Object.keys(req.body || {}));
  
  try {
    const body = req.body || {};
    console.log("📦 Full body structure:", JSON.stringify(body).substring(0, 500));

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // messages OU status updates
    if (!value) {
      console.log("❌ No value in payload");
      return res.status(200).send("EVENT_RECEIVED");
    }

    // ✅ Log détaillé du message
    if (value.messages && value.messages[0]) {
      const msg = value.messages[0];
      console.log(`📱 Message reçu: ${msg.text?.body} (Type: ${msg.type})`);
    }

    // ✅ Répondre à Meta
    res.status(200).send("EVENT_RECEIVED");

    // ✅ Traiter le message EN PARALLÈLE (non-bloquant)
    handleIncomingMessage(value).catch(err => {
      console.error("💥 Error in handleIncomingMessage:", err);
    });

  } catch (e) {
    console.error("💥 CRITICAL ERROR in webhook:", e?.message || e);
    // Même en cas d'erreur, on répond à Meta pour éviter les retries
    res.status(200).send("EVENT_RECEIVED");
  }
});