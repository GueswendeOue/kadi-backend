"use strict";

function makeKadiFollowups(deps) {
  const { supabase, sendButtons } = deps;

  const MAX_ATTEMPTS = 2;
  const DEFAULT_FIRST_DELAY_HOURS = 24;
  const DEFAULT_FINAL_DELAY_HOURS = 48;

  async function createDevisFollowup({
    waId,
    documentId,
    docNumber,
    sourceDoc,
    dueAt,
  }) {
    const effectiveDueAt =
      dueAt ||
      new Date(
        Date.now() + DEFAULT_FIRST_DELAY_HOURS * 60 * 60 * 1000
      ).toISOString();

    const { error } = await supabase.from("kadi_devis_followups").insert({
      wa_id: waId,
      document_id: documentId || null,
      doc_number: docNumber,
      source_doc: sourceDoc || null,
      due_at: new Date(effectiveDueAt).toISOString(),
      status: "pending",
      attempts: 0,
      postponed_count: 0,
      last_action: null,
      sent_at: null,
      converted_to: null,
      converted_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    });

    if (error) throw error;
  }

  async function markDevisFollowupSent(id) {
    const { error } = await supabase
      .from("kadi_devis_followups")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw error;
  }

  async function postponeDevisFollowup(id, hours = DEFAULT_FINAL_DELAY_HOURS) {
    const { data, error: readError } = await supabase
      .from("kadi_devis_followups")
      .select("postponed_count, attempts, status")
      .eq("id", id)
      .maybeSingle();

    if (readError) throw readError;
    if (!data) return null;

    const postponedCount = Number(data?.postponed_count || 0);
    const attempts = Number(data?.attempts || 0);

    // Une seule relance "plus tard", après on arrête
    if (postponedCount >= 1 || attempts >= MAX_ATTEMPTS) {
      return markDevisFollowupDismissed(id, "max_reminders_reached");
    }

    const { error } = await supabase
      .from("kadi_devis_followups")
      .update({
        status: "pending",
        due_at: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
        postponed_count: postponedCount + 1,
        last_action: "postponed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw error;
    return true;
  }

  async function markDevisFollowupConverted(id, convertedTo) {
    const { error } = await supabase
      .from("kadi_devis_followups")
      .update({
        status: "converted",
        converted_to: convertedTo,
        converted_at: new Date().toISOString(),
        last_action: "converted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw error;
  }

  async function markDevisFollowupDismissed(id, reason = "dismissed") {
    const { error } = await supabase
      .from("kadi_devis_followups")
      .update({
        status: "dismissed",
        last_action: reason,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw error;
  }

  async function markDevisFollowupDone(id) {
    const { error } = await supabase
      .from("kadi_devis_followups")
      .update({
        status: "done",
        last_action: "done",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw error;
  }

  async function cancelDevisFollowup(id) {
    const { error } = await supabase
      .from("kadi_devis_followups")
      .update({
        status: "cancelled",
        last_action: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw error;
  }

  async function getDueDevisFollowups(limit = 20) {
    const { data, error } = await supabase
      .from("kadi_devis_followups")
      .select("*")
      .in("status", ["pending"])
      .lte("due_at", new Date().toISOString())
      .order("due_at", { ascending: true })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  function buildFollowupText(row) {
    const attempts = Number(row?.attempts || 0);
    const postponedCount = Number(row?.postponed_count || 0);
    const isFinalReminder = attempts >= 1 || postponedCount >= 1;

    if (isFinalReminder) {
      return (
        `📄 Rappel final pour votre devis ${row.doc_number}.\n\n` +
        `Avez-vous conclu avec le client ?\n\n` +
        `Vous pouvez maintenant le transformer rapidement en :\n` +
        `• Facture\n• Reçu\n\n` +
        `Ou arrêter ce rappel si ce n’est plus utile.`
      );
    }

    return (
      `📄 Votre devis ${row.doc_number} est prêt depuis 24h.\n\n` +
      `Avez-vous conclu avec le client ?\n\n` +
      `Vous pouvez maintenant le transformer rapidement en :\n` +
      `• Facture\n• Reçu`
    );
  }

  async function sendDevisFollowupMessage(row) {
    const text = buildFollowupText(row);

    const attempts = Number(row?.attempts || 0);
    const postponedCount = Number(row?.postponed_count || 0);
    const isFinalReminder = attempts >= 1 || postponedCount >= 1;

    const primaryButtons = [
      { id: `FOLLOWUP_FACTURE_${row.id}`, title: "📄 Faire facture" },
      { id: `FOLLOWUP_RECU_${row.id}`, title: "🧾 Faire reçu" },
    ];

    if (!isFinalReminder) {
      primaryButtons.push({
        id: `FOLLOWUP_LATER_${row.id}`,
        title: "⏳ Plus tard",
      });
    } else {
      primaryButtons.push({
        id: `FOLLOWUP_DONE_${row.id}`,
        title: "✅ Déjà réglé",
      });
    }

    await sendButtons(row.wa_id, text, primaryButtons);

    await sendButtons(row.wa_id, "Autre option :", [
      { id: `FOLLOWUP_CANCEL_${row.id}`, title: "🛑 Annuler rappel" },
    ]);
  }

  async function processDevisFollowups(limit = 20) {
    const rows = await getDueDevisFollowups(limit);
    if (!rows.length) return 0;

    let sent = 0;

    for (const row of rows) {
      try {
        const attempts = Number(row.attempts || 0);

        if (attempts >= MAX_ATTEMPTS) {
          await markDevisFollowupDismissed(row.id, "max_attempts_reached");
          continue;
        }

        await sendDevisFollowupMessage(row);

        const { error } = await supabase
          .from("kadi_devis_followups")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            attempts: attempts + 1,
            updated_at: new Date().toISOString(),
            last_error: null,
          })
          .eq("id", row.id);

        if (error) throw error;
        sent += 1;
      } catch (e) {
        await supabase
          .from("kadi_devis_followups")
          .update({
            last_error: String(e?.message || e || "unknown_error"),
            attempts: Number(row.attempts || 0) + 1,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
      }
    }

    return sent;
  }

  async function getDevisFollowupById(id) {
    const { data, error } = await supabase
      .from("kadi_devis_followups")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }

  return {
    createDevisFollowup,
    markDevisFollowupSent,
    postponeDevisFollowup,
    markDevisFollowupConverted,
    markDevisFollowupDismissed,
    markDevisFollowupDone,
    cancelDevisFollowup,
    getDueDevisFollowups,
    sendDevisFollowupMessage,
    processDevisFollowups,
    getDevisFollowupById,
  };
}

module.exports = {
  makeKadiFollowups,
};