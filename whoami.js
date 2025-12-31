const axios = require("axios");
require("dotenv").config();

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

async function whoami() {
  try {
    const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}?fields=display_phone_number,verified_name`;

    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
      },
    });

    console.log("✅ PHONE NUMBER OK:", res.data);
  } catch (err) {
    console.error("❌ ERR:", err.response?.data || err.message);
  }
}

whoami();