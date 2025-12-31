const axios = require("axios");
require("dotenv").config();

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

async function sendTest() {
  try {
    const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

    const res = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: "+22670626055", // 👉 METS TON NUMÉRO PERSONNEL ICI
        type: "text",
        text: {
          body: "✅ Kadi est en ligne. Test réussi."
        }
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ MESSAGE ENVOYÉ :", res.data);
  } catch (err) {
    console.error("❌ ERREUR :", err.response?.data || err.message);
  }
}

sendTest();