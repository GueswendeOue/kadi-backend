"use strict";

const ExcelJS = require("exceljs");
const { getStats, money } = require("./kadiStatsRepo");

async function exportKadiExcel(filePath = "./kadi_growth_report.xlsx") {
  const stats = await getStats();

  const wb = new ExcelJS.Workbook();

  const summary = wb.addWorksheet("summary");
  summary.addRow(["Metric", "Value"]);
  summary.addRow(["Users Total", stats.users.total]);
  summary.addRow(["Active 7d", stats.users.active7]);
  summary.addRow(["Active 30d", stats.users.active30]);
  summary.addRow(["Docs Created", stats.docs.created]);
  summary.addRow(["Docs PDF", stats.docs.generated]);
  summary.addRow(["Creation to PDF %", stats.docs.creationToPdfRate]);
  summary.addRow(["Docs 7d", stats.docs.last7]);
  summary.addRow(["Docs 30d", stats.docs.last30]);
  summary.addRow(["Revenue 30d", stats.revenue.month]);
  summary.addRow(["Paid Users", stats.users.paid]);

  const funnel = wb.addWorksheet("funnel");
  funnel.addRow(["Step", "Rate"]);
  funnel.addRow(["Signup → Active 30d", `${stats.funnel.signupToActive30Rate}%`]);
  funnel.addRow(["Active → Created", `${stats.funnel.activeToCreatedRate}%`]);
  funnel.addRow(["Created → PDF", `${stats.funnel.createdToGeneratedRate}%`]);
  funnel.addRow(["PDF → Paid", `${stats.funnel.generatedToPaidRate}%`]);

  const topUsers = wb.addWorksheet("top_users");
  topUsers.columns = [
    { header: "wa_id", key: "wa_id", width: 22 },
    { header: "docs", key: "docs", width: 12 },
    { header: "total_fcfa", key: "total_fcfa", width: 18 },
  ];
  (stats.topUsers || []).forEach((r) => topUsers.addRow(r));

  const topClients = wb.addWorksheet("top_clients");
  topClients.columns = [
    { header: "client", key: "client", width: 28 },
    { header: "docs", key: "docs", width: 12 },
    { header: "total_fcfa", key: "total_fcfa", width: 18 },
  ];
  (stats.topClients || []).forEach((r) => topClients.addRow(r));

  const alerts = wb.addWorksheet("alerts");
  alerts.addRow(["Type", "Value"]);
  (stats.alerts || []).forEach((a) => alerts.addRow(["alert", a]));

  await wb.xlsx.writeFile(filePath);
  return filePath;
}

module.exports = {
  exportKadiExcel,
};