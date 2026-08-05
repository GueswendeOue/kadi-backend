# Runbook — Diagnostiquer un Flow WhatsApp qui ne répond pas comme attendu

Avant de commencer, lire [`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md)
: le symptôme observé correspond peut-être déjà à une fiche existante.

## Ordre de diagnostic

Suivre cet ordre, du point d'entrée vers Meta, sans sauter d'étape :

1. **Entrée utilisateur** — quel message ou quelle interaction a été
   envoyé ? Un `nfm_reply` (réponse de Flow) ou un message texte libre ?
2. **Webhook** (`kadiV1WebhookRuntime.js`) — le message a-t-il été reçu et
   correctement classifié ? Vérifier l'ordre imposé par
   [`../../AGENTS.md`](../../AGENTS.md) §4 (détection, complétion Flow,
   retour immédiat si `handled=true`).
3. **Action validée** (`kadiV1FlowReplyRuntime.js`) — l'action et ses champs
   ont-ils passé `validateActionPayload` ? Un rejet fermé silencieux à cette
   étape ressemble souvent à une absence de réponse côté utilisateur.
4. **Session** (`kadiV1ConversationSession.js`) — la session existe-t-elle,
   est-elle toujours valide (`expected_flow_key` correspondant,
   propriétaire correspondant, non expirée) ?
5. **Persistance** (`kadiV1SharedDocumentPipeline.js` /
   `kadiV1DischargePipeline.js`) — la mutation métier a-t-elle réellement
   été appliquée au document, ou seulement tentée ? Vérifier les codes
   d'erreur internes retournés (jamais de texte brut de la base).
6. **Presenter** (`kadiV1ProductionPresenter.js`) — quel `flow_key` a été
   calculé par `nextFlowForReply` ? Est-ce le Flow attendu compte tenu de
   l'action et de l'état du document ?
7. **Appel Meta** — le message Flow a-t-il été envoyé avec le bon `flow_id`
   (résolu depuis la bonne variable Render), le bon écran d'entrée, les
   bonnes données de préremplissage ?
8. **Réponse Meta** — Meta a-t-il refusé le Flow (erreur de contrat, écran
   non autorisé comme premier écran, libellé trop long) ? Comparer avec les
   incidents déjà documentés (fiches B et C de
   [`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md)).

## Pièges connus à vérifier en premier

* **Contrainte Supabase désynchronisée** (fiche D) : un nouveau `flow_key`
  ajouté côté Node.js mais absent de
  `kadi_v1_conversation_sessions_expected_flow_key_check` provoque un échec
  **avant tout appel Meta**, avec une erreur PostgreSQL `23514`.
* **Session obsolète après publication** (fiche F) : si le correctif semble
  ne pas fonctionner, vérifier qu'un **nouveau** parcours a bien été démarré
  plutôt que la reprise d'une session ouverte avant le déploiement.
* **Suite locale au vert ≠ configuration distante correcte** (fiche G) : ne
  pas conclure qu'un problème est résolu uniquement parce que `npm test` est
  au vert si le symptôme touche Meta, Render ou Supabase distant.

## Discipline de diagnostic

* Inspecter le code réel avant de formuler une hypothèse — ne pas supposer
  qu'une règle documentée ailleurs est appliquée sans le vérifier dans le
  fichier concerné.
* Ne journaliser et ne partager aucun secret, token, `wa_id` complet ou
  payload complet pendant le diagnostic.
* Une fois la cause confirmée, ajouter une fiche à
  [`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md) avec un
  test de non-régression, uniquement si la cause est réellement confirmée
  (pas une hypothèse plausible).
