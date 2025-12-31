// supabaseClient.js
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;

// Supporte les 2 noms (ton .env a SUPABASE_SERVICE_KEY)
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️ Missing Supabase env vars:");
  console.warn("   - SUPABASE_URL:", SUPABASE_URL ? "✅ set" : "❌ missing");
  console.warn(
    "   - SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY:",
    SUPABASE_SERVICE_ROLE_KEY ? "✅ set" : "❌ missing"
  );
}

const supabase = createClient(SUPABASE_URL || "http://localhost", SUPABASE_SERVICE_ROLE_KEY || "invalid-key", {
  auth: { persistSession: false },
});

module.exports = { supabase };