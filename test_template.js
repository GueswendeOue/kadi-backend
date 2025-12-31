const axios = require("axios");
require("dotenv").config();

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";

async function sendTemplate() {
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

    const res = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: "22670626055", // ton numéro
        type: "template",
        template: {
          name: "hello_world",
          language: { code: "en_US" },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ TEMPLATE ENVOYÉ :", res.data);
  } catch (err) {
    console.error("❌ ERREUR :", err.response?.data || err.message);
  }
}

sendTemplate();