"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  makeKadiReengagementService,
  resolveSegmentConfig,
  runLoggedCampaign,
  isTemplateMissingError,
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

  assert.equal(stats.targeted, 1);
  assert.equal(stats.sent, 1);
  assert.equal(stats.template, 0);
  assert.equal(stats.blocked, 0);
  assert.equal(stats.failed, 0);
  assert.equal(stats.aborted, false);
  assert.deepEqual(sent, [{ to: "22670000001", text: "Bonjour test" }]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].waId, "22670000001");
  assert.equal(logs[0].campaignType, "recent_active_zero_doc");
  assert.equal(logs[0].messageMode, "free");
  assert.equal(logs[0].status, "sent");
});

test("template missing error is detected from Meta code and details", () => {
  assert.equal(
    isTemplateMissingError({
      errorCode: 132001,
      errorDetails: "template name (kadi_recent_active_zero_doc_v1) does not exist in fr",
    }),
    true
  );
});

test("logged campaign stops immediately when template is missing", async () => {
  const logs = [];
  const sent = [];
  const oldDate = "2026-01-01T10:00:00.000Z";

  const stats = await runLoggedCampaign({
    users: [
      { wa_id: "22670000001", last_activity_at: oldDate },
      { wa_id: "22670000002", last_activity_at: oldDate },
    ],
    sendText: async (to, text) => sent.push({ to, text }),
    sendTemplateMessage: async () => {
      const error = new Error(
        "(#132001) Template name does not exist in the translation"
      );
      error.meta = {
        code: 132001,
        error_data: {
          details:
            "template name (kadi_recent_active_zero_doc_v1) does not exist in fr",
        },
      };
      throw error;
    },
    messageText: "Bonjour test",
    templateName: "kadi_recent_active_zero_doc_v1",
    campaignType: "recent_active_zero_doc",
    cycleKey: "manual_recent_active_zero_doc_test",
    logReengagementSend: async (payload) => logs.push(payload),
    meta: { source: "test" },
  });

  assert.equal(stats.targeted, 2);
  assert.equal(stats.sent, 0);
  assert.equal(stats.template, 0);
  assert.equal(stats.failed, 1);
  assert.equal(stats.aborted, true);
  assert.equal(stats.abortReason, "template_missing");
  assert.match(stats.abortMessage, /kadi_recent_active_zero_doc_v1 en fr/);
  assert.deepEqual(sent, []);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].waId, "22670000001");
  assert.equal(logs[0].status, "failed_template_config");
  assert.equal(logs[0].meta.abortedBatch, true);
});
