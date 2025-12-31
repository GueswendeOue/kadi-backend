const axios = require("axios");
require("dotenv").config();

const TOKEN = process.env.WHATSAPP_TOKEN;
const WABA_ID = process.env.WHATSAPP_WABA_ID;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";

async function run() {
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/phone_numbers`;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    console.log("✅ PHONE NUMBERS:", JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error("❌ ERROR:", err.response?.data || err.message);
  }
}

run();