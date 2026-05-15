"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { makeKadiSupportService } = require("../kadiSupportService");

function makeMemoryRepo() {
  const sessions = new Map();
  const agents = new Map([
    [
      "22670626055",
      {
        wa_id: "22670626055",
        name: "Admin principal",
        role: "admin",
        is_active: true,
        priority: 0,
      },
    ],
  ]);

  return {
    sessions,
    agents,
    async getOpenSupportSession(waId) {
      const row = sessions.get(waId);
      return row?.status === "open" ? row : null;
    },
    async openSupportSession({ waId, reason, lastUserMessage }) {
      const existing = sessions.get(waId);
      if (existing?.status === "open") {
        existing.reason = reason || existing.reason;
        existing.last_user_message = lastUserMessage || existing.last_user_message;
        return { session: existing, created: false };
      }

      const row = {
        id: `s-${waId}`,
        wa_id: waId,
        status: "open",
        reason,
        last_user_message: lastUserMessage,
        opened_at: "2026-05-15T00:00:00.000Z",
      };
      sessions.set(waId, row);
      return { session: row, created: true };
    },
    async updateOpenSupportSessionMessage(waId, message) {
      const row = sessions.get(waId);
      if (!row || row.status !== "open") return null;
      row.last_user_message = message;
      return row;
    },
    async closeSupportSession(waId, closedBy) {
      const row = sessions.get(waId);
      if (!row || row.status !== "open") return null;
      row.status = "closed";
      row.closed_by = closedBy;
      row.closed_at = "2026-05-15T00:01:00.000Z";
      return row;
    },
    async getSupportSessionStatus(waId) {
      return sessions.get(waId) || null;
    },
    async listOpenSupportSessions() {
      return Array.from(sessions.values()).filter((row) => row.status === "open");
    },
    async listActiveSupportAgents() {
      return Array.from(agents.values()).filter((row) => row.is_active);
    },
    async addSupportAgent({ waId, name, role = "support", priority = 100 }) {
      const row = {
        wa_id: waId,
        name,
        role,
        is_active: true,
        priority,
      };
      agents.set(waId, row);
      return row;
    },
    async disableSupportAgent(waId) {
      const row = agents.get(waId);
      if (row) row.is_active = false;
      return row || null;
    },
  };
}

function makeService(repo = makeMemoryRepo()) {
  const sent = [];
  const warns = [];
  const service = makeKadiSupportService({
    supportRepo: repo,
    principalWaId: "22670626055",
    sendText: async (to, text) => sent.push({ to, text }),
    logger: { warn: (...args) => warns.push(args) },
  });
  return { repo, sent, service, warns };
}

test("support text opens a human support session and alerts agents", async () => {
  const { repo, sent, service } = makeService();

  const handled = await service.handleSupportText("22670000000", "support");

  assert.equal(handled, true);
  assert.equal(repo.sessions.get("22670000000").status, "open");
  assert.match(sent[0].text, /D’accord, je vous mets en relation/);
  assert.equal(sent[0].to, "22670000000");
  assert.equal(sent[1].to, "22670626055");
  assert.match(sent[1].text, /Nouvelle demande support Kadi/);
});

test("open support session forwards user messages without customer auto-reply", async () => {
  const { sent, service } = makeService();

  await service.handleSupportText("22670000000", "support");
  sent.length = 0;

  const handled = await service.handleSupportText(
    "22670000000",
    "Fais une facture pour Moussa 1000"
  );

  assert.equal(handled, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "22670626055");
  assert.match(sent[0].text, /Fais une facture pour Moussa 1000/);
});

test("support reply sends official Kadi text to the client", async () => {
  const { sent, service } = makeService();

  await service.handleSupportText("22670000000", "bug facture");
  sent.length = 0;

  const result = await service.replyToClient({
    agentWaId: "22670626055",
    clientWaId: "22670000000",
    message: "Nous vérifions votre problème.",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(sent, [
    { to: "22670000000", text: "Nous vérifions votre problème." },
  ]);
});

test("support close closes session and tells client Kadi resumes", async () => {
  const { repo, sent, service } = makeService();

  await service.handleSupportText("22670000000", "support");
  sent.length = 0;

  const result = await service.closeSession({
    agentWaId: "22670626055",
    clientWaId: "22670000000",
  });

  assert.equal(result.ok, true);
  assert.equal(repo.sessions.get("22670000000").status, "closed");
  assert.match(sent[0].text, /Kadi reprend automatiquement/);
});

test("agent add and disable manage active support agents", async () => {
  const { service } = makeService();

  await service.addAgent({ waId: "70620000", name: "Awa Support" });
  let text = await service.agentsText();
  assert.match(text, /\+22670620000/);
  assert.match(text, /Awa Support/);

  await service.disableAgent("22670620000");
  text = await service.agentsText();
  assert.doesNotMatch(text, /\+22670620000/);
});

test("support repo lookup failure returns false so MENU can continue normally", async () => {
  const repo = makeMemoryRepo();
  repo.getOpenSupportSession = async () => {
    throw new Error("relation kadi_support_sessions does not exist");
  };
  const { sent, service, warns } = makeService(repo);

  const handled = await service.handleSupportText("22670000000", "Menu");

  assert.equal(handled, false);
  assert.deepEqual(sent, []);
  assert.match(String(warns[0]?.[1] || ""), /kadi_support_sessions/);
});

test("support repo failure on normal text does not throw to global routing", async () => {
  const repo = makeMemoryRepo();
  repo.getOpenSupportSession = async () => {
    throw new Error("supabase unavailable");
  };
  const { sent, service } = makeService(repo);

  await assert.doesNotReject(() =>
    service.handleSupportText("22670000000", "Bonjour")
  );

  assert.equal(await service.handleSupportText("22670000000", "Bonjour"), false);
  assert.deepEqual(sent, []);
});

test("open support session still forwards business-looking text to admin", async () => {
  const { sent, service } = makeService();

  await service.handleSupportText("22670000000", "support");
  sent.length = 0;

  const handled = await service.handleSupportText(
    "22670000000",
    "Devis pour Moussa, 2 portes à 25000"
  );

  assert.equal(handled, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "22670626055");
  assert.match(sent[0].text, /Devis pour Moussa/);
});

test("HOME_SUPPORT interactive reply does not open human support session", async () => {
  const { repo, sent, service } = makeService();

  const handled = await service.handleSupportIncomingMessage("22670000000", {
    type: "interactive",
    interactive: { list_reply: { id: "HOME_SUPPORT" } },
  });

  assert.equal(handled, false);
  assert.equal(repo.sessions.has("22670000000"), false);
  assert.deepEqual(sent, []);
});

test("support escalation choices open human support session", async () => {
  const { repo, sent, service } = makeService();

  const handled = await service.handleSupportIncomingMessage("22670000000", {
    type: "interactive",
    interactive: { list_reply: { id: "SUPPORT_TALK_TEAM" } },
  });

  assert.equal(handled, true);
  assert.equal(repo.sessions.get("22670000000").status, "open");
  assert.equal(repo.sessions.get("22670000000").reason, "talk_team");
  assert.match(sent[0].text, /D’accord, je vous mets en relation/);
});

test("demo video choice does not open human support session", async () => {
  const { repo, sent, service } = makeService();

  const handled = await service.handleSupportIncomingMessage("22670000000", {
    type: "interactive",
    interactive: { list_reply: { id: "SUPPORT_DEMO_VIDEO" } },
  });

  assert.equal(handled, false);
  assert.equal(repo.sessions.has("22670000000"), false);
  assert.deepEqual(sent, []);
});

test("payment support choice opens session with payment reason", async () => {
  const { repo, service } = makeService();

  const handled = await service.handleSupportIncomingMessage("22670000000", {
    type: "interactive",
    interactive: { list_reply: { id: "SUPPORT_PAYMENT" } },
  });

  assert.equal(handled, true);
  assert.equal(repo.sessions.get("22670000000").status, "open");
  assert.equal(repo.sessions.get("22670000000").reason, "payment");
});
