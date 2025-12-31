const axios = require("axios");
require("dotenv").config();

const TOKEN = process.env.WHATSAPP_TOKEN;
const WABA_ID = process.env.WHATSAPP_WABA_ID;
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";

async function run() {
  console.log("TOKEN length:", TOKEN?.length);
  console.log("WABA_ID:", WABA_ID);

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/phone_numbers`;

  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  console.log(JSON.stringify(r.data, null, 2));

  const first = r.data?.data?.[0];
  if (first?.id) {
    console.log("\n✅ PHONE_NUMBER_ID =", first.id);
    console.log("✅ display_phone_number =", first.display_phone_number);
  } else {
    console.log("❌ Aucun numéro retourné par l’API.");
  }
}

run().catch((e) => {
  console.error("❌ ERROR:", e.response?.data || e.message);
});