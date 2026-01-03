const axios = require("axios");

function getGraphBase() {
  const v = process.env.GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${v}`;
}

async function sendTextMessage(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token) throw new Error("Missing WHATSAPP_TOKEN");
  if (!phoneNumberId) throw new Error("Missing WHATSAPP_PHONE_NUMBER_ID");

  const url = `${getGraphBase()}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  const res = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });

  return res.data;
}

module.exports = { sendTextMessage };