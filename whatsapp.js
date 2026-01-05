// whatsapp.js
const axios = require("axios");

function must(v, name) {
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function sendTextMessage({ to, text, phoneNumberIdOverride }) {
  const token = must(process.env.WHATSAPP_TOKEN, "WHATSAPP_TOKEN");
  const graphVersion = process.env.GRAPH_VERSION || "v22.0";

  // Par défaut on utilise l'ID en env, mais on peut overrider avec celui du webhook entrant
  const phoneNumberId =
    phoneNumberIdOverride || must(process.env.WHATSAPP_PHONE_NUMBER_ID, "WHATSAPP_PHONE_NUMBER_ID");

  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  const r = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    timeout: 15000,
  });

  return r.data;
}

module.exports = { sendTextMessage };