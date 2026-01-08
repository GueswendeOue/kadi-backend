// kadiCvFlow.js
"use strict";

const { getCvDraft, resetCv } = require("./kadiCvStore");
const { sendText, sendButtons } = require("./whatsappApi");

const CV_STEPS = [
  { key: "full_name", question: "🧑 1/9 — Quel est ton *nom complet* ?" },
  { key: "phone", question: "📞 2/9 — Ton *numéro de téléphone* ?" },
  { key: "email", question: "📧 3/9 — Ton *email* ?\nTape 0 si tu n’en as pas." },
  { key: "job_title", question: "💼 4/9 — Quel est ton *métier principal* ?" },
  { key: "summary", question: "📝 5/9 — Décris brièvement ce que tu sais faire." },
  { key: "skills", question: "🛠️ 6/9 — Liste tes *compétences* (séparées par des virgules)." },
  { key: "experience", question: "🏗️ 7/9 — Décris ton *expérience principale*." },
  { key: "education", question: "🎓 8/9 — Ta *formation* ?\nTape 0 si aucune." },
  { key: "languages", question: "🌍 9/9 — Quelles *langues* parles-tu et ton niveau ?" },
  { key: "interests", question: "⭐ Centres d’intérêt ?\nTape 0 pour ignorer." }
];

async function startCvFlow(from) {
  resetCv(from);
  const cv = getCvDraft(from);
  cv.step = 0;
  await sendText(from, CV_STEPS[0].question);
}

async function handleCvAnswer(from, text) {
  const cv = getCvDraft(from);
  const step = CV_STEPS[cv.step];

  if (!step) return false;

  const value = text.trim() === "0" ? null : text.trim();
  cv.data[step.key] = value;

  cv.step++;

  if (cv.step < CV_STEPS.length) {
    await sendText(from, CV_STEPS[cv.step].question);
  } else {
    await sendText(from, buildCvPreview(cv.data));
    await sendButtons(from, "✅ CV terminé. Que veux-tu faire ?", [
      { id: "CV_CONFIRM", title: "Confirmer" },
      { id: "CV_RESTART", title: "Recommencer" }
    ]);
  }

  return true;
}

function buildCvPreview(data) {
  return `
📄 *APERÇU DU CV*

Nom : ${data.full_name || "—"}
Téléphone : ${data.phone || "—"}
Email : ${data.email || "—"}

🎯 Métier :
${data.job_title || "—"}

📝 Résumé :
${data.summary || "—"}

🛠️ Compétences :
${data.skills || "—"}

🏗️ Expérience :
${data.experience || "—"}

🎓 Formation :
${data.education || "—"}

🌍 Langues :
${data.languages || "—"}

⭐ Intérêts :
${data.interests || "—"}
`.trim();
}

module.exports = {
  startCvFlow,
  handleCvAnswer
};