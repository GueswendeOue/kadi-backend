"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiPriorityRouter } = require("../kadiPriorityRouter");

function makeRouter() {
  const menus = [];
  const router = makeKadiPriorityRouter({
    norm: (text) => String(text || "").trim().toLowerCase(),
    logger: { error: () => {} },
    sendText: async () => {},
    sendHomeMenu: async (to) => menus.push({ to }),
    sendDocsMenu: async () => {},
    startProfileFlow: async () => {},
    replyBalance: async () => {},
    sendRechargePacksMenu: async () => {},
    sendStampMenu: async () => {},
    sendProfileMenu: async () => {},
    sendCreditsMenu: async () => {},
  });

  return { menus, router };
}

test("priority router treats global menu aliases as menu intent", async () => {
  for (const text of ["menu", "MENU", "Menu", "accueil", "home", "retour", "stop"]) {
    const { menus, router } = makeRouter();

    assert.equal(router.detectPriorityIntent(text), "menu", text);
    assert.equal(await router.handleUltraPriorityText("22670000000", text), true);
    assert.deepEqual(menus, [{ to: "22670000000" }]);
  }
});
