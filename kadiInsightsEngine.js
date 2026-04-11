"use strict";

function buildInsights(stats) {
  const alerts = [];
  const insights = [];
  const actions = [];

  if (stats.docs.creationToPdfRate < 35) {
    alerts.push("⚠️ Conversion création → PDF faible");
    insights.push("Beaucoup d’utilisateurs commencent mais peu finalisent.");
    actions.push("Réduire la friction avant le PDF et simplifier le CTA final.");
  }

  if (stats.comparisons.docs7Growth < 0) {
    alerts.push("⚠️ Baisse des documents générés sur 7 jours");
    insights.push("L’usage produit ralentit cette semaine.");
    actions.push("Faire une relance WhatsApp ciblée sur les users actifs récents.");
  }

  if (stats.comparisons.active7Growth < 0) {
    alerts.push("⚠️ Baisse des actifs 7 jours");
    insights.push("Moins d’utilisateurs reviennent cette semaine.");
    actions.push("Tester une campagne de réactivation courte avec un cas d’usage simple.");
  }

  if (stats.users.active30 > 50 && stats.users.paid <= 3) {
    alerts.push("⚠️ Monétisation faible");
    insights.push("Le produit est utilisé mais convertit peu en paiement.");
    actions.push("Mettre une incitation de recharge plus visible après usage réel.");
  }

  if (stats.docs.last7 > 0 && stats.docs.creationToPdfRate >= 50) {
    insights.push("La finalisation est bonne.");
    actions.push("Accélérer l’acquisition car le cœur du flow tient déjà.");
  }

  return {
    alerts: alerts.slice(0, 3),
    insights: insights.slice(0, 3),
    actions: actions.slice(0, 3),
    priorityAction: actions[0] || "Continuer à observer les métriques cette semaine.",
  };
}

module.exports = {
  buildInsights,
};