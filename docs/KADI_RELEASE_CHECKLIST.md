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

Cette branche introduit une dépendance d'ordonnancement stricte entre la
migration Supabase et le déploiement backend, confirmée par revue
adversariale indépendante (voir fiche P de
[`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md)). Suivre
exactement cet ordre, dans ce sens, à ne pas paralléliser :

**Précision critique :** `kadi-backend` sur Render **auto-déploie `main`**
(voir [`runbooks/DEPLOY_CANARY.md`](runbooks/DEPLOY_CANARY.md)) — le
déploiement n'est donc pas une étape manuelle séparée exécutée après coup,
il se produit **au moment de la fusion** de la PR backend dans `main`. Par
conséquent, l'étape 1 ci-dessous (migration appliquée et vérifiée en
distant) doit être terminée **avant la fusion de la PR backend**, pas
seulement « avant un déploiement ultérieur » — fusionner sans avoir
d'abord appliqué la migration revient, dans les faits, à déployer sans
elle.

1. **Revoir et approuver le code** (revue normale de la PR backend) — ne
   pas fusionner à cette étape.
2. **Appliquer** `supabase/migrations/20260806010000_add_kadi_v1_finalization_identity.sql`
   en distant (autorisation explicite requise, voir
   [`runbooks/APPLY_SUPABASE_MIGRATION.md`](runbooks/APPLY_SUPABASE_MIGRATION.md))
   et **vérifier** sa présence en distant (lecture seule de la définition
   de `kadi_v1_persist_transition` / `kadi_v1_generate_document_number`).
3. **Alors seulement, fusionner** la PR backend dans `main` — puisque la
   fusion déclenche l'auto-déploiement Render, cette étape ne peut avoir
   lieu qu'après confirmation de l'étape 2, jamais avant ni en parallèle.
4. **Vérifier** le démarrage du service et qu'un document de test peut
   atteindre `GENERATION_IN_PROGRESS` sans erreur `KADI_V1_SERVER_FIELD_FORBIDDEN`
   ni `DOCUMENT_FINALIZATION_IDENTITY_MISSING`/`DOCUMENT_FINALIZATION_IDENTITY_CORRUPT`.
5. **Publier** la nouvelle version du Flow Meta `DOCUMENT_OPTIONS` (champ
   `tax_rate_percent`) — autorisation explicite requise, non effectuée par
   la mission qui a écrit ce correctif.
6. **Configurer** un nouvel identifiant/variable d'environnement Render
   uniquement si la publication en a effectivement créé un nouveau (pas
   nécessairement le cas pour une simple mise à jour de champ sur un Flow
   existant).
7. **Démarrer une session WhatsApp fraîche** pour la validation — jamais la
   reprise d'une session ouverte avant l'étape 3 ou 5 (voir fiche F de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md)).
8. **Exécuter la matrice CANARY** : FACTURE FINAL, FACTURE PROFORMA, DEVIS,
   RECU A4, RECU TICKET_80, DECHARGE (MONEY/GOODS/DOCUMENT/OTHER) — vérifier
   pour chacun : titre correct, numéro et date réels (jamais BROUILLON),
   options/taxe atteignables, calcul 18 % correct.
9. **Seulement ensuite** envisager un rollout plus large.

**Conséquences documentées si l'ordre n'est pas respecté :**

* PR backend fusionnée (donc déployée, auto-déploiement Render) **avant**
  l'étape 2 : la RPC `kadi_v1_persist_transition` actuellement en place
  rejette tout `issued_at` non nul hors de l'état `GENERATED` — **panne
  totale de la génération finale**, tous types de documents, tous
  utilisateurs, jusqu'à application de la migration.
* Ancien backend avec un Flow déjà republié (étape 5 avant étape 3) :
  sans risque grâce à la fenêtre de compatibilité double-champ — le champ
  `tax_rate_percent` du nouveau Flow serait néanmoins rejeté par l'ancien
  backend s'il n'accepte pas encore ce nom de champ ; respecter l'ordre
  ci-dessus évite la question.
* Session WhatsApp restée ouverte pendant la bascule : reste acceptée
  pendant la fenêtre de compatibilité (les deux noms de champ de taxe sont
  acceptés), mais doit néanmoins être revalidée par une session fraîche
  avant de conclure à une correction réelle.
* Migration non appliquée du tout : voir premier point — même conséquence,
  permanente tant que la migration n'est pas appliquée.

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
