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

test("home menu stays within WhatsApp list limit and keeps support and stamp", async () => {
  const { lists, menus } = makeMenus();

  await menus.sendHomeMenu("22670000000");

  const rows = lists[0].payload.sections.flatMap((section) => section.rows);
  const ids = rows.map((row) => row.id);

  assert.ok(rows.length <= 10);
  assert.ok(rows.length >= 6);
  assert.ok(ids.includes("HOME_SUPPORT"));
  assert.ok(ids.includes("PROFILE_STAMP"));
  assert.equal(ids.includes("HOME_HELP"), false);
});

test("support menu exposes tutorial and support escalation choices", async () => {
  const { lists, menus } = makeMenus();

  await menus.sendSupportMenu("22670000000");

  const rows = lists[0].payload.sections.flatMap((section) => section.rows);
  const ids = rows.map((row) => row.id);

  assert.deepEqual(ids, [
    "SUPPORT_TUTORIAL",
    "SUPPORT_HUMAN",
    "SUPPORT_PAYMENT",
    "SUPPORT_BUG",
  ]);
});
