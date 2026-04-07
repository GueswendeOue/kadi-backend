"use strict";

function makeKadiSmallTalk(deps) {
  const { sendButtons, norm } = deps;

  async function handleSmallTalk(from, rawText) {
    const t = norm(rawText).toLowerCase();
    if (!t) return false;

    const greetings = new Set([
      "salut",
      "bonjour",
      "bonsoir",
      "bjr",
      "bsr",
      "hello",
      "cc",
      "coucou",
      "hey",
      "yo",
    ]);

    const wellness = new Set([
      "ça va",
      "ca va",
      "cv",
      "comment ça va",
      "comment ca va",
      "tu vas bien",
      "vous allez bien",
    ]);

    if (greetings.has(t)) {
      await sendButtons(
        from,
        `👋 Bonjour ! Je suis *KADI*.\n\nJe peux créer vos devis, factures, reçus et décharges sur WhatsApp.\n\nQue voulez-vous faire ?`,
        [
          { id: "HOME_DOCS", title: "📄 Documents" },
          { id: "BACK_HOME", title: "🏠 Menu" },
          { id: "HOME_TUTORIAL", title: "📚 Tutoriel" },
        ]
      );
      return true;
    }

    if (wellness.has(t)) {
      await sendButtons(
        from,
        `😊 Je vais bien, merci.\n\nJe suis prête à vous aider avec vos documents.\n\nChoisissez une action 👇`,
        [
          { id: "HOME_DOCS", title: "📄 Documents" },
          { id: "BACK_HOME", title: "🏠 Menu" },
          { id: "HOME_TUTORIAL", title: "📚 Tutoriel" },
        ]
      );
      return true;
    }

    return false;
  }

  return {
    handleSmallTalk,
  };
}

module.exports = {
  makeKadiSmallTalk,
};