"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  makeKadiReengagementService,
  resolveSegmentConfig,
  runLoggedCampaign,
} = require("../kadiReengagementService");

test("resolves recent_active_zero_doc segment config", () => {
  const config = resolveSegmentConfig("recent_active_zero_doc");

  assert.equal(config.segment, "recent_active_zero_doc");
  assert.equal(config.campaignType, "recent_active_zero_doc");
  assert.equal(config.templateName, "kadi_recent_active_zero_doc_v1");
  assert.match(config.messageText, /Avec KADI/);
  assert.match(config.messageText, /Devis pour Moussa/);
});

test("preview lists candidates without sending campaign message", async () => {
  const calls = [];
  const service = makeKadiReengagementService({
    sendText: async (to, text) => calls.push({ to, text }),
    getRecentActiveZeroDocUsers: async (limit, options) => {
      assert.equal(limit, 20);
      assert.equal(options.activeDays, 30);
      assert.equal(options.cooldownDays, 7);
      return [
        {
          wa_id: "22670000001",
          last_activity_at: "2026-05-01T10:00:00.000Z",
        },
      ];
    },
  });

  const handled = await service.handleReengagePreviewCommand(
    "22679999999",
    "/reengage_preview recent_active_zero_doc 20"
  );

  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /Preview re-engagement/);
  assert.match(calls[0].text, /Envoi : aucun/);
  assert.match(calls[0].text, /\+22670000001/);
  assert.doesNotMatch(calls[0].text, /Envoyez simplement votre demande/);
});

test("test command sends only to admin and does not query users", async () => {
  const calls = [];
  const service = makeKadiReengagementService({
    sendText: async (to, text) => calls.push({ to, text }),
    getRecentActiveZeroDocUsers: async () => {
      throw new Error("should_not_query_segment");
    },
  });

  const handled = await service.handleReengageTestCommand(
    "22679999999",
    "/reengage_test recent_active_zero_doc"
  );

  assert.equal(handled, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.to),
    ["22679999999", "22679999999"]
  );
  assert.match(calls[0].text, /Avec KADI/);
  assert.match(calls[1].text, /Aucun utilisateur réel ciblé/);
});

test("logged campaign logs successful free sends", async () => {
  const sent = [];
  const logs = [];
  const now = new Date().toISOString();

  const stats = await runLoggedCampaign({
    users: [{ wa_id: "22670000001", last_activity_at: now }],
    sendText: async (to, text) => sent.push({ to, text }),
    sendTemplateMessage: null,
    messageText: "Bonjour test",
    templateName: "unused_template",
    campaignType: "recent_active_zero_doc",
    cycleKey: "manual_recent_active_zero_doc_test",
    logReengagementSend: async (payload) => logs.push(payload),
    meta: { source: "test" },
  });

  assert.deepEqual(stats, {
    targeted: 1,
    sent: 1,
    template: 0,
    blocked: 0,
    failed: 0,
  });
  assert.deepEqual(sent, [{ to: "22670000001", text: "Bonjour test" }]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].waId, "22670000001");
  assert.equal(logs[0].campaignType, "recent_active_zero_doc");
  assert.equal(logs[0].messageMode, "free");
  assert.equal(logs[0].status, "sent");
});
