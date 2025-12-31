const axios = require("axios");
require("dotenv").config();

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";

const PIN = process.env.WHATSAPP_2FA_PIN; // 6 chiffres

async function register() {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/register`;
  const r = await axios.post(
    url,
    { messaging_product: "whatsapp", pin: PIN },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
  console.log("REGISTER OK:", r.data);
}

register().catch((e) => console.error(e.response?.data || e.message));