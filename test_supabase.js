require("dotenv").config();
const { supabase } = require("./supabaseClient");

(async () => {
  try {
    const { data, error } = await supabase
      .from("kadi_documents")
      .select("id")
      .limit(1);

    console.log("DATA:", data);
    console.log("ERROR:", error);
  } catch (e) {
    console.error("CRASH:", e);
  }
})();