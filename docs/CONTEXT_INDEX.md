# Index de contexte Kadi

Ce fichier est le point d'entrée documentaire de Kadi AI. Toute IA (Codex,
Claude ou autre) doit le consulter avant une modification importante, en
suivant le renvoi depuis [`../AGENTS.md`](../AGENTS.md).

Statuts utilisés dans tous les documents de ce dossier :
`VALIDATED_CANARY`, `IMPLEMENTED_NOT_DEPLOYED`, `PLANNED`, `BLOCKED`,
`DEFERRED`.

## Documents de contexte

| Document | Contenu | Quand le lire |
|---|---|---|
| [`KADI_PROJECT_VISION.md`](KADI_PROJECT_VISION.md) | Pourquoi Kadi existe, cible, valeur | Prise de contexte initiale, décision produit |
| [`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md) | État réel du dépôt à date, ce qui est déployé ou non | Avant toute mission, pour situer le travail |
| [`KADI_ARCHITECTURE.md`](KADI_ARCHITECTURE.md) | Flux technique, fichiers réels, séparations de responsabilité | Avant une modification technique |
| [`KADI_PRODUCT_RULES.md`](KADI_PRODUCT_RULES.md) | Règles métier verrouillées (crédits, facture, reçu) | Avant une modification touchant la logique métier |
| [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) | Incidents déjà rencontrés, causes confirmées, correctifs | Avant tout diagnostic, avant de supposer une cause |
| [`KADI_RELEASE_CHECKLIST.md`](KADI_RELEASE_CHECKLIST.md) | Étapes obligatoires avant une livraison | Avant toute mission de déploiement ou publication |
| [`KADI_ROADMAP.md`](KADI_ROADMAP.md) | Ce qui reste à faire, dans quel ordre | Pour situer une mission dans la trajectoire produit |

## Décisions d'architecture (ADR)

| ADR | Sujet |
|---|---|
| [`decisions/ADR-001-whatsapp-first.md`](decisions/ADR-001-whatsapp-first.md) | Choix de WhatsApp comme seule interface |
| [`decisions/ADR-002-independent-meta-flows.md`](decisions/ADR-002-independent-meta-flows.md) | Flows Meta indépendants et mono-écran |
| [`decisions/ADR-003-credit-model.md`](decisions/ADR-003-credit-model.md) | Modèle de crédits par page PDF finale |
| [`decisions/ADR-004-private-pdf-storage.md`](decisions/ADR-004-private-pdf-storage.md) | Stockage privé des PDF générés |

## Runbooks (procédures pas à pas)

| Runbook | Quand l'utiliser |
|---|---|
| [`runbooks/ADD_NEW_META_FLOW.md`](runbooks/ADD_NEW_META_FLOW.md) | Ajouter un nouveau `FLOW_KEY` / Flow Meta |
| [`runbooks/APPLY_SUPABASE_MIGRATION.md`](runbooks/APPLY_SUPABASE_MIGRATION.md) | Écrire et appliquer une migration Supabase |
| [`runbooks/DEPLOY_CANARY.md`](runbooks/DEPLOY_CANARY.md) | Déployer une version sur Render en CANARY |
| [`runbooks/DEBUG_WHATSAPP_FLOW.md`](runbooks/DEBUG_WHATSAPP_FLOW.md) | Diagnostiquer un Flow WhatsApp qui ne répond pas comme attendu |
| [`runbooks/ROLLBACK_PRODUCTION.md`](runbooks/ROLLBACK_PRODUCTION.md) | Revenir en arrière après un incident |

## Documents techniques historiques

Le dossier `docs/` contient aussi des documents de conception antérieurs
(`kadi_v1_foundational_decisions.md`, `kadi_flow_architecture.md`,
`kadi_v1_release_scope.md`, etc.). Ils restent utiles comme référence de
conception détaillée, mais en cas de contradiction avec un document listé
ci-dessus ou avec le code réel, **le code réel et les tests font foi**, puis
[`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md).

## Règle de non-duplication

Ce dossier documentaire dérive son contenu de l'inspection du dépôt réel. Ne
pas dupliquer les règles déjà écrites dans `AGENTS.md` ou `CLAUDE.md` ; y
renvoyer par lien à la place.
