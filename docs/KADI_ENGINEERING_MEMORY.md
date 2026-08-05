# Mémoire technique — Kadi V1

Ce fichier documente des incidents et causes **réellement confirmés**, avec
preuve dans le dépôt (commit, migration, test). Ne pas ajouter d'hypothèse
non confirmée ici : une hypothèse non vérifiée appartient à un rapport de
mission, pas à la mémoire technique. Consulter ce fichier avant tout
diagnostic (voir [`../AGENTS.md`](../AGENTS.md)).

Statuts de fiche : `VALIDATED_CANARY` (corrigé et vérifié en usage réel),
`IMPLEMENTED_NOT_DEPLOYED` (corrigé dans le code, pas encore confirmé en
production), `BLOCKED` (non résolu, dépend d'un tiers).

---

## A. Meta 141006 — paiement bloquant les conversations initiées par l'entreprise

* **Statut :** `BLOCKED`.
* **Période :** connue depuis les premières tentatives d'envoi proactif en
  CANARY.
* **Symptôme :** Kadi ne peut pas initier une conversation WhatsApp business
  (ex. relance, notification proactive) vers un utilisateur.
* **Message visible :** erreur Meta liée au moyen de paiement du compte
  WhatsApp Business associé.
* **Cause racine confirmée :** configuration du moyen de paiement du compte
  Meta Business, en dehors du code Kadi.
* **Fausses pistes importantes :** ne pas diagnostiquer ce blocage comme un
  bug de `kadiV1WebhookRuntime.js` ou du presenter — le code applicatif
  n'est pas en cause.
* **Correctif :** aucun côté code ; nécessite une action sur la
  configuration du compte Meta Business (hors périmètre d'une mission de
  développement).
* **Commit ou migration :** sans objet.
* **Preuve de validation :** aucune à ce jour — blocage ouvert.
* **Prévention :** les interactions **initiées par l'utilisateur** (il
  écrit en premier) ne sont pas concernées ; concevoir les parcours pour ne
  pas dépendre d'un envoi proactif tant que ce blocage n'est pas levé.
* **Test de non-régression :** sans objet (dépendance externe).

---

## B. Meta 131009 — écran secondaire refusé comme second écran d'un Flow

* **Statut :** `VALIDATED_CANARY`.
* **Période :** rencontré lors du déploiement de P8.A1 (saisie d'article).
* **Symptôme :** Meta refusait d'ouvrir l'écran `ARTICLE_FORM` en tant que
  second écran du Flow `DOCUMENT_CONTENT`.
* **Message visible (Meta) :** « Specified screen ARTICLE_FORM is not
  allowed as first screen of this flow » (#131009).
* **Cause racine confirmée :** Meta n'autorise l'ouverture que du **premier
  écran déclaré** d'un Flow ; un Flow multi-écrans ne peut pas être navigué
  en ouvrant directement un écran interne.
* **Fausses pistes importantes :** tenter de réordonner les écrans dans le
  même fichier JSON ne résout pas le problème — la contrainte porte sur
  l'ouverture, pas sur l'ordre de déclaration.
* **Correctif :** séparation en deux Flows Meta indépendants et mono-écran,
  `DOCUMENT_CONTENT` (décision) et `ARTICLE_FORM` (saisie), chacun avec son
  propre `flow_key`, sa variable Render et son entrée dans
  `KADI_V1_DRAFT_FLOW_CATALOG`. Voir
  [`decisions/ADR-002-independent-meta-flows.md`](decisions/ADR-002-independent-meta-flows.md).
* **Commit ou migration :** lot « split article form into dedicated flow »
  (`23070dd` et son merge `16720e1`).
* **Preuve de validation :** `kadiV1ReleaseGate.js` (`validateFlowJson`)
  et `kadiV1ProductionPresenter.js` (`loadFlowRegistry`) imposent désormais
  strictement un seul écran terminal par Flow ; tests
  `tests/kadiV1DraftFlows.test.js` et `tests/kadiV1ReleaseGate.test.js`.
* **Prévention :** tout nouveau Flow doit suivre le contrat mono-écran dès
  sa création (voir
  [`runbooks/ADD_NEW_META_FLOW.md`](runbooks/ADD_NEW_META_FLOW.md)).
* **Test de non-régression :** « DOCUMENT_CONTENT registry loading rejects a
  second screen... » dans `tests/kadiV1DraftFlows.test.js`.

---

## C. Libellé Meta trop long

* **Statut :** `VALIDATED_CANARY`.
* **Période :** lot correctif isolé après P8.A1-C.
* **Symptôme :** un libellé de champ dépassait la limite de longueur
  autorisée par Meta pour un `label` de contrôle de formulaire.
* **Message visible :** rejet du Flow par Meta lors de la validation du
  libellé.
* **Cause racine confirmée :** `"Autre unité (si besoin)"` dépassait la
  limite autorisée.
* **Correctif :** libellé raccourci en `"Autre unité"`, `required: false`
  conservé, reste du champ inchangé.
* **Commit ou migration :** lot « shorten article custom unit label »
  (`6f068ba`, merge `0ca901a`).
* **Preuve de validation :** tests de libellés dans
  `tests/kadiV1DraftFlows.test.js` (limite de longueur des `cta`, absence de
  vocabulaire technique visible).
* **Prévention :** vérifier la longueur de tout libellé visible avant
  publication ; ne jamais valider un JSON de Flow sans repasser par les
  tests de libellés.
* **Test de non-régression :** vérification de longueur de `entry.card.cta`
  et des chaînes visibles dans `tests/kadiV1DraftFlows.test.js`.

---

## D. PostgreSQL 23514 — contrainte `expected_flow_key` désynchronisée du code

* **Statut :** `VALIDATED_CANARY`.
* **Période :** découvert après le déploiement de P8.A1-C (Flow
  `ARTICLE_FORM` séparé côté Node.js).
* **Symptôme :** toute ouverture de session `SAVE_CLIENT` /
  `START_ADD_CONTENT` échouait avant même un appel Meta.
* **Message visible :** erreur PostgreSQL `check_violation` (23514) sur la
  contrainte `kadi_v1_conversation_sessions_expected_flow_key_check`.
* **Cause racine confirmée :** `ARTICLE_FORM` avait été ajouté au registre
  `FLOW_KEYS` côté Node.js, mais pas à la liste fermée de valeurs autorisées
  par la contrainte SQL `expected_flow_key` — la base rejetait donc la
  création de session avant tout traitement applicatif.
* **Fausses pistes importantes :** le symptôme ressemblait à un problème
  Meta ou webhook ; un `catch {}` muet dans `kadiV1WebhookRuntime.js`
  masquait l'erreur réelle en avalant l'exception sans la journaliser.
* **Correctif :** migration corrective forward-only ajoutant `ARTICLE_FORM`
  à la contrainte, plus un `catch` nommé et journalisé de façon sûre dans
  `kadiV1WebhookRuntime.js` (`safeInternalReason`).
* **Commit ou migration :**
  `supabase/migrations/20260805020000_add_kadi_v1_article_form_flow_key.sql`
  (+ copie `migrations/20260805_add_kadi_v1_article_form_flow_key.sql`) ;
  commit de merge `d077e08`.
* **Preuve de validation :**
  `tests/kadiV1ArticleFormSessionMigration.test.js` vérifie les 16 valeurs
  attendues, l'ordre, l'absence de modification des migrations déjà
  appliquées, et l'unicité de l'ajout.
* **Prévention :** **chaque nouveau `FLOW_KEY` doit mettre à jour la
  contrainte `expected_flow_key`** dans la même mission que son ajout côté
  Node.js, avec un test de migration dédié (voir
  [`runbooks/ADD_NEW_META_FLOW.md`](runbooks/ADD_NEW_META_FLOW.md)).
  P8.A2 (`INVOICE_TYPE`) a suivi cette procédure dès l'implémentation —
  migration `20260805030000_add_kadi_v1_invoice_type_flow_key.sql`, 17
  valeurs, testée par `tests/kadiV1InvoiceTypeSessionMigration.test.js`.
* **Test de non-régression :** `tests/kadiV1ArticleFormSessionMigration.test.js`.

---

## E. Historique de migrations Supabase désynchronisé entre le dépôt et le distant

* **Statut :** `VALIDATED_CANARY` (procédure suivie, pas d'incident ouvert).
* **Période :** régularisation effectuée avant `404a3fa` (« track Supabase
  remote migration history »).
* **Symptôme :** des versions de migration existaient côté distant sans
  fichier local correspondant, et certaines migrations locales avaient un
  équivalent distant sous un timestamp différent.
* **Cause racine confirmée :** des migrations avaient été appliquées
  directement en distant (ou renommées) sans que le dépôt Git suive
  l'historique réel des migrations Supabase.
* **Correctif :** procédure suivie — récupération (`fetch`) de l'historique
  distant, comparaison texte-à-texte du SQL avec les fichiers locaux, puis
  `supabase migration repair --status applied` **seulement après preuve
  d'équivalence du contenu**, puis ajout au suivi Git des migrations
  distantes désormais confirmées identiques.
* **Commit ou migration :** commit « track Supabase remote migration
  history » (`275b195`, merge `404a3fa`) — ajout au suivi Git de
  `20260731_create_kadi_invoice_flow_drafts.sql`,
  `20260801_create_kadi_invoice_flow_sessions.sql`,
  `20260803224227_add_kadi_v1_conversation_sessions_pg17.sql`,
  `20260804032746_create_kadi_v1_private_artifact_bucket.sql`,
  `20260804120449_add_kadi_v1_onboarding_profile_completion.sql`.
* **Preuve de validation :** comparaison de contenu effectuée avant tout
  `repair`, jamais l'inverse.
* **Prévention :**
  * ne jamais exécuter `supabase migration repair` sans avoir d'abord
    comparé le SQL distant et local ;
  * **ne jamais recommander automatiquement
    `supabase migration repair --status reverted`** — cette commande efface
    la trace d'une migration réellement appliquée et doit rester une
    décision humaine explicite, jamais une action par défaut d'un agent ;
  * après toute régularisation, committer immédiatement les fichiers de
    migration distants désormais suivis, pour que Git redevienne la source
    de vérité.
* **Test de non-régression :** sans objet direct (procédure d'hygiène de
  dépôt) ; voir
  [`runbooks/APPLY_SUPABASE_MIGRATION.md`](runbooks/APPLY_SUPABASE_MIGRATION.md).

---

## F. Ancien formulaire WhatsApp qui continue de représenter une version obsolète

* **Statut :** `VALIDATED_CANARY` (règle de procédure appliquée).
* **Symptôme :** un Flow WhatsApp déjà ouvert par un utilisateur avant la
  publication d'une nouvelle version peut continuer d'afficher l'ancienne
  version pendant toute la durée de cette session.
* **Cause racine confirmée :** un Flow Meta ouvert représente un instantané
  ; republier le Flow ne met pas à jour une session déjà en cours côté
  client WhatsApp.
* **Correctif :** aucun correctif technique possible après coup — c'est un
  comportement attendu de la plateforme Meta.
* **Prévention :** **toujours démarrer un nouveau parcours CANARY** (nouveau
  message entrant, nouvelle session) après toute publication de Flow, avant
  de conclure qu'un correctif ne fonctionne pas. Ne jamais valider un
  correctif de Flow en reprenant une session déjà ouverte avant la
  publication.
* **Test de non-régression :** sans objet (procédure opérationnelle) ; voir
  [`runbooks/DEPLOY_CANARY.md`](runbooks/DEPLOY_CANARY.md).

---

## G. Une suite de tests locale au vert ne prouve pas la configuration distante

* **Statut :** rappel permanent, sans statut de résolution.
* **Symptôme observé historiquement :** une suite de tests locaux à 100 % de
  réussite a coexisté avec un blocage de production (fiche D) provoqué par
  une contrainte SQL distante non synchronisée.
* **Cause racine confirmée :** les tests locaux valident le code et des
  bases de données en mémoire ou éphémères ; ils ne peuvent pas vérifier
  l'état réel de Meta, de Render ou de la base Supabase distante.
* **Prévention :** après tout `npm test` local au vert concernant Meta,
  Render ou Supabase, vérifier explicitement l'état distant avant de
  déclarer une mission terminée pour la production — voir
  [`KADI_RELEASE_CHECKLIST.md`](KADI_RELEASE_CHECKLIST.md).
* **Test de non-régression :** sans objet (limite méthodologique
  structurelle, pas un bug corrigible par un test).

---

## H. Dette de reprise conversationnelle pour `invoice_kind`

* **Statut :** `IMPLEMENTED_NOT_DEPLOYED` / dette documentée.
* **Symptôme potentiel :** si une session WhatsApp expire alors qu'une
  facture existe déjà sans `invoice_kind` valide, le mécanisme de reprise
  doit rouvrir `INVOICE_TYPE` avant `DOCUMENT_CLIENT`.
* **État réel du code :** `kadiV1FlowRouter.resolveFlowKey` gère déjà cette
  règle pour l'intention `COLLECT_CLIENT` (testée dans
  `tests/kadiV1FlowRouter.test.js`), mais **aucun appelant de production**
  dans `kadiV1ConversationOrchestrator.js` ne déclenche aujourd'hui cette
  intention pour un document en état `COLLECTING` — `routeForDocument` n'y
  route que les états postérieurs à la collecte (révision, aperçu,
  confirmation de génération, recharge).
* **Cause :** priorité donnée à l'implémentation du garde-fou et de ses
  tests unitaires pendant P8.A2 ; le câblage de la reprise conversationnelle
  complète pour l'état `COLLECTING` a été explicitement reporté.
* **Fausses pistes importantes :** ne pas supposer que la reprise
  conversationnelle pour `invoice_kind` fonctionne de bout en bout en
  production simplement parce que la fonction de routage existe et est
  testée — le chemin d'appel réel manque.
* **Correctif :** reste à faire — câbler un appel production vers
  `resolveFlowKey({intent: "COLLECT_CLIENT", ...})` (ou équivalent) pour les
  documents `FACTURE` en état `COLLECTING`/`INCOMPLETE`.
* **Commit ou migration :** fonction ajoutée dans le commit de merge
  `1fb1329` (« add Kadi V1 invoice type flow »).
* **Preuve de validation :** tests unitaires de routage uniquement — pas de
  preuve d'intégration bout en bout.
* **Prévention :** avant de considérer INVOICE_TYPE totalement terminé,
  vérifier explicitement ce point dans
  [`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md).
* **Test de non-régression :** `tests/kadiV1FlowRouter.test.js` (« une
  facture sans invoice_kind valide reprend sur INVOICE_TYPE... »).
