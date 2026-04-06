"use strict";

function makeKadiFollowups(deps) {
  const {
    supabase,
    sendButtons,
  } = deps;

  async function createDevisFollowup({
    waId,
    documentId,
    docNumber,
    sourceDoc,
    dueAt,
  }) {
    const { error } = await supabase.from("kadi_devis_followups").insert({
      wa_id: waId,
      document_id: documentId || null,
      doc_number: docNumber,
      source_doc: sourceDoc || null,
      due_at: new Date(dueAt).toISOString(),
      status: "pending",
      attempts: 0,
      postponed_count: 0,
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

  async function postponeDevisFollowup(id, hours = 24) {
    const { data, error: readError } = await supabase
      .from("kadi_devis_followups")
      .select("postponed_count")
      .eq("id", id)
      .maybeSingle();

    if (readError) throw readError;

    const { error } = await supabase
      .from("kadi_devis_followups")
      .update({
        status: "pending",
        due_at: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
        postponed_count: Number(data?.postponed_count || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw error;
  }

  async function markDevisFollowupConverted(id, convertedTo) {
    const { error } = await supabase
      .from("kadi_devis_followups")
      .update({
        status: "converted",
        converted_to: convertedTo,
        converted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw error;
  }

  async function markDevisFollowupDismissed(id) {
    const { error } = await supabase
      .from("kadi_devis_followups")
      .update({
        status: "dismissed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (error) throw error;
  }

  async function getDueDevisFollowups(limit = 20) {
    const { data, error } = await supabase
      .from("kadi_devis_followups")
      .select("*")
      .eq("status", "pending")
      .lte("due_at", new Date().toISOString())
      .order("due_at", { ascending: true })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  async function sendDevisFollowupMessage(row) {
    const text =
      `📄 Votre devis ${row.doc_number} est prêt depuis 24h.\n\n` +
      `Avez-vous conclu avec le client ?\n\n` +
      `Vous pouvez maintenant le transformer rapidement en :\n` +
      `• Facture\n• Reçu`;

    await sendButtons(row.wa_id, text, [
      { id: `FOLLOWUP_FACTURE_${row.id}`, title: "📄 Faire facture" },
      { id: `FOLLOWUP_RECU_${row.id}`, title: "🧾 Faire reçu" },
      { id: `FOLLOWUP_LATER_${row.id}`, title: "⏳ Plus tard" },
    ]);
  }

  async function processDevisFollowups(limit = 20) {
    const rows = await getDueDevisFollowups(limit);
    if (!rows.length) return 0;

    let sent = 0;

    for (const row of rows) {
      try {
        await sendDevisFollowupMessage(row);

        const { error } = await supabase
          .from("kadi_devis_followups")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            attempts: Number(row.attempts || 0) + 1,
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
    getDueDevisFollowups,
    sendDevisFollowupMessage,
    processDevisFollowups,
    getDevisFollowupById,
  };
}

module.exports = {
  makeKadiFollowups,
};