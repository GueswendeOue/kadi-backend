require("dotenv").config();
const axios = require("axios");

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

async function run() {
  try {
    const r = await axios.get(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name,code_verification_status,quality_rating,platform_type`,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
        },
      }
    );
    console.log("✅ OK / phone_number visible:");
    console.log(r.data);
  } catch (e) {
    console.log("❌ ERROR:");
    console.log(e.response?.data || e.message);
  }
}

run();