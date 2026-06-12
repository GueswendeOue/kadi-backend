"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiMenus } = require("../kadiMenus");

function makeMenus() {
  const lists = [];
  const menus = makeKadiMenus({
    sendButtons: async () => {},
    sendList: async (to, payload) => lists.push({ to, payload }),
    getOrCreateProfile: async () => ({}),
    STAMP_ONE_TIME_COST: 15,
  });

  return { lists, menus };
}

test("home menu is reduced to the three V1 primary actions", async () => {
  const { lists, menus } = makeMenus();

  await menus.sendHomeMenu("22670000000");

  const rows = lists[0].payload.sections.flatMap((section) => section.rows);
  const ids = rows.map((row) => row.id);

  assert.deepEqual(ids, ["HOME_DOCS", "HOME_HISTORY", "HOME_CREDITS"]);
  assert.equal(rows[0].title, "📄 Créer un document");
  assert.equal(rows[1].title, "📚 Mes documents");
  assert.equal(rows[2].title, "💳 Crédits");
  assert.match(lists[0].payload.footer, /AIDE/);
  assert.equal(ids.includes("HOME_PROFILE"), false);
  assert.equal(ids.includes("PROFILE_STAMP"), false);
  assert.equal(ids.includes("HOME_SUPPORT"), false);
});

test("docs menu foregrounds phrase and photo while keeping guided document types", async () => {
  const { lists, menus } = makeMenus();

  await menus.sendDocsMenu("22670000000");

  const rows = lists[0].payload.sections.flatMap((section) => section.rows);
  const ids = rows.map((row) => row.id);

  assert.match(lists[0].payload.body, /écrivez votre demande en une phrase/);
  assert.deepEqual(ids, [
    "HOME_HELP",
    "HOME_OCR",
    "DOC_FACTURE_MENU",
    "DOC_DEVIS",
    "DOC_RECU",
    "DOC_DECHARGE",
  ]);
  assert.equal(rows[0].title, "✍️ Écrire une phrase");
  assert.equal(rows[1].title, "📷 Envoyer une photo");
  assert.equal(rows.some((row) => /OCR/.test(row.title)), false);
});

test("preview menu keeps only the primary PDF decision actions visible", async () => {
  const { lists, menus } = makeMenus();

  await menus.sendPreviewMenu("22670000000", {
    type: "facture",
    client: "Awa",
    items: [{ label: "Pagne", qty: 5, unitPrice: 3000 }],
  });

  const rows = lists[0].payload.sections.flatMap((section) => section.rows);
  const ids = rows.map((row) => row.id);

  assert.deepEqual(ids, ["DOC_CONFIRM", "DOC_EDIT_TEXT", "DOC_CANCEL"]);
  assert.equal(rows[0].title, "📤 Générer PDF");
  assert.equal(rows[1].title, "✏️ Corriger");
  assert.equal(rows[2].title, "🏠 Menu");
  assert.equal(ids.includes("DOC_ADD_MORE"), false);
  assert.equal(ids.includes("DOC_ADD_SUBJECT"), false);
  assert.equal(ids.includes("DOC_ADD_CLIENT_PHONE"), false);
});

test("support menu exposes tutorial and support escalation choices", async () => {
  const { lists, menus } = makeMenus();

  await menus.sendSupportMenu("22670000000");

  const rows = lists[0].payload.sections.flatMap((section) => section.rows);
  const ids = rows.map((row) => row.id);

  assert.deepEqual(ids, [
    "SUPPORT_TALK_TEAM",
    "SUPPORT_DEMO_VIDEO",
    "SUPPORT_PAYMENT",
  ]);

  assert.equal(rows[0].title, "Parler à l’équipe Kadi");
  assert.equal(rows[1].title, "Voir la vidéo démo");
});
