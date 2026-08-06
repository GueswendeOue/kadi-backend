# Checklist de release — Kadi V1

À suivre intégralement avant toute livraison qui touche un Flow Meta, une
migration Supabase ou un déploiement Render. Consulter avant toute mission
de livraison (voir [`../AGENTS.md`](../AGENTS.md)).

Cocher mentalement chaque étape ; ne pas sauter une étape parce que la
précédente a réussi.

## Préparation locale

- [ ] **Branche et base** : vérifier `git branch --show-current` et que la
      base correspond bien au commit attendu de la mission.
- [ ] **Worktree** : `git status --short` propre avant de commencer, aucun
      travail existant écrasé.
- [ ] **Diff** : relire `git diff --stat` et `git diff --check` avant de
      considérer le changement terminé.
- [ ] **Tests ciblés** : exécuter uniquement les tests des fichiers touchés
      d'abord.
- [ ] **Suite complète** : exécuter `npm test` une seule fois, avec un délai
      borné, après les tests ciblés — pas avant.

## Flow Meta

- [ ] **JSON du Flow** conforme au contrat mono-écran verrouillé (un seul
      écran `terminal: true`, `routing_model` vide pour sa propre clé) — voir
      [`decisions/ADR-002-independent-meta-flows.md`](decisions/ADR-002-independent-meta-flows.md).
- [ ] **Limites de libellés** respectées (`cta` ≤ 30 caractères, aucun
      libellé visible trop long pour Meta) — voir fiche C de
      [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md).
- [ ] **Publication du Flow** sur Meta effectuée uniquement avec autorisation
      explicite de la mission.

## Configuration Render

- [ ] **Identifiant Render** (l'ID Meta du Flow publié) obtenu et prêt à
      configurer.
- [ ] **Validation de configuration** : `kadiV1ReleaseGate.js`
      (`evaluateKadiV1ReleaseGate` en mode `ACTIVATION`) ne signale aucun
      `flow_key` manquant ni ID dupliqué avant de considérer la variable
      posée.

## Migration Supabase

- [ ] **Forward-only** : la migration n'altère aucune migration déjà
      appliquée ; elle ajoute seulement.
- [ ] **`migration list`** exécuté pour comparer l'état local et distant
      avant toute action.
- [ ] **`db push --dry-run`** exécuté et son résultat lu intégralement avant
      toute application réelle — voir
      [`runbooks/APPLY_SUPABASE_MIGRATION.md`](runbooks/APPLY_SUPABASE_MIGRATION.md).
- [ ] **Application distante** effectuée uniquement avec autorisation
      explicite, jamais par défaut.
- [ ] **Vérification SQL en lecture seule** après application, pour
      confirmer la contrainte/l'objet attendu sans modifier de données.

## Ordre obligatoire — `fix/kadi-v1-pdf-final-state-and-tax-rate-r0` (identité de finalisation)

Cette branche a introduit une dépendance d'ordonnancement stricte entre la
migration Supabase et le déploiement backend, confirmée par revue
adversariale indépendante (voir fiche P de
[`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md)). Séquence
effectivement suivie, corrections comprises — voir aussi la nouvelle règle
générale dans [`runbooks/DEPLOY_CANARY.md`](runbooks/DEPLOY_CANARY.md) :

**Correctif critique (2026-08-06) :** l'hypothèse initiale de cette section
— « `kadi-backend` sur Render auto-déploie `main` » — était **fausse** et a
été découverte fausse *après* la fusion de la PR #12, par vérification
directe de l'API Render (`GET /v1/services/srv-d5a93m1r0fns73879big` →
`autoDeploy: "no"`, `autoDeployTrigger: "off"`). **Ce service ne déploie
jamais automatiquement.** Chaque déploiement, historiquement, a toujours été
`trigger: "manual"` (ou `"rollback"`) — jamais automatique. Fusionner une PR
dans `main` ne fait donc que mettre à jour `main` sur GitHub ; le code
précédemment déployé continue de tourner sur Render jusqu'à un déclenchement
manuel explicite. Voir la fiche P de
[`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le récit
complet de la fenêtre de compatibilité que cette hypothèse erronée a
laissée ouverte plus longtemps que prévu.

1. **[FAIT]** Revoir et approuver le code (revue adversariale indépendante,
   corrections appliquées).
2. **[FAIT — 2026-08-06T12:11:31Z]** Appliquer
   `supabase/migrations/20260806010000_add_kadi_v1_finalization_identity.sql`
   en distant et vérifier sa présence en distant (lecture seule de la
   définition de `kadi_v1_persist_transition` /
   `kadi_v1_generate_document_number`) — appliquée et vérifiée sur le
   projet `cmhargmwkyskbobmkrcj`, présente exactement une fois dans
   `supabase migration list`, corps des deux fonctions et permissions
   vérifiés en lecture seule contre la source de la migration. Voir fiche P
   de [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md).
3. **[FAIT — 2026-08-06T12:48:49Z]** Fusionner la PR backend dans `main` —
   [PR #12](https://github.com/GueswendeOue/kadi-backend/pull/12), commit de
   fusion `35358e5f301e821ac0ad8f6953c118146521878c`. **Cette fusion, à elle
   seule, n'a rien déployé** (voir correctif critique ci-dessus) — l'ancien
   commit `f95be84b98d3d9ad6308a6aebbc3e11590717ae2` est resté `live` sur
   Render jusqu'à l'étape suivante.
4. **[FAIT — déclenché 2026-08-06T14:01:37.902341Z, LIVE
   2026-08-06T14:02:47.395578Z]** Déclencher explicitement **un** déploiement
   manuel Render (`dep-d9q97g9t0dsc73cgisog`) et attendre le statut `live`
   confirmé par l'API Render — jamais en déduire l'état depuis le seul
   statut de fusion GitHub. Build réussi, checkout confirmé sur
   `35358e5f301e821ac0ad8f6953c118146521878c`, ancien déploiement
   `dep-d9ppc1lbedkc73e27klg` passé à `deactivated`.
5. **[FAIT]** Vérifier le démarrage du service et l'absence d'erreur
   `KADI_V1_SERVER_FIELD_FORBIDDEN` / `DOCUMENT_FINALIZATION_IDENTITY_MISSING`
   / `DOCUMENT_FINALIZATION_IDENTITY_CORRUPT` — logs de boot Render inspectés
   directement (`KADI_V1_WEBHOOK_READY`: `ready:true, active:true,
   state:"READY", rollout_mode:"CANARY", blocker:null, missing_ports:[],
   missing_capabilities:[]`), zéro log de niveau erreur depuis le boot.
   **Un document de test réel n'a pas été généré** (interdit par la mission
   de vérification) — cette étape reste donc une preuve de démarrage/lecture
   seule, pas une preuve de bout en bout de `MARK_GENERATED` en conditions
   réelles ; la matrice CANARY (étape 9) reste nécessaire pour cela.
6. **[EN ATTENTE]** Publier la nouvelle version du Flow Meta
   `DOCUMENT_OPTIONS` (champ `tax_rate_percent`) — autorisation explicite
   requise, non encore effectuée.
7. **[EN ATTENTE]** Configurer un nouvel identifiant/variable d'environnement
   Render uniquement si la publication en a effectivement créé un nouveau.
8. **[EN ATTENTE]** Démarrer une session WhatsApp fraîche pour la validation
   — jamais la reprise d'une session ouverte avant l'étape 4 ou 6 (voir
   fiche F de [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md)).
9. **[EN ATTENTE]** Exécuter la matrice CANARY : FACTURE FINAL, FACTURE
   PROFORMA, DEVIS, RECU A4, RECU TICKET_80, DECHARGE (MONEY/GOODS/DOCUMENT/
   OTHER) — vérifier pour chacun : titre correct, numéro et date réels
   (jamais BROUILLON), un seul crédit débité, options/taxe atteignables,
   calcul 18 % correct, historique correct, reprise après échec de rendu.
   Diagnostiquer le blocage de navigation depuis les logs Render
   privacy-safe en conditions réelles —
   `UNRESOLVED_PRODUCTION_DIAGNOSIS_REQUIRED`.
10. **[EN ATTENTE]** Seulement ensuite envisager un rollout plus large.

**Fenêtre de compatibilité migration-avant-déploiement effectivement
observée :** de l'application de la migration
(`2026-08-06T12:11:31Z`) jusqu'à la mise en `live` du déploiement manuel
correctif (`2026-08-06T14:02:47.395578Z`) — environ 1h51. Pendant cette
fenêtre, l'ancien backend (`f95be84b...`), toujours servi par Render, restait
exposé au risque `KADI_V1_SERVER_FIELD_FORBIDDEN` sur `MARK_GENERATED` décrit
ci-dessous, pour tout utilisateur CANARY réel — voir fiche P de
[`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour l'analyse
complète et la confirmation que la fenêtre est refermée depuis
`2026-08-06T14:02:47.395578Z`.

**Conséquences documentées si l'ordre n'est pas respecté :**

* PR backend fusionnée **avant** l'étape 2 (migration appliquée) : la RPC
  `kadi_v1_persist_transition` alors en place rejette tout `issued_at` non
  nul hors de l'état `GENERATED` — **panne totale de la génération finale**,
  tous types de documents, tous utilisateurs, jusqu'à application de la
  migration **et** déploiement effectif du nouveau backend (les deux sont
  requis — voir point suivant).
* **Nouveau, confirmé le 2026-08-06 :** l'inverse — migration appliquée
  **avant** que l'ancien backend ne soit remplacé par un déploiement
  effectif — casse également `MARK_GENERATED` pour l'ancien backend, qui
  recalcule un `issued_at` différent de celui déjà assigné par la RPC à
  `START_GENERATION` et se fait rejeter par `KADI_V1_SERVER_FIELD_FORBIDDEN`.
  **La compatibilité de la base de données doit donc toujours être vérifiée
  dans les deux sens : nouveau backend avec ancienne base, et ancien backend
  avec nouvelle base** — cette seconde direction n'avait jamais été
  envisagée avant cet incident. Une fusion GitHub réussie **ne prouve
  jamais**, à elle seule, qu'un nouveau code est en cours d'exécution : seul
  l'état `live` confirmé par les métadonnées Render, sur le commit attendu,
  en fait foi ; `GET /health` seul ne le prouve pas non plus (réponse
  statique sans SHA ni métadonnées de version).
* Ancien backend avec un Flow déjà republié (étape 6 avant étape 4) :
  sans risque grâce à la fenêtre de compatibilité double-champ — le champ
  `tax_rate_percent` du nouveau Flow serait néanmoins rejeté par l'ancien
  backend s'il n'accepte pas encore ce nom de champ ; respecter l'ordre
  ci-dessus évite la question.
* Session WhatsApp restée ouverte pendant la bascule : reste acceptée
  pendant la fenêtre de compatibilité (les deux noms de champ de taxe sont
  acceptés), mais doit néanmoins être revalidée par une session fraîche
  avant de conclure à une correction réelle.
* Migration non appliquée du tout : voir premier point — même conséquence,
  permanente tant que la migration n'est pas appliquée. **Ce cas ne
  s'applique plus à `20260806010000_add_kadi_v1_finalization_identity.sql`,
  appliquée et vérifiée en distant le 2026-08-06.**

## Déploiement Render

- [ ] **Commit Render attendu** : vérifier que le commit qui sera déployé
      est exactement celui déjà testé (ne pas relancer `npm test` sur un
      commit déjà validé identique).
- [ ] **Service `kadi-backend` uniquement** — ne jamais toucher les services
      `kadi-beta-cleanup` ou `kadi-beta-notify` (voir
      [`../CLAUDE.md`](../CLAUDE.md) et
      [`runbooks/DEPLOY_CANARY.md`](runbooks/DEPLOY_CANARY.md)).
- [ ] **Statut Live** confirmé sur Render avant de considérer le déploiement
      terminé.

## Vérification en conditions réelles

- [ ] **Nouveau parcours CANARY** démarré depuis un message entrant frais,
      jamais la reprise d'une session ouverte avant la publication — voir
      fiche F de
      [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md).
- [ ] **Contrôle des logs** : aucune fuite de secret, token, `wa_id` complet
      ou payload complet ; codes d'erreur internes uniquement.
- [ ] **Contrôle des crédits** : aucun débit inattendu pendant le parcours
      de vérification, conforme à
      [`KADI_PRODUCT_RULES.md`](KADI_PRODUCT_RULES.md).
- [ ] **Rollback identifié** : le dernier commit et, le cas échéant, la
      dernière configuration Render stables sont notés avant de commencer,
      au cas où — voir
      [`runbooks/ROLLBACK_PRODUCTION.md`](runbooks/ROLLBACK_PRODUCTION.md).

## Fonctionnalités à allowlist CANARY indépendante (ex. KADI_CONVERSATIONAL_MULTIMODAL_V1)

À suivre en plus des sections ci-dessus pour toute fonctionnalité qui, comme
`KADI_CONVERSATIONAL_MULTIMODAL_V1`, introduit sa **propre** allowlist
distincte de `KADI_V1_CANARY_WA_IDS` (voir
[`KADI_CONVERSATIONAL_MULTIMODAL_V1.md`](KADI_CONVERSATIONAL_MULTIMODAL_V1.md)) :

- [ ] **Câblage revu séparément** : la mission d'intégration dans
      l'orchestrateur/le bootstrap a été revue indépendamment de la mission
      qui a créé la fondation, avant toute fusion.
- [ ] **Allowlist dédiée vide par défaut** : la variable Render
      correspondante (ex. `KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS`)
      n'hérite jamais implicitement de `KADI_V1_CANARY_WA_IDS` — vérifié par
      test avant toute configuration Render.
- [ ] **Sous-capacités expérimentales restent désactivées** (ex. Gemini
      Audio / `KADI_GEMINI_AUDIO_V1_ENABLED`) tant qu'aucune mission
      distincte ne les active explicitement.
- [ ] **Aucune deuxième implémentation de mutation** : toute application à
      un document réutilise le port existant (`documents.apply(...)` ou
      équivalent) avec la forme de donnée exacte qu'il attend — jamais une
      resynthèse depuis un contrat différent (voir fiche L de
      [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md)).
- [ ] **Comportement inchangé prouvé par test** pour tout propriétaire hors
      de la nouvelle allowlist, avant toute configuration Render de celle-ci.

## Après la livraison

- [ ] **`KADI_CURRENT_STATE.md`** mis à jour avec le nouveau statut réel
      (`VALIDATED_CANARY` seulement après vérification en conditions
      réelles, pas au moment du merge du code).
- [ ] **Mémoire technique** (`KADI_ENGINEERING_MEMORY.md`) mise à jour si un
      incident a été rencontré et résolu pendant la livraison, avec cause
      confirmée uniquement.
