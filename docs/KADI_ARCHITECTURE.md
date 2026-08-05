# Architecture de Kadi V1

Ce document décrit le flux technique réel et les fichiers du dépôt qui
l'implémentent, à la date indiquée dans
[`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md). Il complète, sans le
remplacer, `docs/kadi_flow_architecture.md` (document de conception
antérieur, plus détaillé mais potentiellement en avance sur le code réel).

## Vue d'ensemble du flux

```
WhatsApp Cloud API
  → webhook Node.js (routes /webhook, /data_exchange, /health)
  → routage Kadi V1 (kadiV1FlowRouter.js, kadiV1FlowCommandRuntime.js)
  → Flow Meta (JSON dans flows/v1_draft/, un écran terminal par Flow)
  → conversation session (kadiV1ConversationSession.js, Supabase)
  → document métier (kadiV1SharedDocumentPipeline.js / kadiV1DischargePipeline.js)
  → Supabase (persistance du document, historique de version)
  → génération PDF (temporaire puis finale, hors mode DRAFT)
  → stockage privé (artefact PDF, accès contrôlé)
  → livraison WhatsApp (message final à l'utilisateur)
```

## Quatre notions à ne jamais confondre

### 1. Flow Meta

Un écran WhatsApp défini par un fichier JSON dans `flows/v1_draft/`
(`kadi_<flow_key>_v1.json`). Depuis l'incident Meta #131009 (voir
[`decisions/ADR-002-independent-meta-flows.md`](decisions/ADR-002-independent-meta-flows.md)),
chaque Flow est verrouillé à **exactement un écran terminal**, validé par
`kadiV1ReleaseGate.js` (`validateFlowJson`) et `kadiV1ProductionPresenter.js`
(`loadFlowRegistry`). Un Flow ne porte aucune logique métier : il collecte
une réponse et la renvoie via une action nommée (`complete`).

### 2. Session conversationnelle

Un enregistrement temporaire (`kadi_v1_conversation_sessions` sur Supabase,
géré par `kadiV1ConversationSession.js` /
`kadiV1SupabaseConversationSessionRepository.js`) qui relie un `flow_token`
WhatsApp à un `expected_flow_key`, un propriétaire (`owner_wa_id`) et,
lorsqu'un document existe déjà, son identifiant et sa version. Une session
n'est **jamais** la source de vérité d'une décision métier — voir
« Persistance métier » ci-dessous.

### 3. État persistant du document métier

Le document réel (facture, devis, reçu, décharge), géré par
`kadiV1DocumentDomain.js` (règles de mutation, champs serveur protégés) et
persisté via `kadiV1DocumentRepository.js` / son implémentation Supabase.
Toute donnée métier confirmée (client, articles, options, `invoice_kind`,
etc.) doit être écrite dans cet état, jamais seulement gardée dans la
session WhatsApp temporaire.

### 4. Portefeuille de crédits, artefact PDF, historique

* le portefeuille de crédits est débité uniquement après confirmation
  explicite et génération réelle (voir
  [`KADI_PRODUCT_RULES.md`](KADI_PRODUCT_RULES.md)) ;
* l'artefact PDF final est stocké de façon privée (voir
  [`decisions/ADR-004-private-pdf-storage.md`](decisions/ADR-004-private-pdf-storage.md)) ;
* l'historique et le retéléchargement (`kadiV1HistoryService.js`) donnent
  accès aux documents déjà générés sans en produire de nouveaux exemplaires
  facturés.

## Registres centraux (fichiers réels)

| Registre | Fichier | Rôle |
|---|---|---|
| Clés de Flow logiques | `kadiV1FlowRouter.js` (`FLOW_KEYS`, copie locale dans `kadiV1FlowCommandRuntime.js`) | Liste fermée des `flow_key` valides |
| Variables d'environnement de Flow | `kadiV1RuntimeConfig.js` (`FLOW_ENV_KEYS`) | `flow_key` → nom de variable Render contenant l'ID Meta |
| Catalogue des Flows brouillon | `kadiV1DraftFlowCatalog.js` | `flow_key` → fichier JSON, variable, carte WhatsApp |
| Actions et champs autorisés | `kadiV1FlowReplyRuntime.js` (`FLOW_ACTIONS`, `ACTION_FIELDS`) | Liste fermée des actions par Flow et des champs par action |
| Dispatch des commandes | `kadiV1FlowCommandRuntime.js` (`ACTIONS`, `operations`) | Action validée → appel du bon runtime |
| Adaptateurs de runtime | `kadiV1RuntimeAdapters.js` | Traduction commande → appel pipeline document/aperçu/génération |
| Pipeline documentaire partagé | `kadiV1SharedDocumentPipeline.js` | Mutations métier pour FACTURE/DEVIS/RECU |
| Pipeline décharge | `kadiV1DischargePipeline.js` | Mutations métier propres à DECHARGE |
| Présentation WhatsApp | `kadiV1ProductionPresenter.js` | Construit le message Flow suivant, résumés lisibles |
| Passerelle CANARY | `kadiV1CanaryIngress.js` | Mode de rollout et liste des propriétaires autorisés |
| Portes de release | `kadiV1ReleaseGate.js` | Vérifie la cohérence Flow/variables/JSON avant activation |

## Ordre obligatoire du webhook

Pour un message interactif reconnu (`nfm_reply`), l'ordre est fixé par
[`../AGENTS.md`](../AGENTS.md) §4 : détection, exécution de la complétion
Flow, orchestration de la session suivante si besoin, retour immédiat si
`handled=true`, sans exécuter les anciens handlers ni appeler OpenAI une
seconde fois. Ne pas dupliquer cette règle ailleurs ; la lire dans
`AGENTS.md`.

## Persistance des migrations

Deux copies byte-identiques de chaque migration corrective sont maintenues :
`supabase/migrations/<timestamp_complet>_<description>.sql` et
`migrations/<date>_<description>.sql`. Voir
[`runbooks/APPLY_SUPABASE_MIGRATION.md`](runbooks/APPLY_SUPABASE_MIGRATION.md).
