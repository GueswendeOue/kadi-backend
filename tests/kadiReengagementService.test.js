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

test("resolves exhausted_credits segment config", () => {
  const config = resolveSegmentConfig("exhausted_credits");

  assert.equal(config.segment, "exhausted_credits");
  assert.equal(config.campaignType, "exhausted_credits");
  assert.equal(config.templateName, "kadi_exhausted_credits_v1");
  assert.match(config.messageText, /Vos crédits KADI sont épuisés/);
  assert.match(config.messageText, /1000F = 10 crédits/);
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

test("exhausted credits preview lists candidates without sending campaign message", async () => {
  const calls = [];
  const service = makeKadiReengagementService({
    sendText: async (to, text) => calls.push({ to, text }),
    getExhaustedCreditUsers: async (limit, options) => {
      assert.equal(limit, 10);
      assert.equal(options.cooldownDays, 7);
      return [
        {
          wa_id: "22670000003",
          last_activity_at: "2026-05-01T10:00:00.000Z",
          exhausted_at: "2026-05-10T10:00:00.000Z",
        },
      ];
    },
  });

  const handled = await service.handleReengagePreviewCommand(
    "22679999999",
    "/reengage_preview exhausted_credits 10"
  );

  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /Preview re-engagement/);
  assert.match(calls[0].text, /Envoi : aucun/);
  assert.match(calls[0].text, /\+22670000003/);
  assert.doesNotMatch(calls[0].text, /Vos crédits KADI sont épuisés/);
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

test("exhausted credits test command sends only to admin and does not query users", async () => {
  const calls = [];
  const service = makeKadiReengagementService({
    sendText: async (to, text) => calls.push({ to, text }),
    getExhaustedCreditUsers: async () => {
      throw new Error("should_not_query_segment");
    },
  });

  const handled = await service.handleReengageTestCommand(
    "22679999999",
    "/reengage_test exhausted_credits"
  );

  assert.equal(handled, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.to),
    ["22679999999", "22679999999"]
  );
  assert.match(calls[0].text, /Vos crédits KADI sont épuisés/);
  assert.match(calls[1].text, /Aucun utilisateur réel ciblé/);
});

test("exhausted credits segment command respects requested limit and logs sends", async () => {
  const sent = [];
  const logs = [];
  const now = new Date().toISOString();
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...args) {
      if (args.length) return new RealDate(...args);
      return new RealDate("2026-05-18T10:00:00.000Z");
    }

    static now() {
      return new RealDate("2026-05-18T10:00:00.000Z").getTime();
    }

    static parse(value) {
      return RealDate.parse(value);
    }

    static UTC(...args) {
      return RealDate.UTC(...args);
    }
  };
  let handled = false;

  try {
    const service = makeKadiReengagementService({
      sendText: async (to, text) => sent.push({ to, text }),
      getExhaustedCreditUsers: async (limit, options) => {
        assert.equal(limit, 5);
        assert.equal(options.cooldownDays, 7);
        return Array.from({ length: limit }, (_, index) => ({
          wa_id: `2267000000${index}`,
          last_activity_at: now,
        }));
      },
      logReengagementSend: async (payload) => logs.push(payload),
    });

    handled = await service.handleReengageSegmentCommand(
      "22679999999",
      "/reengage_segment exhausted_credits 5"
    );
  } finally {
    global.Date = RealDate;
  }

  assert.equal(handled, true);
  assert.equal(logs.length, 5);
  assert.equal(logs[0].campaignType, "exhausted_credits");
  assert.equal(logs[0].status, "sent");
  assert.equal(sent.filter((call) => call.to !== "22679999999").length, 5);
  assert.match(sent.at(-1).text, /Re-engagement segment terminé/);
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
