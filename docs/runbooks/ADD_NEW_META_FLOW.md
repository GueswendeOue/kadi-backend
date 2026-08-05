# Runbook — Ajouter un nouveau Flow Meta (`FLOW_KEY`)

À suivre intégralement pour tout nouveau `flow_key`. Chaque étape doit être
faite **dans cet ordre** ; sauter une étape (en particulier la contrainte
Supabase) reproduit l'incident décrit en fiche D de
[`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md).

Toute étape marquée **(distant)** est une action externe qui exige une
autorisation explicite de la mission — voir [`../../AGENTS.md`](../../AGENTS.md).

## 1. FLOW_KEY

* Ajouter la nouvelle clé à `FLOW_KEYS` dans `kadiV1FlowRouter.js` **et**
  dans la copie locale de `kadiV1FlowCommandRuntime.js` (les deux doivent
  rester synchronisées).
* Positionner la clé logiquement dans le parcours (ex. juste après l'étape
  qui la précède), pour la lisibilité du registre.

## 2. JSON

* Créer `flows/v1_draft/kadi_<flow_key_minuscule>_v1.json`.
* Respecter le contrat mono-écran verrouillé (voir
  [`../decisions/ADR-002-independent-meta-flows.md`](../decisions/ADR-002-independent-meta-flows.md)) :
  un seul écran, `terminal: true`, `id` égal au `flow_key`,
  `routing_model: { [flow_key]: [] }`, un champ `session_id` dans `data`.
* Vérifier la longueur des libellés visibles (voir fiche C de
  [`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md)).

## 3. Action backend

* Choisir un nom d'action cohérent avec les conventions existantes
  (`SAVE_...`, `SELECT_...`, `ADD_...`, etc.).
* Ajouter l'action à `FLOW_ACTIONS` et les champs autorisés à
  `ACTION_FIELDS` dans `kadiV1FlowReplyRuntime.js`, avec toute validation
  stricte nécessaire (valeurs exactes acceptées, rejet fermé sinon).
* Ajouter l'action à `ACTIONS` et sa branche de dispatch dans `operations`
  (`kadiV1FlowCommandRuntime.js`).

## 4. Variable Render

* Choisir le nom `KADI_V1_FLOW_<FLOW_KEY>_ID`.
* L'ajouter à `FLOW_ENV_KEYS` dans `kadiV1RuntimeConfig.js`.
* L'ajouter à l'entrée correspondante de `KADI_V1_DRAFT_FLOW_CATALOG`
  (`kadiV1DraftFlowCatalog.js`), avec le chemin du fichier JSON et la carte
  WhatsApp (`header`, `body`, `cta`).

## 5. Routage

* Mettre à jour `nextFlowForReply` dans `kadiV1ProductionPresenter.js` pour
  que l'action précédente ouvre le nouveau Flow, et que la nouvelle action
  ouvre le Flow suivant attendu.
* Si le nouveau Flow doit aussi être atteint lors d'une reprise de session
  (session expirée, document déjà en cours), mettre à jour
  `resolveFlowKey` dans `kadiV1FlowRouter.js` en conséquence — et vérifier
  qu'un appelant de production existe réellement pour ce chemin (voir fiche
  H de [`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md) pour
  un exemple de dette où ce n'était pas le cas).

## 6. Persistance métier

* Si le nouveau Flow collecte une donnée métier durable, l'écrire dans le
  document réel (pas seulement dans la session WhatsApp) — réutiliser une
  structure existante (ex. le sac `options`) si elle convient ; ne pas créer
  de nouvelle colonne SQL sans preuve qu'elle est indispensable.
* Ajouter la fonction de mutation correspondante dans
  `kadiV1SharedDocumentPipeline.js` (ou `kadiV1DischargePipeline.js` pour
  une décharge), avec son propre préfixe d'idempotence.
* Câbler l'adaptateur correspondant dans `kadiV1RuntimeAdapters.js`.

## 7. Contrainte Supabase

* Créer une migration forward-only ajoutant le nouveau `flow_key` à
  `kadi_v1_conversation_sessions_expected_flow_key_check` — **ne jamais**
  modifier une migration déjà appliquée (voir
  [`APPLY_SUPABASE_MIGRATION.md`](APPLY_SUPABASE_MIGRATION.md)).
* Créer les deux copies byte-identiques :
  `supabase/migrations/<timestamp_complet>_<description>.sql` et
  `migrations/<date>_<description>.sql`.

## 8. Migration

* Vérifier que le nombre total de valeurs de la contrainte augmente
  exactement de un, et que l'ordre des valeurs préexistantes est préservé.

## 9. Tests

* Registre (`flow_key` connu, variable résolue, échec fermé si absente).
* JSON (mono-écran, action correcte, aucun second écran).
* Routage (avant/après, y compris les types de document non concernés qui
  ne doivent pas changer de comportement).
* Validation (valeurs acceptées, valeurs rejetées : vide, minuscule,
  inconnue).
* Reprise (si applicable).
* Migration (deux fichiers présents, identiques, valeurs attendues).
* Non-régression (les tests des Flows déjà existants restent au vert).

## 10. Publication Meta **(distant)**

* Publier le Flow uniquement avec autorisation explicite.

## 11. Configuration Render **(distant)**

* Poser la variable `KADI_V1_FLOW_<FLOW_KEY>_ID` avec l'ID Meta réel,
  uniquement avec autorisation explicite.

## 12. Application Supabase **(distant)**

* Appliquer la migration en distant en suivant
  [`APPLY_SUPABASE_MIGRATION.md`](APPLY_SUPABASE_MIGRATION.md), uniquement
  avec autorisation explicite.

## 13. Déploiement **(distant)**

* Déployer le service `kadi-backend` uniquement, en suivant
  [`DEPLOY_CANARY.md`](DEPLOY_CANARY.md).

## 14. Nouveau parcours CANARY

* Valider avec un **nouveau** message entrant (jamais la reprise d'une
  session ouverte avant publication — fiche F de
  [`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md)).
* Mettre à jour [`../KADI_CURRENT_STATE.md`](../KADI_CURRENT_STATE.md) une
  fois la validation confirmée en conditions réelles.
