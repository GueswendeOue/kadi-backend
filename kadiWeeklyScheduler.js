"use strict";

const cron = require("node-cron");
const { makeKadiWeeklyReport } = require("./kadiWeeklyReport");
const { sendText } = require("./kadiMessaging");

function startKadiWeeklyScheduler({ adminWaId }) {
  const reporter = makeKadiWeeklyReport({
    sendText: async (to, text) => {
      await sendText(to, text);
    },
    adminWaId,
  });

  // Dimanche à 18h00
  cron.schedule("0 18 * * 0", async () => {
    try {
      console.log("[KADI/WEEKLY] Sunday report started");
      await reporter.sendWeeklyReport();
      console.log("[KADI/WEEKLY] Sunday report sent");
    } catch (e) {
      console.error("[KADI/WEEKLY] error:", e);
    }
  });

  console.log("[KADI/WEEKLY] scheduler started: every Sunday at 18:00");
}

module.exports = {
  startKadiWeeklyScheduler,
};