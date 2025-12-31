const path = require("path");
const dotenv = require("dotenv");

const result = dotenv.config({ path: path.join(__dirname, ".env") });

console.log("dotenv error =", result.error || null);
console.log("parsed keys =", result.parsed ? Object.keys(result.parsed) : null);
console.log("parsed VERIFY_TOKEN =", result.parsed?.VERIFY_TOKEN);
console.log("process.env.VERIFY_TOKEN =", process.env.VERIFY_TOKEN);

// Bonus: cherche une clé avec espace
if (result.parsed) {
  const weird = Object.keys(result.parsed).filter(k => k.toLowerCase().includes("verify"));
  console.log("verify-like keys =", weird);
}