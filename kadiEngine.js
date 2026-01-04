require("dotenv").config();
const axios = require("axios");

// 🔧 CONFIGURATION WHATSAPP
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

console.log("\n🔧 ===== CHARGEMENT KADI ENGINE =====");
console.log("🔧 WHATSAPP_TOKEN:", WHATSAPP_TOKEN ? "✓ PRÉSENT" : "✗ MANQUANT");
console.log("🔧 PHONE_NUMBER_ID:", PHONE_NUMBER_ID || "✗ MANQUANT");
console.log("🔧 =================================\n");

// 🚨 Vérification critique des variables
if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
  console.error("❌ VARIABLES MANQUANTES DANS .env:");
  console.error("   - WHATSAPP_TOKEN:", WHATSAPP_TOKEN ? "OK" : "MANQUANT");
  console.error("   - PHONE_NUMBER_ID:", PHONE_NUMBER_ID ? "OK" : "MANQUANT");
  throw new Error("Variables WhatsApp manquantes. Vérifie ton fichier .env sur Render.");
}

// 📤 Fonction d'envoi de message WhatsApp
async function sendWhatsAppMessage(to, text) {
  console.log(`\n📤 === ENVOI WHATSAPP ===`);
  console.log(`📤 À: ${to}`);
  console.log(`📤 Message: ${text.substring(0, 100)}...`);
  
  try {
    const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;
    
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to,
      type: "text",
      text: { body: text }
    };
    
    console.log("📤 URL:", url);
    console.log("📤 Payload:", JSON.stringify(payload, null, 2));
    
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 10000
    });
    
    console.log("✅ Message envoyé avec succès!");
    console.log("✅ Réponse API:", JSON.stringify(response.data, null, 2));
    
    return response.data;
  } catch (error) {
    console.error("❌ ERREUR WhatsApp API:");
    console.error("   Status:", error.response?.status);
    console.error("   Data:", error.response?.data);
    console.error("   Message:", error.message);
    throw error;
  }
}

// ==========================================
// FONCTIONS EXISTANTES DE KADI (inchangées)
// ==========================================
function formatDateISO(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function cleanNumber(str) {
  const s = String(str).replace(/\s/g, "").replace(/,/g, ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(p) {
  if (p == null) return null;
  const v = Number(p);
  if (!Number.isFinite(v)) return null;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

function parseItemLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  // ... (code existant inchangé)
  const nums = raw.match(/(\d[\d\s.,]*)/g) || [];
  const numbers = nums.map(cleanNumber).filter((v) => typeof v === "number");

  let qty = null;
  const xMatch = raw.match(/x\s*(\d+)/i);
  if (xMatch) qty = Number(xMatch[1]);

  let unitPrice = null;

  if (numbers.length === 1) {
    qty = qty || 1;
    unitPrice = numbers[0];
  } else if (numbers.length >= 2) {
    const first = numbers[0];
    const last = numbers[numbers.length - 1];

    if (!qty) {
      if (Number.isInteger(first) && first > 0 && first <= 100) {
        qty = first;
        unitPrice = last;
      } else {
        qty = 1;
        unitPrice = last;
      }
    } else {
      unitPrice = last;
    }
  }

  qty = qty || 1;
  unitPrice = unitPrice ?? null;

  const label =
    raw
      .replace(/x\s*\d+/gi, "")
      .replace(/(\d[\d\s.,]*)/g, "")
      .replace(/[-:]+/g, " ")
      .trim() || raw;

  const amount = unitPrice != null ? Number(qty) * Number(unitPrice) : null;

  return { label, qty: Number(qty), unitPrice, amount, raw };
}

function sumItems(items) {
  let sum = 0;
  let hasAny = false;
  for (const it of items || []) {
    if (typeof it?.amount === "number" && Number.isFinite(it.amount)) {
      sum += it.amount;
      hasAny = true;
    }
  }
  return hasAny ? sum : 0;
}

function computeFinance(doc) {
  const items = Array.isArray(doc.items) ? doc.items : [];
  const subtotal = sumItems(items);

  let discount = 0;
  const discountType = doc.discountType;
  const discountValue = doc.discountValue;

  if (discountType === "percent") {
    const p = clampPercent(discountValue);
    if (p != null) discount = subtotal * (p / 100);
  } else if (discountType === "amount") {
    const a = Number(discountValue);
    if (Number.isFinite(a) && a > 0) discount = a;
  }

  if (discount > subtotal) discount = subtotal;

  const net = subtotal - discount;

  let vat = 0;
  const vatRate = clampPercent(doc.vatRate);
  if (vatRate != null && vatRate > 0) vat = net * (vatRate / 100);

  const gross = net + vat;

  let deposit = 0;
  if (typeof doc.deposit === "number" && Number.isFinite(doc.deposit) && doc.deposit > 0) {
    deposit = doc.deposit;
  }
  if (deposit > gross) deposit = gross;

  const due = gross - deposit;

  return {
    subtotal,
    discount,
    net,
    vat,
    gross,
    deposit,
    due,
  };
}

function normalizeDoc(doc) {
  doc.items = Array.isArray(doc.items) ? doc.items : [];
  doc.date = doc.date || formatDateISO();

  doc.vatRate = doc.vatRate ?? null;
  doc.discountType = doc.discountType ?? null;
  doc.discountValue = doc.discountValue ?? null;
  doc.deposit = typeof doc.deposit === "number" ? doc.deposit : null;

  doc.paid = typeof doc.paid === "boolean" ? doc.paid : null;
  doc.paymentMethod = doc.paymentMethod || null;
  doc.motif = doc.motif || null;

  doc.finance = computeFinance(doc);
  return doc;
}

function money(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return String(Math.round(n));
}

function buildPreview(doc) {
  const type = String(doc.type || "document").toUpperCase();
  const items = Array.isArray(doc.items) ? doc.items : [];

  const lines = items.length
    ? items
        .map((it, idx) => {
          const pu = it.unitPrice != null ? it.unitPrice : "—";
          const amt = it.amount != null ? it.amount : "—";
          return `${idx + 1}) ${it.label} | Qté:${it.qty} | PU:${pu} | Montant:${amt}`;
        })
        .join("\n")
    : "—";

  const f = doc.finance || computeFinance(doc);

  const extra = [
    doc.vatRate != null ? `TVA : ${doc.vatRate}%` : null,
    doc.discountType === "percent" ? `Remise : ${doc.discountValue}%` : null,
    doc.discountType === "amount" ? `Remise : ${money(doc.discountValue)}` : null,
    doc.deposit ? `Acompte : ${money(doc.deposit)}` : null,
    doc.paymentMethod ? `Mode : ${doc.paymentMethod}` : null,
    doc.paid === true ? "Statut : PAYÉ" : doc.paid === false ? "Statut : NON PAYÉ" : null,
    doc.motif ? `Motif : ${doc.motif}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const numLine = doc.docNumber ? `\nNuméro : ${doc.docNumber}` : "";

  return `
📄 *${type}*${numLine}
Date : ${doc.date || "—"}
Client : ${doc.client || "—"}

Lignes :
${lines}

Sous-total : ${money(f.subtotal)}
Remise : ${money(f.discount)}
Net : ${money(f.net)}
TVA : ${money(f.vat)}
Total : ${money(f.gross)}
Acompte : ${money(f.deposit)}
Reste : ${money(f.due)}${extra ? `\n\n${extra}` : ""}
  `.trim();
}

async function generateDocumentFromText({ userId, mode, text }) {
  try {
    if (!mode) return { ok: false, error: "MODE_MISSING" };

    const lines = String(text || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const doc = normalizeDoc({
      type: mode,
      docNumber: null,
      date: formatDateISO(),
      client: null,
      items: [],
      raw_text: text,
      questions: [],

      vatRate: null,
      discountType: null,
      discountValue: null,
      deposit: null,
      paid: null,
      paymentMethod: null,
      motif: null,
    });

    for (const line of lines) {
      if (!doc.client && /^(client|nom)\s*[:\-]/i.test(line)) {
        doc.client = line.replace(/^(client|nom)\s*[:\-]\s*/i, "").trim() || null;
        continue;
      }

      if (/\d/.test(line)) {
        const it = parseItemLine(line);
        if (it) doc.items.push(it);
      }
    }

    doc.questions = [];
    if (!doc.client) doc.questions.push("Le nom du client ?");
    if (!doc.items.length) doc.questions.push("Les prestations ou produits ?");

    normalizeDoc(doc);

    return { ok: true, doc, preview: buildPreview(doc), questions: doc.questions };
  } catch (err) {
    console.error("❌ kadiEngine error:", err);
    return { ok: false, error: "ENGINE_ERROR" };
  }
}

function applyAnswerToDraft({ draft, question, answer }) {
  if (!draft) return { ok: false, error: "DRAFT_MISSING" };
  const a = String(answer || "").trim();
  if (!a) return { ok: false, error: "ANSWER_EMPTY" };

  draft.items = Array.isArray(draft.items) ? draft.items : [];

  if (/nom du client/i.test(question)) {
    draft.client = a;
  } else if (/prestations|produits|éléments/i.test(question)) {
    const parts = a.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      const it = parseItemLine(p);
      if (it) draft.items.push(it);
    }
  } else {
    draft.raw_text = (draft.raw_text || "") + "\n" + a;
  }

  draft.questions = [];
  if (!draft.client) draft.questions.push("Le nom du client ?");
  if (!draft.items.length) draft.questions.push("Les prestations ou produits ?");

  normalizeDoc(draft);
  return { ok: true, draft, preview: buildPreview(draft), questions: draft.questions };
}

function applyCommandToDraft(draft, cmd) {
  if (!draft) return { ok: false, error: "DRAFT_MISSING" };
  draft.items = Array.isArray(draft.items) ? draft.items : [];

  switch (cmd.type) {
    case "set_client":
      draft.client = cmd.value || draft.client;
      break;
    case "set_date":
      draft.date = cmd.value || draft.date;
      break;
    case "add_lines":
      for (const l of cmd.lines || []) {
        const it = parseItemLine(l);
        if (it) draft.items.push(it);
      }
      break;
    case "delete_item":
      if (cmd.index >= 1 && cmd.index <= draft.items.length) {
        draft.items.splice(cmd.index - 1, 1);
      }
      break;
    case "replace_item":
      if (cmd.index >= 1 && cmd.index <= draft.items.length) {
        const it = parseItemLine(cmd.line);
        if (it) draft.items[cmd.index - 1] = it;
      }
      break;
    case "set_vat_rate":
      draft.vatRate = clampPercent(cmd.value);
      break;
    case "set_discount_percent":
      draft.discountType = "percent";
      draft.discountValue = clampPercent(cmd.value);
      break;
    case "set_discount_amount":
      draft.discountType = "amount";
      draft.discountValue = Number(cmd.value);
      break;
    case "set_deposit":
      draft.deposit = Number(cmd.value);
      break;
    case "set_paid":
      draft.paid = Boolean(cmd.value);
      break;
    case "set_payment_method":
      draft.paymentMethod = cmd.value || null;
      break;
    case "set_motif":
      draft.motif = cmd.value || null;
      break;
    default:
      return { ok: false, error: "UNKNOWN_COMMAND" };
  }

  draft.questions = [];
  if (!draft.client) draft.questions.push("Le nom du client ?");
  if (!draft.items.length) draft.questions.push("Les prestations ou produits ?");

  normalizeDoc(draft);

  return { ok: true, draft, preview: buildPreview(draft), questions: draft.questions };
}

// ✅ FONCTION PRINCIPALE DE TRAITEMENT WHATSAPP
async function handleIncomingMessage(value) {
  console.log("\n🔧 === KADI ENGINE - TRAITEMENT ====");
  
  try {
    // 1. Vérifier si c'est un message texte
    if (value.messages && value.messages[0]) {
      const message = value.messages[0];
      const from = message.from;
      const text = message.text?.body?.trim() || "";
      
      console.log(`📱 Message reçu de ${from}: "${text}"`);
      console.log(`📱 Type: ${message.type}, ID: ${message.id}`);
      
      // 2. Traiter la commande "Menu"
      if (text.toLowerCase() === "menu") {
        console.log("✅ Commande 'Menu' détectée!");
        
        const menuResponse = `✅ *KADI BOT EST EN LIGNE !*\n
📋 *MENU PRINCIPAL*
1️⃣ - Créer un devis
2️⃣ - Créer une facture
3️⃣ - Voir mes documents
4️⃣ - Support technique
5️⃣ - Informations compte

👉 *Tapez le numéro correspondant (1, 2, 3...)*`;
        
        console.log("📤 Envoi réponse Menu...");
        await sendWhatsAppMessage(from, menuResponse);
        console.log("🎯 Réponse Menu envoyée avec succès!");
      }
      // 3. Traiter d'autres commandes numériques
      else if (["1", "2", "3", "4", "5"].includes(text)) {
        const responses = {
          "1": "📝 *CRÉATION DE DEVIS*\nEnvoyez les détails sous la forme:\nClient: [Nom]\nProduit1 x 2 5000\nProduit2 x 1 3000",
          "2": "🧾 *CRÉATION DE FACTURE*\nEnvoyez les détails sous la forme:\nClient: [Nom]\nService1 x 3 7500\nService2 x 1 12000",
          "3": "📂 *MES DOCUMENTS*\nFonctionnalité en développement...",
          "4": "🔧 *SUPPORT TECHNIQUE*\nContact: support@kadi.com\nTél: +226 XX XX XX XX",
          "5": "👤 *INFORMATIONS COMPTE*\nVous êtes connecté avec le numéro: " + from
        };
        
        console.log(`📤 Réponse à la commande ${text}`);
        await sendWhatsAppMessage(from, responses[text]);
      }
      // 4. Réponse par défaut
      else if (text) {
        console.log(`⚠️ Message non reconnu: "${text}"`);
        await sendWhatsAppMessage(from, 
          `📝 J'ai reçu votre message: "${text}"\n\n` +
          `Tapez *MENU* pour voir les options disponibles.`
        );
      }
    }
    // 5. Vérifier les statuts de message
    else if (value.statuses && value.statuses[0]) {
      const status = value.statuses[0];
      console.log(`📊 Statut message ${status.id}: ${status.status}`);
    }
    else {
      console.log("⚠️ Format de payload inattendu:", JSON.stringify(value, null, 2));
    }
    
  } catch (error) {
    console.error("💥 ERREUR dans handleIncomingMessage:", error.message);
    console.error("Stack:", error.stack);
  }
  
  console.log("🔧 === FIN TRAITEMENT ====\n");
}

// Export des fonctions
module.exports = {
  generateDocumentFromText,
  applyAnswerToDraft,
  applyCommandToDraft,
  buildPreview,
  cleanNumber,
  handleIncomingMessage,
  sendWhatsAppMessage  // Exporté pour les tests
};