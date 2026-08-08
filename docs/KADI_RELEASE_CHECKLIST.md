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

## Ordre — `fix/kadi-v1-delivery-retry-and-final-filenames-r0` (reprise de livraison et noms de fichiers finaux)

**Mise à jour (2026-08-07) : les deux migrations Supabase forward-only sont
désormais appliquées et vérifiées à distance** sur le projet
`cmhargmwkyskbobmkrcj`, sous autorisation explicite et séparée du
fondateur — voir la sous-section « Suite de revue finale » de la fiche R de
[`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le détail
complet, y compris la fenêtre d'application exacte :

* `supabase/migrations/20260806020000_add_kadi_v1_delivery_attempt_in_progress_status.sql`
  — **APPLIQUÉE**. Élargit la contrainte `status` de
  `kadi_v1_delivery_attempts` pour autoriser `'IN_PROGRESS'` (en plus des
  trois valeurs déjà acceptées, toutes préservées) ; sans elle, la capture
  atomique déjà écrite aurait échoué avec `check_violation` (23514) contre
  la vraie base Postgres.
* `supabase/migrations/20260806030000_add_kadi_v1_delivery_outcome_to_history_bundle.sql`
  — **APPLIQUÉE**. Expose `last_error_code` dans l'objet `delivery` du
  paquet historique (même signature de fonction, mêmes droits
  `service_role` uniquement, aucun autre champ modifié).

Chacune apparaît exactement une fois dans l'historique distant ; aucune
ligne d'aucune table applicative n'a changé du fait de ces migrations
(vérifié en lecture seule avant/après : mêmes compteurs par statut sur
`kadi_v1_delivery_attempts`). L'ancien backend (toujours celui déployé,
commit `ac01557b...`) reste compatible avec la base migrée : il n'écrit
jamais `'IN_PROGRESS'` et ne lit jamais `last_error_code`, donc la valeur
et le champ ajoutés sont de purs no-ops pour lui — l'élargissement de
contrainte et l'ajout de champ JSON sont additifs par construction. À
l'inverse, un nouveau backend déployé **avant** application de ces
migrations aurait échoué (`check_violation` sur toute capture, et une
classification d'issue dégradée en historique) — ce risque est maintenant
écarté puisque la base est déjà migrée.

1. **[FAIT]** Code écrit, revu, testé localement.
2. **[FAIT]** Revue adversariale indépendante de la PR — plusieurs passes
   effectuées dans le cadre de cette mission, y compris une revue finale
   dédiée à l'application des migrations.
3. **[FAIT]** Application des deux migrations ci-dessus à distance
   (2026-08-07T00:04:03Z–2026-08-07T00:04:40Z), vérifiée en lecture seule
   avant et après (contrainte, signature/corps de fonction, droits,
   compteurs de lignes).
4. **[EN ATTENTE]** Fusion dans `main`.
5. **[EN ATTENTE]** Déploiement manuel explicite sur Render (ce service
   n'auto-déploie pas — voir
   [`runbooks/DEPLOY_CANARY.md`](runbooks/DEPLOY_CANARY.md)) et vérification
   du commit `live` exact.
6. **[EN ATTENTE]** Vérification du démarrage et de l'absence d'erreur.
7. **[FAIT]** Une vraie reprise de livraison a été observée en conditions
   réelles après fusion et déploiement (commit `aacf7621...`) — **et a
   confirmé trois défauts de production distincts**, voir la fiche S de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) et la section
   suivante. Le document CANARY du fondateur
   (`FA-20260806190633-A0EAC605`) reste non récupéré.

## Ordre — `fix/kadi-v1-destination-lookup-and-history-r0` (fiabilité de la recherche de destination, résultats d'historique, navigation d'édition)

Aucune migration Supabase requise pour cette branche (aucun nouveau champ de
base de données, aucune contrainte modifiée) — code applicatif uniquement.

1. **[FAIT]** Code écrit, testé localement (suite complète verte,
   `git diff --check` propre).
2. **[FAIT]** Audit exploratoire produit/UX complet en lecture seule
   (`KADI_V1_FULL_EXPLORATORY_PRODUCT_AUDIT_COMPLETE`) : navigation
   d'édition reconfirmée entièrement corrigée par lecture directe du code ;
   trois nouveaux défauts confirmés et corrigés (REVIEW-001, INV-001,
   INV-002 — voir fiche T de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md)) ; un défaut
   distinct (CLIENT-001) découvert incidemment, hors périmètre à ce stade ;
   BILL-001 reste `PLAUSIBLE`/`NOT_REPRODUCED`, hors périmètre.
3. **[FAIT]** CLIENT-001 corrigé, même branche : `tax_id` (soumis par les
   deux Flows client réels) normalisé une seule fois vers le champ domaine
   canonique `ifu`, avec échec explicite sur conflit — voir fiche U de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md). Aucune
   mutation de Flow Meta requise. BILL-001 reste explicitement hors
   périmètre, `PLAUSIBLE`/`NOT_REPRODUCED`, non touché.
4. **[FAIT]** Revue finale de fusion (« merge-gate ») de l'intégralité de
   la PR #15, comparant `main@aacf76211552800054983c726a1211f22ed29aeb` à
   la tête de branche. Un balayage borné de cohérence Flow/backend a
   révélé et corrigé EDIT-CONTENT-001 (formulaire combiné d'édition
   d'articles rejeté pour trois de ses quatre actions réelles — rendu
   actif pour la première fois par le propre correctif INV-002 de cette
   PR) et un défaut d'intégration observateur/`emit()` distinct (filtrage
   de sécurité inopérant en conditions réelles, sans fuite effective) —
   voir fiche V de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md). Aucun autre
   défaut HIGH/MEDIUM trouvé sur le reste du balayage (recherche de
   destination, historique, écran de revue, parcours d'édition,
   observabilité restante, sécurité de rejeu/version obsolète,
   invariants de facturation).
5. **[FAIT]** Fusion dans `main` — commit de fusion
   `0335d3758f3dc1d4841fd5137c8273d03ee68843`.
6. **[FAIT]** Déploiement manuel explicite sur Render, commit vérifié
   exactement `0335d3758f3dc1d4841fd5137c8273d03ee68843` actif.
7. **[FAIT, résultat négatif]** Une vraie nouvelle tentative de reprise par
   le propriétaire sur `FA-20260807010715-1961CBCC` a échoué de nouveau
   avec `DELIVERY_DESTINATION_LOOKUP_FAILED` — cause racine identifiée
   (colonne physique inexistante, `PostgreSQL 42703`) et corrigée sur une
   branche dédiée, voir fiche W de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) et la
   nouvelle section ci-dessous. `FA-20260806190633-A0EAC605` reste non
   retenté.
8. **[EN ATTENTE]** Une vraie validation téléphone d'au moins un parcours
   de correction (« Modifier le client », « Modifier les articles »,
   « Modifier les options » depuis la revue, y compris la saisie d'un
   identifiant fiscal réel) — non encore réalisée.

## Ordre — `fix/kadi-v1-delivery-destination-schema-r0` (colonne physique inexistante dans la vérification de destination de livraison)

Aucune migration Supabase requise pour cette branche (correctif
entièrement applicatif — aucune colonne physique n'est ajoutée ou
renommée). Aucune mutation Meta requise.

1. **[FAIT]** Cause racine identifiée par reproduction directe en lecture
   seule contre la vraie base (jamais seulement par lecture de code) :
   `PostgreSQL 42703`, `kadi_v1_documents.options` n'existe pas.
2. **[FAIT]** Code écrit, testé localement (suite complète 1327/1327 verte,
   `git diff --check` propre). Voir fiche W de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le
   détail complet du correctif et de sa preuve.
3. **[FAIT]** Revue adversariale du diff — aucun défaut HIGH/MEDIUM trouvé
   (pas de nouvelle colonne physique devinée, distinction PROFORMA
   préservée, vérification propriétaire toujours avant tout contact Meta,
   pas de fuite inter-propriétaire, `42703` correctement classé permanent,
   aucun envoi Meta retenté, aucune facturation/rendu/artefact dupliqué).
4. **[EN ATTENTE]** Revue adversariale indépendante de la PR.
5. **[EN ATTENTE]** Fusion dans `main`.
6. **[EN ATTENTE]** Déploiement manuel explicite sur Render.
7. **[EN ATTENTE]** Une vraie nouvelle tentative de reprise par le
   propriétaire, sur `FA-20260806190633-A0EAC605` **et** sur
   `FA-20260807010715-1961CBCC`, observée en conditions réelles.

## Ordre — `fix/kadi-v1-options-contract-r0` (T1/OPTIONS-001 : contrat d'options FACTURE/DEVIS aligné sur la vraie forme combinée du Flow)

Aucune migration Supabase requise pour cette branche (correctif entièrement
applicatif). Aucune mutation Meta requise.

1. **[FAIT]** Audit final « FINAL ROADMAP GAP AUDIT R0 » : Kadi V1 non prêt
   pour un audit de release candidate, backlog T1–T16 produit ; T1 =
   `OPTIONS-001`, confirmé même classe de défaut que `CLIENT-001`/
   `EDIT-CONTENT-001`.
2. **[FAIT]** T1/OPTIONS-001 corrigé, sur une branche isolée dédiée depuis
   `main@d2fee1a1adbae59ce452411f2eb37fe8bcb5b298` : `normalizeOptions`
   (`kadiV1SharedDocumentPolicies.js`) élargi pour accepter la vraie forme
   combinée à sept champs des Flows `kadi_document_options_v1.json`/
   `kadi_edit_options_v1.json`, `validity_days` plat correctement mappé
   vers sa place canonique existante avec détection de conflit,
   `payment_method`/`reference` acceptés puis explicitement abandonnés pour
   FACTURE/DEVIS (aucune signification confirmée pour ces types). Défaut
   annexe (`discount_amount` blanc rejeté) corrigé dans le même correctif.
   `DECHARGE` confirmé hors périmètre par lecture du code, non-régression
   testée. T2 (`HISTORY-CONTRACT-001`) et T3 (`RECHARGE-CONTRACT-001`)
   **volontairement non traités** — voir fiche X de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md).
3. **[FAIT]** Tests ciblés (180/180 sur les fichiers concernés) puis suite
   complète (1341/1341), `git diff --check` propre.
4. **[FAIT]** Revue adversariale du diff — aucun défaut HIGH/MEDIUM trouvé.
5. **[FAIT]** Revue adversariale indépendante de la PR #17 — a signalé
   EDIT_OPTIONS-001 (MEDIUM/bloquant de fusion) : le vrai formulaire
   `EDIT_OPTIONS` ne pré-remplit jamais `notes`/`payment_terms`, donc une
   correction ne portant que sur la taxe pouvait silencieusement effacer
   une note ou une condition de paiement réelle déjà enregistrée. Corrigé
   sur la même branche : vide traité comme « non fourni » pour
   `notes`/`payment_terms`, même principe déjà appliqué à
   `discount_amount`/`validity_days` — voir fiche X.1 de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md). Tests ciblés
   (184/184) puis suite complète (1345/1345), `git diff --check` propre.
   Aucun autre défaut HIGH/MEDIUM trouvé sur le diff complet mis à jour.
6. **[FAIT]** Fusion de la PR #17 dans `main` — commit de fusion
   `7f09f624b60b58d2de56eedae086be69883f4dad`.
7. **[EN ATTENTE]** Déploiement manuel explicite sur Render.
8. **[EN ATTENTE]** Une vraie soumission FACTURE et DEVIS via le Flow
   `DOCUMENT_OPTIONS` réel, observée en conditions réelles (validation
   téléphone), y compris une validité DEVIS non vide et une correction
   `EDIT_OPTIONS` ne portant que sur la taxe préservant une note réelle.
9. **[EN ATTENTE]** `FLOW-PARITY-GATE` global (test structurel unique
   couvrant tous les Flows JSON de `flows/v1_draft/`) — à programmer dans
   le backlog suivant, pas construit dans cette mission.
10. **[EN ATTENTE]** Suivi produit non bloquant : mutation de Flow future
    pour retirer `payment_method`/`reference` de l'écran FACTURE/DEVIS
    (visuellement présents mais sans effet persistant) ; mécanisme séparé
    pour permettre l'effacement explicite d'une note existante — voir
    fiche X.1.

## Ordre — `fix/kadi-v1-history-contract-r0` (T2/HISTORY-CONTRACT-001 : contrat de recherche/ouverture d'historique aligné sur la vraie forme combinée du Flow)

Aucune migration Supabase requise pour cette branche (correctif entièrement
applicatif). Aucune mutation Meta requise.

1. **[FAIT]** Baseline confirmée exactement à
   `main@7f09f624b60b58d2de56eedae086be69883f4dad` (PR #17 fusionnée) avant
   de créer la branche isolée.
2. **[FAIT]** T2/HISTORY-CONTRACT-001 reproduit puis corrigé : le vrai Flow
   combiné `kadi_history_search_v1.json` soumet toujours `query`/
   `document_type`/`date_from`/`date_to`/`document_id` ensemble, quelle que
   soit l'action (`SEARCH`/`OPEN_DOCUMENT`) — aucune recherche ni ouverture
   de document depuis l'historique ne pouvait jamais réussir via le vrai
   Flow Meta. Deux défauts annexes de la même chaîne, jusque-là masqués par
   le premier, corrigés dans le même correctif : le texte de recherche réel
   (`query`) jamais transmis au filtre (mauvais chemin vérifié dans
   l'adaptateur) ; `date_from`/`date_to` (noms du Flow) jamais traduits vers
   `from`/`to` (noms canoniques du service), rejetés avec
   `HISTORY_FILTER_UNKNOWN`. Le constat terrain du fondateur (recherche
   réussie puis échec générique à l'ouverture) est expliqué de bout en bout
   et reproduit avant correctif — voir fiche Y de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md). T3
   (`RECHARGE-CONTRACT-001`) **volontairement non traité**.
3. **[FAIT]** Tests ciblés (238/238 sur les fichiers concernés) puis suite
   complète (1361/1361), `git diff --check` propre.
4. **[FAIT]** Revue adversariale du diff — aucun défaut HIGH/MEDIUM trouvé
   (passe de simplification appliquée : code défensif non exercé par aucun
   appelant réel retiré de l'adaptateur d'historique).
5. **[FAIT]** Revue adversariale indépendante de la PR #18 — a signalé une
   suite au défaut HISTORY-CONTRACT-001 (MEDIUM/bloquant de fusion) :
   `date_to` transmis tel quel, une date calendaire brute (`"2026-04-01"`)
   analysée comme minuit exact par les deux dépôts d'historique (mémoire et
   RPC Supabase, vérifiée en lecture seule) — une recherche « Au : 1er
   avril » excluait silencieusement tout document mis à jour plus tard ce
   jour-là. Corrigé sur la même branche : `kadiV1HistoryService.js`'s
   `normalizeFilters` étend désormais une valeur `to` au format
   `YYYY-MM-DD` jusqu'à la fin de cette journée calendaire, seule frontière
   de normalisation traversée par les deux dépôts ; fuseau Burkina Faso
   (UTC+0 fixe) déjà documenté ailleurs, aucune politique inventée ; un
   horodatage ISO complet explicite reste intégralement préservé. Aucune
   mutation ni migration Supabase — voir fiche Y.1 de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md). Tests
   ciblés (115/115 sur les fichiers concernés) puis suite complète
   (1367/1367), `git diff --check` propre. Aucun autre défaut HIGH/MEDIUM
   trouvé sur le diff complet mis à jour.
6. **[FAIT]** Fusion de la PR #18 dans `main` — commit de fusion
   `07ea815ce016ac4a034498e436db391486b420ff`. **T2 est donc `CLOSED`/`MERGED`.**
7. **[EN ATTENTE]** Déploiement manuel explicite sur Render.
8. **[EN ATTENTE]** Une vraie recherche et ouverture de document depuis
   l'historique via le Flow `HISTORY_SEARCH` réel, observée en conditions
   réelles (validation téléphone), y compris un filtrage par date incluant
   réellement le jour de fin, et le parcours de reprise de livraison déjà
   construit (fiche R) toujours atteignable depuis un document ouvert.
9. **[FAIT]** T3 (`RECHARGE-CONTRACT-001`) — corrigé, voir section dédiée
   ci-dessous.
10. **[EN ATTENTE]** `FLOW-PARITY-GATE` global — toujours un suivi de
    backlog distinct, non construit dans cette mission.

## Ordre — `fix/kadi-v1-recharge-contract-r0` (T3/RECHARGE-CONTRACT-001 : contrat de sélection de pack/vérification de paiement/annulation aligné sur la vraie forme combinée du Flow)

Aucune migration Supabase requise pour cette branche (correctif entièrement
applicatif). Aucune mutation Meta requise. Aucun appel réseau réel vers
Orange Money ou tout autre fournisseur de paiement.

1. **[FAIT]** Baseline confirmée exactement à
   `main@07ea815ce016ac4a034498e436db391486b420ff` (PR #18 fusionnée) avant
   de créer la branche isolée.
2. **[FAIT]** T3/RECHARGE-CONTRACT-001 reproduit puis corrigé : le vrai
   Flow combiné `kadi_recharge_v1.json` soumet toujours `pack_id`/
   `payment_reference` ensemble, quelle que soit l'action
   (`SELECT_PACK`/`CHECK_PAYMENT`/`CANCEL`) — aucune sélection de pack,
   vérification de paiement ni annulation ne pouvait jamais réussir via
   le vrai Flow Meta. `CANCEL` étant une action partagée globalement avec
   `DOCUMENT_REVIEW`/`DOCUMENT_PREVIEW`/`GENERATION_CONFIRMATION`, une
   nouvelle table flow-aware (`FLOW_ACTION_FIELD_OVERRIDES`) accepte
   `pack_id`/`payment_reference` uniquement pour `RECHARGE`/`CANCEL`,
   sans fuite vers les autres Flows (testé explicitement). Traçage
   complet de la chaîne : aucun défaut de second niveau trouvé — voir
   fiche Z de [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md).
   Défaut de la même classe confirmé pour
   `GENERATION_CONFIRMATION`/`CANCEL`, délibérément **non corrigé**,
   consigné pour T4.
3. **[FAIT]** Tests ciblés (226/226 sur les fichiers concernés) puis
   suite complète (1387/1387), `git diff --check` propre.
4. **[FAIT]** Revue adversariale du diff — aucun défaut HIGH/MEDIUM
   trouvé.
5. **[FAIT]** Revue adversariale indépendante de la PR #19 — a signalé un
   défaut HIGH/P0, bloquant de fusion : `handle()` exécutait toujours la
   commande métier même après qu'un rejeu exact ait été identifié comme
   doublon par la couche session, et `RECHARGE`/`CANCEL` n'avait aucune
   clé d'idempotence propre, résolvant toujours « la recharge active la
   plus récente », sans borne. Deux scénarios concrets prouvés dans la
   composition de production : rejeu différé d'un `CANCEL` déjà consommé
   annulant une recharge plus récente et différente ; Flow `RECHARGE`
   obsolète jamais soumis annulant une recharge créée après son ouverture.
   Corrigé sur la même branche : `sessionOpenedAt` (instant serveur de
   confiance d'ouverture de la session Flow exacte, jamais fourni par le
   client) borne désormais l'éligibilité de `cancel()` — aucune nouvelle
   colonne Supabase, `opened_at`/`created_at` existaient déjà toutes les
   deux. Raccourci générique de doublon dans `handle()` envisagé puis
   délibérément écarté (preuve exhaustive d'innocuité non établie) — voir
   fiche Z.1 de [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md).
   Incohérence de libellé « Revenir plus tard » vs état terminal
   `CANCELLED` signalée, non tranchée. Tests ciblés (240/240 sur les
   fichiers concernés) puis suite complète (1393/1393), `git diff --check`
   propre. Aucun autre défaut HIGH/MEDIUM trouvé sur le diff complet mis à
   jour.
6. **[FAIT]** Nouvelle revue adversariale indépendante de la PR #19 — a
   signalé un second défaut HIGH/P0, bloquant de fusion : `sessionOpenedAt`
   seul n'empêchait pas un rejeu exact de `CANCEL` d'annuler une seconde
   recharge active différente quand **plusieurs** recharges actives
   préexistaient à l'ouverture de la session Flow (aucune contrainte
   n'impose une seule recharge active par propriétaire). Prouvé
   concrètement : A et B actives avant l'ouverture de la session Flow,
   premier `CANCEL` annule B, rejeu exact du même message annulait A à
   tort. Corrigé sur la même branche : court-circuit strictement limité à
   `(RECHARGE, CANCEL)` dans `kadiV1FlowReplyRuntime.js`'s `handle()` —
   sur un doublon exact pour cette paire précise, `commands.execute` n'est
   plus jamais rappelé, en s'appuyant sur le même état de session persisté
   (jamais un indicateur en mémoire, valide après redémarrage — prouvé
   explicitement) déjà utilisé ailleurs. Compromis assumé : un `CANCEL`
   réellement échoué ne peut plus être repris par simple rejeu de webhook
   — voir fiche Z.2 de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md). Aucune
   autre action ni Flow affecté (prouvé explicitement pour
   `DOCUMENT_REVIEW`/`DOCUMENT_PREVIEW`/`GENERATION_CONFIRMATION`). Tests
   ciblés (248/248) puis suite complète (1399/1399), `git diff --check`
   propre. Aucun autre défaut HIGH/MEDIUM trouvé sur le diff complet R0 +
   R1 + R2.
7. **[FAIT]** Troisième revue adversariale indépendante de la PR #19 — a
   signalé un troisième défaut HIGH/P0, bloquant de fusion : la requête de
   ciblage de R1 filtrait le statut **avant** de choisir la recharge
   contextuellement la plus récente — si cette recharge changeait d'état
   (créditée, annulée ailleurs) avant que `CANCEL` ne soit soumis, la
   requête glissait silencieusement vers une recharge plus ancienne encore
   éligible au filtre de statut, l'annulant à tort même sur une
   soumission réellement première. Prouvé concrètement : B créditée via un
   vrai `CHECK_PAYMENT`, puis A (plus ancienne) annulée à tort par le
   `CANCEL` suivant. Corrigé sur la même branche : la session
   contextuelle la plus récente est résolue d'abord (bornée par
   `sessionOpenedAt`, sans filtre de statut), son éligibilité vérifiée
   ensuite séparément, échec fermé immédiat sans jamais rechercher une
   autre recharge plus ancienne — ensemble de statuts annulables
   intentionnellement inchangé, sans extension à `FAILED` — voir fiche
   Z.3 de [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md).
   Tests ciblés (251/251) puis suite complète (1402/1402), `git diff --check`
   propre. Aucun autre défaut HIGH/MEDIUM trouvé sur le diff complet R0 +
   R1 + R2 + R3.
8. **[FAIT]** Nouvelle revue adversariale indépendante de la PR #19 mise à
   jour (post-résolution-contextuelle R3) — aucun défaut HIGH/MEDIUM
   supplémentaire signalé.
9. **[FAIT]** PR #19 fusionnée dans `main` (`main@71362c71a5524d1c24192f584ca3cb7f3fe20785`).
   **T3/RECHARGE-CONTRACT-001 : CLOSED/MERGED.**
10. **[EN ATTENTE]** Déploiement manuel explicite sur Render.
11. **[EN ATTENTE]** Une vraie sélection de pack, vérification de paiement
    et annulation via le Flow `RECHARGE` réel, observée en conditions
    réelles (validation téléphone).
12. **[FAIT]** T4 (`GENERATION_CONFIRMATION`/`CANCEL`) — corrigé sur la
    branche dédiée `fix/kadi-v1-generation-confirmation-cancel-t4`, PR
    brouillon ouverte, non fusionnée. Voir la section « Ordre —
    `fix/kadi-v1-generation-confirmation-cancel-t4` » ci-dessous et fiche
    AA de [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md).
13. **[EN ATTENTE]** `FLOW-PARITY-GATE` global — toujours un suivi de
    backlog distinct, non construit dans cette mission.
14. **[EN ATTENTE]** `RECHARGE-EXACTLY-ONCE-GATE` dédié — durcissement
    financier exactement-une-fois de bout en bout, tâche séparée future.
15. **[EN ATTENTE]** Décision produit requise sur la sémantique de
    « Revenir plus tard » (libellé vs état terminal `CANCELLED`) et sur
    l'exposition éventuelle de `FAILED` comme statut annulable.
16. **[EN ATTENTE]** Suivi produit non bloquant : tarification 200
    FCFA/crédit (hors périmètre, packs `legacy-v1` inchangés) ; UX du
    présentateur `RECHARGE` (le Flow rouvert après `SELECT_PACK` ne
    repeuple pas `pack_options`/`balance_summary`) — voir fiche Z.

## Ordre — `fix/kadi-v1-generation-confirmation-cancel-t4` (T4/GENERATION_CONFIRMATION-001 : contrat d'annulation de confirmation de génération aligné sur la vraie forme combinée du Flow)

Aucune migration Supabase requise pour cette branche (correctif entièrement
applicatif, un seul fichier de production modifié). Aucune mutation Meta
requise. Aucune génération, livraison ou opération de crédit réelle.

1. **[FAIT]** Baseline confirmée exactement à
   `main@71362c71a5524d1c24192f584ca3cb7f3fe20785` (PR #19 fusionnée) avant
   de créer la branche isolée.
2. **[FAIT]** GENERATION_CONFIRMATION-001 reproduit puis corrigé : le vrai
   Flow combiné `kadi_generation_confirmation_v1.json` soumet toujours
   `quote_id`, quelle que soit l'action (`CONFIRM_GENERATION`/`CANCEL`) —
   une vraie annulation depuis `AWAITING_GENERATION_CONFIRMATION` ne
   pouvait jamais réussir via le vrai Flow Meta
   (`KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN`), même défaut de classe que
   RECHARGE-CONTRACT-001 (T3). Corrigé par le même mécanisme flow-aware
   (`FLOW_ACTION_FIELD_OVERRIDES`) : `quote_id` accepté uniquement pour
   `GENERATION_CONFIRMATION`/`CANCEL`, sans fuite vers
   `DOCUMENT_REVIEW`/`DOCUMENT_PREVIEW`/`RECHARGE` (testé explicitement).
   `quote_id` n'est et ne devient jamais une autorité de ciblage :
   `kadiV1FlowCommandRuntime.js` route déjà `GENERATION_CONFIRMATION`/
   `CANCEL` par sa branche générique vers
   `documentRuntime.cancel(documentBase)`, qui ne lit jamais
   `command.data` — seul le contexte document de session serveur
   (`document_id`/`document_version`/`document_type`/`document_state`)
   détermine le document affecté ; ce modèle était déjà correct avant T4
   et n'a pas été modifié. Traçage complet de la chaîne (Flow JSON →
   `FlowReplyRuntime` → session → `FlowCommandRuntime` →
   `documentRuntime.cancel` → pipeline partagé/décharge → dépôt/version →
   présentateur) : aucun défaut de second niveau masqué trouvé — l'annulation
   idempotente existait déjà via le pipeline document partagé (aucun
   court-circuit spécifique RECHARGE copié, conformément à la mission).
   Constat confirmé et documenté : les transitions d'état pures
   (`CANCEL` inclus) ne font jamais avancer `document.version` dans
   `kadiV1DocumentDomain.js` — seules les mutations de contenu
   (`modifyDocument`) le font — donc le risque réel pour un Flow
   `GENERATION_CONFIRMATION`/`CANCEL` obsolète est une course d'état, pas
   une course de version ; le même mécanisme serveur (vérification
   `fromState` + table `TRANSITIONS`, jamais un champ contrôlé par le
   client) échoue fermé de façon identique. Voir fiche AA de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md).
3. **[FAIT]** Tests ciblés (287/287 sur les fichiers concernés) puis suite
   complète (1418/1418), `git diff --check` propre.
4. **[FAIT]** Revue adversariale du diff complet — aucun défaut HIGH/MEDIUM
   trouvé.
5. **[FAIT]** Revue adversariale indépendante de la PR #20 — a signalé un
   défaut HIGH/P0, bloquant de fusion : `documentBase.documentState` était
   déjà porté par `FlowCommandRuntime` mais jamais lu par
   `createKadiV1DocumentRuntimeAdapter.cancel()` ; comme les transitions
   d'état pures ne font jamais avancer `document.version`, un Flow
   `GENERATION_CONFIRMATION` obsolète pouvait encore annuler à tort un
   document ayant légitimement basculé vers `RECHARGE_REQUIRED` ou
   `GENERATION_IN_PROGRESS` depuis l'ouverture de sa session (la machine
   d'état autorise `CANCEL` depuis ces deux états). **Prouvé
   concrètement dans la composition de production avant correctif**,
   avec la pile réelle de génération (réservation/rendu réel/capture/
   livraison) : course RECHARGE_REQUIRED reproduite, et course
   GENERATION_IN_PROGRESS reproduite pendant que la génération était
   réellement en vol (barrière déterministe sur le rendu réel, jamais un
   `sleep`) — même défaut confirmé sur la pipeline DECHARGE. **Corrigé**
   sur la même branche : `command.expectedState` (optionnel, réservé à
   `GENERATION_CONFIRMATION`/`CANCEL`) participe au même contrat de
   mutation durable que l'annulation elle-même (vérifié contre le statut
   déjà lu par `loadMutation`, jamais une lecture séparée), avec le
   contrôle atomique déjà existant de `storage.persistTransition`
   (`row.status === fromState`) comme filet final contre toute course
   réelle. Aucune fonctionnalité générique de `CANCEL` affaiblie pour les
   autres Flows. Voir fiche AA.1 de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md).
6. **[FAIT]** Tests ciblés (378/378 sur les fichiers concernés) puis suite
   complète (1430/1430), `git diff --check` propre.
7. **[FAIT]** Revue adversariale du diff complet R0 + R1 — aucun défaut
   HIGH/MEDIUM trouvé.
8. **[FAIT]** Nouvelle revue adversariale indépendante de la PR #20 mise à
   jour (post-correctif R1) — a signalé le défaut HIGH/P0 corrigé en T4.5
   (voir la section « Ordre —
   `fix/kadi-v1-document-cancel-state-authority-t4-5` » ci-dessous),
   distinct du périmètre GENERATION_CONFIRMATION déjà fermé ici.
9. **[FAIT]** PR #20 fusionnée dans `main`
   (`main@a2c2ead17e109c2de5c46905c291f5133cc817ab`).
   **T4/GENERATION_CONFIRMATION-001 : CLOSED/MERGED.**
10. **[EN ATTENTE]** Déploiement manuel explicite sur Render.
11. **[EN ATTENTE]** Une vraie confirmation de génération et une vraie
    annulation via le Flow `GENERATION_CONFIRMATION` réel, observées en
    conditions réelles (validation téléphone).
12. **[FAIT]** T4.5 (`DOCUMENT_REVIEW`/`CANCEL` et `DOCUMENT_PREVIEW`/
    `CANCEL` — même classe de défaut d'autorité d'état) — corrigé sur la
    branche dédiée `fix/kadi-v1-document-cancel-state-authority-t4-5`, PR
    brouillon ouverte, non fusionnée. Voir la section « Ordre —
    `fix/kadi-v1-document-cancel-state-authority-t4-5` » ci-dessous et
    fiche AA.2 de [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md).
13. **[FAIT]** T5/RECHARGE_PRESENTER_001 — voir la section
    `fix/kadi-v1-recharge-presenter-t5` plus bas.

## Ordre — `fix/kadi-v1-document-cancel-state-authority-t4-5` (T4.5/DOCUMENT_CANCEL_STATE_AUTHORITY_GATE : même défaut d'autorité d'état de session obsolète, pour `DOCUMENT_REVIEW`/`CANCEL` et `DOCUMENT_PREVIEW`/`CANCEL`)

Aucune migration Supabase requise (correctif entièrement applicatif, un
seul fichier de production modifié — la RPC Supabase existante
`p_from_state` couvre déjà le besoin). Aucune mutation Meta requise.
Aucune génération, livraison ou opération de crédit réelle.

1. **[FAIT]** Baseline confirmée exactement à
   `main@a2c2ead17e109c2de5c46905c291f5133cc817ab` (PR #20/T4 fusionnée)
   avant de créer la branche isolée.
2. **[FAIT]** Défaut reproduit puis corrigé : `DOCUMENT_REVIEW`/`CANCEL`
   et `DOCUMENT_PREVIEW`/`CANCEL` routaient tous deux par la branche
   générique de document, qui ne transmettait jamais `expectedState` —
   exactement le même défaut que celui fermé en T4 pour
   `GENERATION_CONFIRMATION`/`CANCEL`. Une session Flow obsolète (jamais
   révoquée automatiquement à l'ouverture d'une nouvelle session — confirmé
   par inspection de `kadiV1ConversationSession.js`, `revoke()` n'a aucun
   appelant en production) pouvait donc encore annuler à tort un document
   ayant légitimement changé de phase métier depuis l'ouverture de cette
   session, car les transitions d'état pures ne font jamais avancer
   `document.version`. **Prouvé concrètement dans la composition de
   production avant correctif** (huit scénarios distincts, `git stash` du
   correctif puis restauration) : `DOCUMENT_REVIEW` obsolète annulant à
   tort un document passé à `VERIFIED` ou à
   `AWAITING_GENERATION_CONFIRMATION` ; `DOCUMENT_PREVIEW` obsolète
   annulant à tort un document passé à `AWAITING_GENERATION_CONFIRMATION`,
   `RECHARGE_REQUIRED`, ou en cours de génération réelle
   (`GENERATION_IN_PROGRESS`, barrière déterministe sur le renderer réel,
   jamais un `sleep`) ; même défaut confirmé sur la pipeline `DECHARGE`
   pour les deux Flows. **Corrigé** en réutilisant sans le modifier le
   primitif `expectedState` déjà introduit en T4 : les états légitimes de
   chaque Flow sont tracés directement depuis le routage de production
   (`kadiV1ProductionPresenter.js`'s `routeDocument` et
   `kadiV1ConversationOrchestrator.js`'s `routeForDocument`, qui
   s'accordent) — `DOCUMENT_REVIEW` n'a qu'un seul état légitime
   (`READY_FOR_REVIEW`), `DOCUMENT_PREVIEW` en a deux (`VERIFIED` et
   `PREVIEW_READY`, un état de repos réel et durable confirmé par
   inspection de `kadiV1PreviewService.js`). Un seul fichier de production
   modifié (`kadiV1FlowCommandRuntime.js`, ajout additif) —
   `kadiV1RuntimeAdapters.js`, `kadiV1SharedDocumentPipeline.js` et
   `kadiV1DischargePipeline.js` étaient déjà suffisamment génériques et
   n'ont nécessité aucune modification. Voir fiche AA.2 de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md).
3. **[FAIT]** Tests ciblés (405/405 sur les fichiers concernés) puis suite
   complète (1457/1457), `git diff --check` propre.
4. **[FAIT]** Revue adversariale du diff complet — aucun défaut HIGH/MEDIUM
   trouvé.
5. **[FAIT]** Revue adversariale indépendante de la PR #21 — aucun défaut
   HIGH/MEDIUM supplémentaire signalé.
6. **[FAIT]** PR #21 fusionnée dans `main`
   (`main@1b605ebd34e0fe259f221a60f8b697038f13e9ef`).
   **T4.5/DOCUMENT_CANCEL_STATE_AUTHORITY_GATE : CLOSED/MERGED.**
7. **[EN ATTENTE]** Déploiement manuel explicite sur Render.
8. **[EN ATTENTE]** Une vraie annulation `DOCUMENT_REVIEW` et
   `DOCUMENT_PREVIEW` obsolète, observée en conditions réelles (validation
   téléphone) — un scénario de course réelle sur téléphone reste
   difficilement observable, la preuve de composition reste la preuve
   principale.
9. **[FAIT]** T5/RECHARGE_PRESENTER_001 — voir la section « Ordre —
   `fix/kadi-v1-recharge-presenter-t5` » plus bas. (T6/BALANCE-001 a été
   traité en parallèle, hors ordre T5 — voir la section « Ordre —
   `fix/kadi-v1-available-balance-t6` » ci-dessous.)

## Ordre — `fix/kadi-v1-available-balance-t6` (T6/BALANCE-001 : solde numérique + autorité des crédits disponibles, BILL-001 confirmé)

Migration SQL forward-only requise (voir ci-dessous) — remplace le corps
de la fonction existante `kadi_v1_get_wallet_balance` en place (même nom,
même signature), jamais la migration d'origine. **Aucune migration
appliquée à Supabase de production dans cette mission.** Aucune mutation
Meta/Render/WhatsApp requise.

1. **[FAIT]** Baseline confirmée exactement à
   `main@1b605ebd34e0fe259f221a60f8b697038f13e9ef` (PR #21 fusionnée) avant
   de créer la branche isolée.
2. **[FAIT]** Défaut A (présentation) reproduit puis corrigé : la
   composition de production confirmait que `ProductionPresenter` retombait
   toujours sur le texte statique « Votre solde a été consulté. » même
   quand le solde numérique réel était disponible — **prouvé concrètement
   avant correctif** (`git stash` du correctif puis restauration, 11/17
   scénarios E2E échouant exactement comme prévu). **Corrigé** :
   `canonicalReplyText` a désormais une branche `BALANCE` dynamique,
   déléguant à un formateur partagé (`kadiV1BalancePresentation.js`),
   utilisé identiquement par `kadiV1ConversationOrchestrator.js`.
3. **[FAIT]** Défaut B (BILL-001) confirmé : `kadi_v1_get_wallet_balance`
   retournait `kadi_wallets.balance` brut, ignorant les retenues de crédit
   vivantes (`kadi_v1_wallet_reservations` avec `status = 'RESERVED'`) que
   `kadi_v1_reserve_generation_credits` utilise déjà pour déterminer la
   solvabilité réelle. Un solde brut de 10 avec 3 crédits retenus aurait pu
   afficher « 10 crédits » alors que seuls 7 sont réellement engageables —
   confirmé financièrement trompeur. **Corrigé** : une nouvelle migration
   forward-only remplace le corps de `kadi_v1_get_wallet_balance` (même
   nom, même signature) pour calculer `total_credits`/`reserved_credits`/
   `available_credits` en une seule fonction atomique, avec un verrou
   `for share` sur la ligne du portefeuille pour rester cohérent face à une
   réservation/capture concurrente — jamais deux lectures applicatives
   séparées. `balance` préservé pour compatibilité ascendante :
   `kadiV1RechargeService.js`'s `resumePendingGeneration`, l'unique
   appelant existant du nombre brut, reste totalement inchangé
   (`getBalance()` intact) ; une nouvelle méthode additive
   `getAvailableBalance()` porte la nouvelle sémantique.
4. **[FAIT]** Modèle d'autorité tracé de bout en bout : RPC → dépôt
   Supabase/en mémoire → `BalanceReader` → `WalletRuntimeAdapter` (le port
   partagé entre `FlowCommandRuntime` et `ConversationOrchestrator`) →
   présentateur / orchestrateur — un seul calcul financier, jamais deux
   indépendants. Chaque couche revalide l'invariant
   `total_credits - reserved_credits === available_credits` et échoue
   fermé (jamais de solde négatif ou deviné) en cas d'état financier
   impossible.
5. **[FAIT]** Tests ciblés (317/317 sur les fichiers concernés) puis suite
   complète (1498/1498), `git diff --check` propre.
6. **[FAIT]** Revue adversariale du diff complet — aucun défaut HIGH/MEDIUM
   trouvé.
7. **[FAIT]** Revue adversariale indépendante de la PR #22 — le code R0
   confirmé correct (modèle d'autorité, `balance` legacy préservé,
   `getAvailableBalance()` additif, formateur partagé, échec fermé sur
   instantané malformé) ; **un défaut MEDIUM signalé sur l'ordre de
   déploiement décrit ci-dessous (items 9-11)**, corrigé en R1
   (documentation uniquement, aucun code de production/test/SQL modifié).
   Voir fiche AA.3 de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md).
8. **[EN ATTENTE]** Fusion dans `main`.
9. **[EN ATTENTE]** **Ordre de déploiement obligatoire — la migration
   d'abord, jamais Render d'abord :**
   1. Appliquer **d'abord** la migration Supabase
      `20260807_add_kadi_v1_available_wallet_balance.sql` (elle remplace
      `kadi_v1_get_wallet_balance` en place et préserve le champ `balance`
      existant — rétrocompatible avec le code Render actuellement
      déployé, qui ne lit encore que ce champ).
   2. Vérifier en lecture seule, avant tout déploiement Render, que la
      RPC expose désormais : `balance` (toujours présent), `total_credits`,
      `reserved_credits`, `available_credits`, l'invariant
      `total_credits - reserved_credits = available_credits`, et que les
      privilèges restent strictement `service_role`.
   3. Garder l'ancien code Render en production pendant cette
      vérification — le champ `balance` legacy continue de fonctionner
      sans changement.
   4. **Seulement après** succès de la vérification de la migration :
      déployer le nouveau commit `main` sur Render.
   5. Vérifier `/health`.
   6. Effectuer des tests `BALANCE` contrôlés en conditions réelles (voir
      item 10 ci-dessous).
   Si l'application ou la vérification de la migration échoue : **ne pas
   déployer le nouveau code Render** — le nouveau code exige
   `total_credits`/`reserved_credits`/`available_credits` et échouerait
   fermé (`BALANCE` indisponible) tant que la migration n'est pas
   appliquée avec succès. Hors périmètre de cette mission — aucune
   migration ni déploiement exécuté ici.
10. **[EN ATTENTE]** Une vraie consultation de solde ("Mon solde" et
    "Quel est mon solde ?"), observée en conditions réelles (validation
    téléphone) après l'ordre de déploiement ci-dessus, avec si possible
    un cas où des crédits sont réellement retenus par une génération en
    cours.
11. **[FAIT]** T5/RECHARGE_PRESENTER_001 — voir section dédiée
    ci-dessous.
12. **[EN ATTENTE]** Suivi backlog séparé, non corrigé dans T6 —
    `RECHARGE_RESUME_AVAILABLE_BALANCE_001` (MEDIUM/P1 avant RC) : voir
    fiche AA.3 pour le détail complet.

## Ordre — `fix/kadi-v1-recharge-presenter-t5` (T5/RECHARGE_PRESENTER_001 : le Flow RECHARGE authoritative — solde, packs, libellé CANCEL)

Aucune migration Supabase touchée par T5. Aucune mutation Meta/Render/
WhatsApp requise. T5 hérite de l'ordre de déploiement T6 ci-dessus pour
tout déploiement futur (le `balanceReader` de T5 dépend du même
`BalanceReader`/`getAvailableBalance()` que T6 — la migration T6 doit
donc être appliquée, dans l'ordre sûr décrit ci-dessus, avant tout
déploiement Render incluant T5).

1. **[FAIT]** Baseline confirmée exactement à
   `main@87b95bfa41ec40d6e0da5a7a53b25f9ecc2563f2` (PR #22/T6 fusionnée)
   avant de créer la branche isolée.
2. **[FAIT]** Défaut confirmé et reproduit avant correctif
   (`git stash` du correctif puis restauration) : le Flow RECHARGE réel
   affichait systématiquement les valeurs `__example__` du JSON (solde
   « Solde actuel : 0 crédit. », packs PACK_1000/2000/5000 d'exemple),
   jamais le solde disponible réel ni le catalogue de packs actif réel,
   car `suggestedDataForFlow()` n'avait aucune branche `RECHARGE`.
3. **[FAIT]** Corrigé : `balanceReader`/`packCatalog` optionnels et
   étroits injectés dans le presenter — les mêmes instances déjà câblées
   dans `walletRuntime`/`RechargeService`, jamais un second calcul
   financier ni une seconde liste de packs. Échec fermé systématique
   (jamais de zéro fabriqué, jamais les exemples du JSON présentés comme
   réels).
4. **[FAIT]** Libellé CANCEL corrigé (« Annuler cette recharge » au lieu
   de « Revenir plus tard »), avec copie de confirmation dédiée
   déterminée par le `flow_key` vérifié côté serveur — les autres CANCEL
   inchangés.
5. **[FAIT]** T3 R1/R2/R3 (intégrité d'annulation), contrat combiné
   `pack_id`/`payment_reference`, comportement `SELECT_PACK`/
   `CHECK_PAYMENT` existants tous confirmés inchangés par la suite
   complète.
6. **[FAIT]** Tests ciblés (242/242 sur les fichiers concernés) puis
   suite complète (1520/1520), `git diff --check` propre.
7. **[FAIT]** Revue adversariale du diff complet — aucun défaut
   HIGH/MEDIUM trouvé.
8. **[EN ATTENTE]** Fusion dans `main`.
9. **[EN ATTENTE]** Déploiement Render — soumis à l'ordre de déploiement
   T6 ci-dessus (migration Supabase T6 d'abord, vérification en lecture
   seule, puis seulement ensuite Render) si T6 n'a pas déjà été déployée.
10. **[EN ATTENTE]** Une vraie ouverture du Flow RECHARGE, observée en
    conditions réelles (validation téléphone) après déploiement, incluant
    si possible un cas à crédits réellement retenus et un cas
    d'annulation.
11. **[FAIT — R1]** Le constat « `CONFIRM_GENERATION`/`INSUFFICIENT_CREDITS`
    n'ouvrait jamais RECHARGE » a été reclassé MEDIUM/P1 et corrigé dans
    T5 R1 (voir ci-dessous) — n'est plus un suivi séparé.
12. **[EN ATTENTE]** Suivi backlog séparé, non corrigé — voir item 12 de
    la section T6 ci-dessus, `RECHARGE_RESUME_AVAILABLE_BALANCE_001`.

### R1 — revue adversariale indépendante de la PR #23 : CANCEL non lié (HIGH), recharge non ouverte sur crédits insuffisants (MEDIUM), devise de pack (LOW)

* **Statut R1 : `IMPLEMENTED_NOT_MERGED`** — même branche, même PR #23,
  aucune migration touchée. **Origine :** mission « KADI V1 — T5
  RECHARGE PRESENTER / UX INDEPENDENT REVIEW FIX R1 ».
13. **[FAIT]** HIGH/P0 reproduit puis corrigé avant correctif
    (`git stash` des 4 fichiers de production R1 puis restauration) :
    `recharge_actions` offrait CANCEL même pour un document B fraîchement
    `RECHARGE_REQUIRED` n'ayant jamais appelé SELECT_PACK — `cancel()`
    résolvant sa cible par propriétaire + `sessionOpenedAt` seuls (jamais
    par document), un CANCEL depuis cet écran non lié pouvait annuler une
    recharge A plus ancienne et complètement étrangère du même
    propriétaire. **Corrigé**, deux couches : (a) présentation — CANCEL
    n'est offert que lorsqu'une vraie session de recharge est bound à cet
    écran précis (après SELECT_PACK/CHECK_PAYMENT) ; (b) défense en
    profondeur côté serveur (`kadiV1FlowCommandRuntime.js`) — rejette tout
    CANCEL dont le `documentContext` de session fiable montre
    `RECHARGE_REQUIRED`, avant même d'appeler `cancel()`. T3 R1/R2/R3
    confirmés inchangés.
14. **[FAIT]** MEDIUM/P1 confirmé et corrigé : `INSUFFICIENT_CREDITS`
    n'ouvrait jamais le Flow RECHARGE, seulement un texte générique de
    récupération, malgré une transition `RECHARGE_REQUIRED` déjà
    persistée avec succès. **Corrigé** à la frontière Flow/runtime
    (`kadiV1RuntimeAdapters.js`'s adaptateur de génération — le service de
    génération lui-même, et ses autres appelants comme
    `resumePendingGeneration`, restent complètement inchangés) : relit le
    document après l'échec, et route immédiatement vers RECHARGE
    uniquement si son statut actuel est authentiquement
    `RECHARGE_REQUIRED`, avec une copie truthful. Rejeu exact confirmé sûr
    (zéro deuxième mutation, marqué duplicate).
15. **[FAIT]** LOW corrigé : l'étiquette de pack codait en dur « FCFA »
    quelle que soit `pack.currency` — corrigé (XOF reste « FCFA », toute
    autre devise validée s'affiche avec son propre code). Aucune valeur de
    pack actuelle modifiée.
16. **[FAIT]** Tests ciblés (379/379) puis suite complète (1526/1526),
    `git diff --check` propre.
17. **[FAIT]** Revue adversariale du diff complet R0+R1 — aucun défaut
    HIGH/MEDIUM restant.
18. **[EN ATTENTE]** Fusion dans `main`.
19. **[EN ATTENTE]** Déploiement Render — même ordre que ci-dessus (item
    9), migration T6 d'abord si pas déjà appliquée.
20. **[EN ATTENTE]** Une vraie annulation liée (après SELECT_PACK) et une
    vraie tentative d'annulation non liée refusée, observées en
    conditions réelles après déploiement.

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
