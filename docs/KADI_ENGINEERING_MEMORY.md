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

---

## I. RECU réutilisait les écrans génériques client/article

* **Statut :** `IMPLEMENTED_NOT_DEPLOYED`.
* **Période :** confirmé et corrigé dans la mission `fix/kadi-v1-receipt-discharge`.
* **Symptôme :** après avoir choisi RECU, l'utilisateur atteignait
  `DOCUMENT_CLIENT` (champs nom/téléphone/e-mail/adresse/identifiant
  fiscal), puis le parcours article (`ARTICLE_FORM`/`DOCUMENT_CONTENT`),
  alors que le reçu interdit explicitement toute ligne d'article.
* **Message visible :** une erreur générique récupérable, sans rapport
  avec le reçu.
* **Cause racine confirmée :** `nextFlowForReply` (routage par action) et
  `resolveFlowKey` (routage par intention/reprise) ne distinguaient pas
  RECU des types FACTURE/DEVIS pour les intentions
  `COLLECT_CLIENT`/`COLLECT_CONTENT`/`COLLECT_OPTIONS`/`EDIT_CLIENT`/
  `EDIT_CONTENT`/`EDIT_OPTIONS` ; RECU tombait donc systématiquement sur les
  écrans partagés facture/devis alors que son modèle métier
  (`payer`/`beneficiary`/`amount`/`reason`) est incompatible.
* **Fausses pistes importantes :** le pipeline métier
  (`kadiV1SharedDocumentPipeline.js`) traitait déjà correctement les
  champs reçu via `addContent` (policy `normalizeReceiptContent`) — la
  cause n'était pas la persistance mais uniquement le routage vers le bon
  écran.
* **Correctif :** nouveau Flow Meta indépendant mono-écran
  `RECEIPT_DETAILS` (`flows/v1_draft/kadi_receipt_details_v1.json`),
  ajouté à tous les registres fermés (FLOW_KEYS, FLOW_ENV_KEYS, catalogue,
  actions/champs autorisés, routage présentateur, contrainte Supabase).
  Un nouveau champ `invoice`-style `receipt_format` (`A4`/`TICKET_80`) a
  été ajouté, obligatoire avant `READY_FOR_REVIEW`, persisté dans
  `document.options.receipt_format` via une nouvelle fonction dédiée
  `setReceiptFormat`.
* **Commit ou migration :**
  `supabase/migrations/20260805040000_add_kadi_v1_receipt_details_flow_key.sql`
  (+ copie `migrations/`).
* **Preuve de validation :** `tests/kadiV1ReceiptJourney.test.js`,
  `tests/kadiV1FlowRouter.test.js`, `tests/kadiV1ReceiptDetailsSessionMigration.test.js`.
* **Prévention :** tout nouveau type de document dont le modèle métier
  diffère de facture/devis doit avoir son propre Flow dédié dès la
  conception, jamais réutiliser `DOCUMENT_CLIENT`/`ARTICLE_FORM` « en
  attendant ».
* **Test de non-régression :** « RECU never routes to DOCUMENT_CLIENT,
  ARTICLE_FORM or DOCUMENT_CONTENT... » dans `tests/kadiV1ReceiptJourney.test.js`.

---

## J. DECHARGE — écran mixte saisie/action et champs désynchronisés

* **Statut :** `IMPLEMENTED_NOT_DEPLOYED`.
* **Période :** confirmé et corrigé dans la mission `fix/kadi-v1-receipt-discharge`.
* **Symptôme :** l'écran `DISCHARGE_DETAILS` affichait un sélecteur
  « Prochaine étape » (Enregistrer / C'est bon / Modifier / Annuler) dès la
  première ouverture, avant que la moindre information ne soit saisie ;
  tous les champs métier étaient facultatifs, ce qui laissait l'utilisateur
  continuer sans informations réelles et produisait le message générique
  « Je n'ai pas pu terminer cette étape. Réessayez dans un instant. ».
* **Cause racine confirmée (double) :**
  1. un même écran mélangeait saisie initiale et actions de révision,
     normalement séparées (`DOCUMENT_REVIEW` gère déjà VERIFY/EDIT/CANCEL
     de façon générique, y compris pour DECHARGE, via le branchement
     `document_type === "DECHARGE"` dans les adaptateurs `verify`/`cancel`) ;
  2. le Flow envoyait `purpose`, `notes` et `transferred_content` alors que
     l'adaptateur (`kadiV1RuntimeAdapters.js:saveDischargeDetails`) lisait
     déjà `reason`, `observations`, `description`/`amount` — ces champs
     n'étaient donc jamais renseignés, quelle que soit la saisie utilisateur.
* **Fausses pistes importantes :** le pipeline
  (`kadiV1DischargePipeline.js`) et la politique
  (`kadiV1DischargePolicy.js`) étaient déjà corrects et utilisaient déjà
  les types canoniques `MONEY`/`GOODS`/`DOCUMENT`/`OTHER` — la cause était
  entièrement dans le JSON du Flow et le nommage des champs qu'il envoyait.
* **Correctif :** sélecteur d'action retiré du formulaire initial ; champs
  renommés directement dans le JSON (`reason`, `observations`,
  `description`, nouveaux champs `amount`/`quantity` structurés) ;
  `FLOW_ACTIONS.DISCHARGE_DETAILS` réduit à `["SAVE_DETAILS"]` seul (VERIFY/
  EDIT/CANCEL retirés, gérés par `DOCUMENT_REVIEW`) ; validation stricte
  ajoutée côté `kadiV1FlowReplyRuntime.js` (montant entier positif
  obligatoire pour `MONEY`, description obligatoire sinon, montant interdit
  hors `MONEY`).
* **Commit ou migration :** aucune migration nécessaire (aucun nouveau
  `flow_key`, `DISCHARGE_DETAILS` existait déjà dans la contrainte).
* **Preuve de validation :** `tests/kadiV1DischargeJourney.test.js`.
* **Prévention :** ne jamais faire porter par un même écran à la fois la
  saisie initiale et les actions de révision d'un document ; vérifier
  systématiquement que les noms de champs envoyés par un Flow JSON
  correspondent exactement à ceux lus par l'adaptateur correspondant.
* **Test de non-régression :** « initial DISCHARGE_DETAILS JSON has no
  action selector... » et « MONEY requires a positive integer amount »
  dans `tests/kadiV1DischargeJourney.test.js`.

---

## K. Fondation `KADI_CONVERSATIONAL_MULTIMODAL_V1` déjà largement présente avant sa mission de création

* **Statut :** `MERGED_DEPLOYMENT_UNVERIFIED_DISABLED_NOT_ACTIVATED` —
  fondation fusionnée dans `main` via PR #8 (commit de merge
  `c3030c909fdb526c5341622afe5a8b5389f0a77d`), et depuis câblée dans
  l'orchestrateur et le bootstrap de production via
  [PR #10](https://github.com/GueswendeOue/kadi-backend/pull/10) (commit de
  merge `c23ea3bfa58ddc95baff799e617da581279d8c1f`) ; toujours désactivée
  par défaut (flags et allowlist CANARY conversationnelle non configurés).
* **Période :** mission de création de la fondation, puis mission de revue
  du même travail, puis fusion.
* **Symptôme :** une mission demandant de « créer la fondation isolée » de
  la compréhension conversationnelle multimodale a démarré sans savoir que
  `kadiV1BrainContracts.js`, `kadiV1Brain.js`, `kadiV1BrainProviders.js`,
  `kadiV1GeminiVisionProvider.js`, `kadiV1SpeechToText.js` et le
  classificateur déterministe `detectNaturalIntent` /
  `validateCanonicalText` de `kadiV1ConversationOrchestrator.js` existaient
  déjà, testés, et couvraient une large part du périmètre demandé — le tout
  déjà désactivé par défaut (`KADI_V1_BRAIN_ENABLED` etc.).
* **Cause racine confirmée :** l'audit de lecture seule en phase 1 n'avait
  pas été fait avant la première mission de rédaction de code ; la mission
  elle-même ne mentionnait pas cette infrastructure.
* **Fausses pistes importantes :**
  * ne pas confondre « le cerveau IA (`kadiV1Brain*.js`) est désactivé en
    production » avec « le cerveau IA n'existe pas encore » — l'audit de
    lecture seule (§0 et §9 de `AGENTS.md`) doit précéder toute mission de
    création de fonctionnalité IA/conversationnelle ;
  * **correction (mission de pré-commit suivante) :** une première rédaction
    de cette fiche avait qualifié l'abandon du tampon de décision
    « V1-only », en confondant « `AGENTS.md` §3/§17 et KFD-003 parlent
    d'abord du chemin V1 » avec « la décision produit elle-même est limitée
    à V1 ». Le fondateur a corrigé : **l'abandon du tampon est une décision
    produit-wide, permanente, pour tout Kadi présent et futur**, pas
    seulement pour Kadi V1. Voir `AGENTS.md` §3/§17 (portée corrigée) ;
  * ne pas confondre non plus « le tampon est abandonné comme décision
    produit » avec « le code legacy de tampon a été supprimé ou n'est plus
    joignable » — un audit en lecture seule (voir ci-dessous) a confirmé que
    le chemin webhook legacy (`kadiPriorityRouter.js`, `kadiMenus.js`,
    `kadiStampFlow.js`, `kadiPdfFlow.js`, `kadiPricing.js`,
    `kadiCommandFlow.js`, `kadiInteractiveFlow.js`) reste **effectivement
    exécuté pour tout utilisateur non listé dans `KADI_V1_CANARY_WA_IDS`**
    (`kadiFlowMonitoringWebhook.js` → `dispatchWhatsAppWebhook` appelle
    `kadiV1WebhookHandler` en premier, et ne retombe sur
    `handleIncomingMessage` — le chemin legacy — que si celui-ci ne
    « handle » pas le message, ce qui est le cas par défaut hors CANARY).
    Le tampon est donc aujourd'hui **réellement offert à de vrais
    utilisateurs de production**, pas seulement présent en code mort. Sa
    présence reste de la dette technique tolérée en attendant une mission
    de nettoyage distincte et explicitement autorisée — jamais une preuve
    que la fonctionnalité est encore un choix produit accepté.
* **Correctif :** la fondation a été reconstruite comme couche additive fine
  (`kadiV1ConversationalMultimodalContracts.js`,
  `kadiV1ConversationalMultimodalPolicy.js`, `kadiV1GeminiAudioProvider.js`)
  qui réutilise l'existant plutôt que de le dupliquer. La revue qui a suivi
  a trouvé et corrigé deux duplications réelles introduites par la première
  passe :
  1. une liste `AUTHORITY_FIELDS` recopiée à la main (au lieu d'être
     importée de `kadiV1BrainContracts.js`, désormais exportée) ;
  2. un classificateur déterministe FR indépendant du
     `detectNaturalIntent` réellement utilisé par l'orchestrateur en
     production (désormais remplacé par un appel direct à
     `detectNaturalIntent`/`validateCanonicalText`, tous deux désormais
     exportés et réutilisés).
  Un troisième défaut, plus sérieux, a aussi été trouvé et corrigé : la
  validation d'un candidat extrait (`extracted_entities.<champ>.value`)
  n'appliquait qu'un contrôle superficiel (`!= null`), ce qui permettait à
  une sortie de fournisseur malformée de transporter une clé d'autorité
  (`total`, `debit`, etc.) imbriquée **sous** un champ autorisé (ex.
  `client.value.total`), contournant ainsi le contrôle `AUTHORITY_FIELDS`
  de premier niveau. Corrigé en réutilisant
  `validateSimpleValue`/`validateItems` de `kadiV1BrainContracts.js`
  (désormais exportées), qui appliquent déjà une liste fermée récursive et
  bornée en profondeur.
* **Commit ou migration :** commits `57b661a` (fondation) et `20beb8c`
  (correctifs de revue), fusionnés dans `main` par le commit de merge
  `c3030c909fdb526c5341622afe5a8b5389f0a77d` (PR #8). Aucune migration
  Supabase associée.
* **Preuve de validation :** `tests/kadiV1ConversationalMultimodalContracts.test.js`,
  `tests/kadiV1ConversationalMultimodalPolicy.test.js` (dont des tests de
  parité explicites contre `detectNaturalIntent`),
  `tests/kadiV1GeminiAudioProvider.test.js`, `tests/kadiV1RuntimeConfig.test.js`.
* **Prévention :** avant toute mission de création d'une capacité IA ou
  conversationnelle, exécuter d'abord l'audit de lecture seule de la phase 1
  (`kadiV1Brain*.js`, `kadiV1ConversationOrchestrator.js`,
  `kadiV1GeminiVisionProvider.js`, `kadiV1SpeechToText.js`,
  `kadiV1RuntimeAdapters.js`) et documenter explicitement ce qui existe déjà
  avant d'écrire du nouveau code ; pour toute validation d'autorité
  (`AUTHORITY_FIELDS`), toujours valider récursivement la forme des valeurs
  imbriquées, jamais seulement les clés de premier niveau.
* **Test de non-régression :** « un champ d'autorité imbriqué dans la
  valeur d'un candidat est rejeté » et les tests de parité d'intention dans
  `tests/kadiV1ConversationalMultimodalContracts.test.js` /
  `tests/kadiV1ConversationalMultimodalPolicy.test.js`.

---

## L. Intégration orchestrateur : l'enveloppe conversationnelle n'est pas consommable telle quelle par `documents.apply(...)`

* **Statut :** `MERGED_DEPLOYMENT_UNVERIFIED_DISABLED_NOT_ACTIVATED` (fusionné
  dans `main` via [PR #10](https://github.com/GueswendeOue/kadi-backend/pull/10),
  commit de merge `c23ea3bfa58ddc95baff799e617da581279d8c1f` ; flags et
  allowlist restent inactifs — voir
  [`KADI_CONVERSATIONAL_MULTIMODAL_V1.md`](KADI_CONVERSATIONAL_MULTIMODAL_V1.md)
  pour le détail exact de l'activation requise).
* **Période :** mission d'intégration de `KADI_CONVERSATIONAL_MULTIMODAL_V1`
  dans `kadiV1ConversationOrchestrator.js` et `kadiV1ProductionBootstrap.js`.
* **Symptôme potentiel évité :** faire passer l'enveloppe conversationnelle
  (`kadiV1ConversationalMultimodalContracts.js`, champs `extracted_entities`,
  `ambiguous_fields`, `needs_confirmation`, `schema_version`, `operation`,
  etc.) directement comme `brainResult` dans `documents.apply({ ...,
  brainResult })` aurait échoué silencieusement ou de façon confuse.
* **Cause racine confirmée :** `kadiV1SharedDocumentPipeline.js` /
  `kadiV1DischargePipeline.js`'s `applyBrainExtraction(command)` valide
  `command.brainResult` avec `kadiV1BrainContracts.validateBrainResult`
  **exactement** — cette fonction attend précisément
  `{intent, document_type, extracted_fields, missing_fields, uncertainties,
  confidence, suggested_next_action, user_facing_message_draft,
  provider_metadata}`. L'enveloppe conversationnelle a des noms de champs et
  des énumérations différents par conception (elle sert un vocabulaire plus
  large : CHECK_BALANCE, RECHARGE, CANCEL, SEARCH_HISTORY, `operation`, etc.,
  que le contrat Brain ne connaît pas) — elle échouerait donc
  `validateBrainResult`.
* **Fausses pistes qui auraient été coûteuses :** (1) resynthétiser un objet
  `brainResult` à partir de l'enveloppe conversationnelle — risque réel de
  micro-divergences avec ce que `validateBrainResult` accepte, et surtout
  perte de la garantie que la donnée appliquée au document est *exactement*
  ce que le fournisseur (OpenAI/Gemini) a réellement renvoyé ; (2) appeler le
  brain une seconde fois côté adaptateur pour obtenir un `brainResult`
  « propre » — double appel payant pour le même message utilisateur,
  explicitement interdit par la mission (« avoid duplicate processing »).
* **Correctif initial (superseded — voir « Correction ultérieure » ci-dessous) :**
  une première version faisait transiter le `brainResult` **original,
  inchangé**, tel que `brain.understand(...)` l'avait produit, en plus de
  l'enveloppe, via `interpretForDraftApplication(...)`. Ce choix évitait un
  second appel fournisseur mais avait un coût réel : l'`operation`
  (correction/ajout/retrait/changement de type) et les
  `requested_corrections` détectées par l'enveloppe n'étaient alors **jamais
  effectivement utilisées** dans la mutation appliquée — seul ce que le
  cerveau brut avait extrait comptait.
* **Correction ultérieure (état final retenu) :** remplacé par un
  **adaptateur canonique unique et explicite**,
  `conversationalResultToBrainResult(envelope)` dans le nouveau fichier
  `kadiV1ConversationalMultimodalBrainAdapter.js`. Chaîne obligatoire :
  `interpretConversationalInput` → `validateConversationalResult` (interne)
  → `conversationalResultToBrainResult` → `validateBrainResult` (interne) →
  `documents.apply(...)`. Mapping strict et fermé : seuls les champs
  `EXTRACTED_FIELD_KEYS` non `AUTHORITY_FIELDS` sont copiés un par un
  (jamais un spread de l'entrée) ; `operation` n'est acceptée que pour
  `CORRECT_FIELD`/`ADD_ITEM` (exprimables via `extracted_fields` avec le
  pipeline existant) — `REMOVE_ITEM` et `CHANGE_DOCUMENT_TYPE` sont
  **toujours rejetés par cet adaptateur précis** (aucun mapping vers
  `extracted_fields`), faute d'équivalent atteignable en un seul appel
  `documents.apply(...)` (`applyBrainExtraction` n'a pas de notion de
  suppression d'article, et le `document_type` d'un brouillon est immuable).
  **Mise à jour (voir fiche M) :** `REMOVE_ITEM` a depuis reçu son propre
  chemin, en dehors de cet adaptateur, vers le port existant
  `documents.removeContent(...)` ; `CHANGE_DOCUMENT_TYPE` reste rejeté fermé
  pour toute paire de types. `interpretForDraftApplication` a été retiré
  (plus aucun appelant) plutôt que laissé comme deuxième chemin mort à côté
  du nouveau.
* **Décision de conception associée :** le nouvel adaptateur d'exécution
  (`kadiV1ConversationalMultimodalRuntimeAdapter.js`) implémente
  volontairement le **même port** `interpret(command)` que l'adaptateur
  existant `createKadiV1InterpretationRuntimeAdapter`
  (`{intent, document_type, brain_result}`), ce qui a permis de câbler
  l'intégration **sans modifier `kadiV1ConversationOrchestrator.js` pour le
  branchement lui-même** — seule la couche de composition choisit
  l'adaptateur. La seule modification fonctionnelle de l'orchestrateur est
  une branche additive pour l'intent `RECHARGE`, que l'adaptateur d'origine
  ne peut jamais produire (donc inatteignable sans l'intégration active).
* **Commit ou migration :** fusionné dans `main` via
  [PR #10](https://github.com/GueswendeOue/kadi-backend/pull/10), commit de
  merge `c23ea3bfa58ddc95baff799e617da581279d8c1f`.
* **Preuve de validation :**
  `tests/kadiV1ConversationalMultimodalBrainAdapter.test.js`,
  `tests/kadiV1ConversationalMultimodalRuntimeAdapter.test.js`,
  `tests/kadiV1ProductionOrchestratorComposition.test.js` (tests
  « avec/sans conversationalMultimodalCanaryConfig », et le test des 4
  conditions d'activation), `tests/kadiV1ProductionBootstrap.test.js`
  (readiness diagnostics), `tests/kadiV1ConversationOrchestrator.test.js`
  (branche RECHARGE), `tests/kadiV1CanaryIngress.test.js` (allowlist
  indépendante).
* **Prévention :** avant de brancher un nouveau résultat de compréhension
  IA sur un port de mutation de document existant, vérifier d'abord
  exactement quelle fonction de validation ce port applique en interne
  (`grep` sur `validateBrainResult`/`applyBrainExtraction`) — ne jamais
  supposer qu'une enveloppe « proche » sera acceptée telle quelle. Quand un
  mapping explicite champ-par-champ est requis, l'implémenter comme une
  liste fermée unique, jamais un spread, et faire échouer fermé toute
  opération non exprimable par le port cible plutôt que d'improviser une
  mutation approximative.
* **Test de non-régression :** « un résultat conversationnel valide devient
  un résultat Brain valide, accepté indépendamment par validateBrainResult »
  et « REMOVE_ITEM/CHANGE_DOCUMENT_TYPE sont rejetés par cet adaptateur »
  dans `tests/kadiV1ConversationalMultimodalBrainAdapter.test.js`.

## M. Complétion de l'intégration orchestrateur : REMOVE_ITEM, CHANGE_DOCUMENT_TYPE, repli PREPARE_DOCUMENT, observabilité

* **Statut :** `MERGED_DEPLOYMENT_UNVERIFIED_DISABLED_NOT_ACTIVATED` (même
  fusion que la fiche L, PR #10, commit de merge
  `c23ea3bfa58ddc95baff799e617da581279d8c1f`).
* **Période :** mission de complétion, après la fiche L, avant relecture
  indépendante de la branche.
* **REMOVE_ITEM — décision et cause :** `conversationalResultToBrainResult`
  rejette structurellement `REMOVE_ITEM` (ce n'est pas un champ à corriger,
  c'est une entrée d'un tableau à retirer). Plutôt qu'inventer une nouvelle
  logique de mutation, la suppression réutilise le port **existant et déjà
  sûr** `documents.removeContent(...)` (`kadiV1RuntimeAdapters.js` →
  `kadiV1SharedDocumentPipeline.js`, confirmé en lecture seule : suppression
  par `item_id` exact via `Array.filter`, échec `DOCUMENT_ITEM_NOT_FOUND` si
  absent, recalcul serveur du sous-total). Le nouveau
  `kadiV1ConversationalMultimodalItemLookup.js` résout la phrase de retrait
  contre `activeDocument.items[].description` (comparaison normalisée,
  correspondance exacte-unique uniquement — absence ou ambiguïté échouent
  fermé vers une clarification, jamais une suppression devinée).
  `kadiV1ConversationOrchestrator.js` gagne une branche additive dédiée
  (miroir du motif déjà utilisé pour `RECHARGE`) et `assertPort` exige
  désormais `removeContent` sur `documentRuntime` — déjà exposé par
  l'adaptateur réel, seuls les mocks de test (`kadiV1ConversationOrchestrator.test.js`)
  ont dû être complétés.
* **CHANGE_DOCUMENT_TYPE — décision de conception (écart assumé par rapport
  à la lettre de la mission) :** la mission demandait explicitement de
  « supporter au minimum FACTURE ↔ DEVIS ». Lecture du code existant :
  `applyBrainExtraction` rejette **tout** écart de `document_type` avec
  `BRAIN_DOCUMENT_TYPE_MISMATCH`, sans distinction de paire — il n'existe
  aucune capacité backend de conversion en place pour FACTURE↔DEVIS, pas
  plus que pour RECU/DECHARGE. Créer une politique de report de données
  (client, articles, quantités, prix) pour seulement une paire aurait été
  une nouvelle logique de migration inventée pour cette mission, ce que la
  mission interdit explicitement (« do not invent a migration policy »),
  et une incohérence produit (pourquoi FACTURE↔DEVIS serait sûr et pas
  RECU↔DECHARGE, alors que la contrainte technique est identique). Décision
  retenue : échec fermé pour **toutes** les paires, avec une clarification
  explicite proposant l'alternative déjà existante (annuler puis
  redémarrer un document du type voulu), plutôt qu'un silence ou une
  fausse promesse de conversion partielle.
* **Repli exact PREPARE_DOCUMENT :** avant cette mission, un échec de
  `conversationalResultToBrainResult` pour `CREATE_DOCUMENT` retombait sur
  une clarification générique (« Envoyez-moi les informations... »), même
  quand le `document_type` avait été déterminé et validé avec confiance —
  contredisant ce que l'interprétation venait d'établir. Correctif :
  `envelope.intent === "CREATE_DOCUMENT" && envelope.document_type` déclenche
  désormais `{intent: "PREPARE_DOCUMENT", document_type, brain_result: null}`,
  qui emprunte le chemin `documents.start(...)` déjà existant (brouillon
  vide). Les échecs **avant** enveloppe validée (timeout/refus fournisseur,
  `interpretConversationalInput` qui lève une exception) restent en échec
  fermé classique : à ce stade il n'existe aucun `document_type` fiable
  sans deviner, et deviner aurait été pire que demander à réessayer. Fausse
  piste écartée : réutiliser `detectDocumentTypeHint(text)` dans le bloc
  `catch` — inutile par construction, puisque
  `kadiV1ConversationOrchestrator.js` court-circuite déjà, **avant même
  d'appeler `interpretation.interpret(...)`**, tout texte contenant un mot-clé
  de type de document reconnu par ce même `detectNaturalIntent` ; si ce
  bloc `catch` est atteint pour une entrée TEXT/TRANSCRIPTION, ce hint est
  garanti `null` par construction — l'ajouter aurait été du code mort.
* **Observabilité :** `kadiV1ConversationalMultimodalObservability.js`
  reprend le motif `safeEmitter(logger)` déjà utilisé par
  `kadiV1GeminiVisionProvider.js`/`kadiV1GeminiAudioProvider.js` plutôt que
  d'en inventer un nouveau — liste fermée de 5 noms d'événement, liste
  fermée de champs sûrs (hash tronqué de corrélation, énumérations
  fermées, buckets de latence grossiers), jamais de texte/numéro complet.
  Voir `docs/KADI_CONVERSATIONAL_MULTIMODAL_V1.md` §5bis pour le détail
  complet des garanties et de la politique de rejeu de webhook.
* **Commit ou migration :** fusionné dans `main` via
  [PR #10](https://github.com/GueswendeOue/kadi-backend/pull/10), commit de
  merge `c23ea3bfa58ddc95baff799e617da581279d8c1f`.
* **Preuve de validation :**
  `tests/kadiV1ConversationalMultimodalItemLookup.test.js`,
  `tests/kadiV1ConversationalMultimodalObservability.test.js`, tests ajoutés
  dans `tests/kadiV1ConversationalMultimodalRuntimeAdapter.test.js`
  (REMOVE_ITEM correspondance unique/ambiguë/absente, CHANGE_DOCUMENT_TYPE,
  repli PREPARE_DOCUMENT sur échec de mapping, événements d'observabilité,
  logger défaillant sans impact sur le résultat), tests ajoutés dans
  `tests/kadiV1ConversationOrchestrator.test.js` (branche REMOVE_ITEM),
  tests ajoutés dans `tests/kadiV1ProductionOrchestratorComposition.test.js`
  (`conversationalObservabilityLogger` de bout en bout). Suite complète :
  1065/1065.
* **Prévention :** avant de décider qu'une opération conversationnelle a
  besoin d'une nouvelle logique de mutation, vérifier d'abord si un port
  existant (même conçu pour un autre appelant, ex. Flow) couvre déjà le
  besoin exact — `documents.removeContent(...)` existait et était testé
  avant cette mission, seul le câblage manquait. Avant d'ajouter un chemin
  de repli « best effort », vérifier qu'il est réellement atteignable dans
  le flux réel (l'audit de `kadiV1ConversationOrchestrator.js` a montré
  qu'un repli basé sur `detectDocumentTypeHint` dans le bloc `catch` de
  l'adaptateur aurait été mort par construction) plutôt que de l'ajouter
  par précaution.
* **Test de non-régression :** voir la liste « Preuve de validation »
  ci-dessus ; en particulier « CREATE_DOCUMENT dont le mapping vers Brain
  échoue retombe sur PREPARE_DOCUMENT... jamais une simple clarification
  générique » et « CHANGE_DOCUMENT_TYPE (FACTURE -> DEVIS) échoue toujours
  fermé... jamais de mutation ni de nouveau document_type » dans
  `tests/kadiV1ConversationalMultimodalRuntimeAdapter.test.js`.
* **Mise à jour (voir fiche N) :** l'affirmation ci-dessus « un repli basé
  sur `detectDocumentTypeHint` dans le bloc `catch` de l'adaptateur aurait
  été mort par construction » était correcte **au niveau de l'adaptateur**
  à ce moment précis, mais l'audit de la fiche N a montré que le vrai
  problème était **en amont, dans l'orchestrateur lui-même** : celui-ci
  court-circuitait `PREPARE_DOCUMENT` de façon inconditionnelle, avant même
  de savoir si le propriétaire était éligible au conversationnel — ce qui
  rendait aussi CHANGE_DOCUMENT_TYPE et REMOVE_ITEM sans objet pour tout
  texte contenant un mot-clé de type de document. Le correctif final vit
  dans `kadiV1ConversationOrchestrator.js`, pas dans l'adaptateur — voir
  fiche N pour le détail confirmé.

## N. Contradiction PREPARE_DOCUMENT : le court-circuit déterministe de l'orchestrateur ignorait l'éligibilité conversationnelle

* **Statut :** `MERGED_DEPLOYMENT_UNVERIFIED_DISABLED_NOT_ACTIVATED` (même
  fusion que les fiches L et M, PR #10, commit de merge
  `c23ea3bfa58ddc95baff799e617da581279d8c1f`).
* **Période :** mission de complétion, immédiatement après la fiche M,
  suite à un audit explicitement demandé de l'ordonnancement
  `detectNaturalIntent` / `PREPARE_DOCUMENT` / éligibilité conversationnelle
  / `interpretationRuntime` / `documents.apply`.
* **Symptôme confirmé :** pour tout message texte contenant un mot-clé
  reconnu par `detectNaturalIntent` (« facture », « devis », « reçu »,
  « décharge »), `kadiV1ConversationOrchestrator.js` appelait directement
  `documents.start(...)` et retournait, **sans jamais appeler
  `interpretation.interpret(...)`** — y compris pour un propriétaire
  explicitement éligible au parcours conversationnel. Pour « Fais une
  facture pour Moussa avec trois tables à 45 000. », cela démarrait un
  brouillon **entièrement vide** : Moussa et les trois tables étaient
  perdus, alors même que `kadiV1ConversationalMultimodalPolicy.js` avait
  été conçu, dès la fondation, précisément pour ne jamais perdre ces
  données (son propre commentaire l'explique) — cette conception n'était
  simplement jamais atteinte.
* **Cause racine confirmée :** deux détecteurs déterministes distincts
  coexistent dans le dépôt : celui de l'orchestrateur
  (`kadiV1ConversationOrchestrator.js`'s propre `detectNaturalIntent`, qui
  s'exécute **avant** toute notion d'éligibilité) et celui de la politique
  conversationnelle (`classifyDeterministicIntent` dans
  `kadiV1ConversationalMultimodalPolicy.js`, qui délègue au même
  `detectNaturalIntent` mais laisse volontairement passer `CREATE_DOCUMENT`
  vers le cerveau). Le second n'a jamais pu contredire le premier : le
  premier retournait déjà une réponse à l'appelant avant que le second ne
  soit même invoqué.
* **Fausse piste identifiée et écartée :** router systématiquement tout
  texte à mot-clé vers `interpretation.interpret(...)`, pour tout
  propriétaire — cela aurait ajouté un appel fournisseur payant réel pour
  les propriétaires **non éligibles**, qui n'en faisaient auparavant jamais
  aucun pour ce type de message (l'adaptateur simple
  `createKadiV1InterpretationRuntimeAdapter` n'a pas de couche
  déterministe propre ; il appelle systématiquement `brain.understand()`).
  Cela aurait violé « aucun appel fournisseur conversationnel pour un
  propriétaire non éligible ».
* **Correctif retenu :** le court-circuit déterministe de l'orchestrateur
  devient conditionnel à un nouveau paramètre optionnel du constructeur,
  `conversationalEligibilityGate` (fonction synchrone, locale, sans appel
  réseau — **réutilise** exactement la même fonction d'allowlist déjà
  injectée dans l'adaptateur conversationnel via
  `kadiV1ProductionOrchestratorComposition.js`, jamais une seconde
  vérification indépendante). `conversationalEligible` exige à la fois le
  gate ET `config.features.brain === true` (si le cerveau est désactivé,
  l'interprétation échouerait de toute façon en aval sans jamais démarrer
  de document — ne jamais court-circuiter dans cette combinaison). Par
  défaut (`conversationalEligibilityGate` non fourni — tout déploiement
  existant, tout test qui ne le câble pas), le comportement reste
  **strictement identique** à avant. Pour un propriétaire réellement
  éligible, le court-circuit est ignoré et le texte suit le chemin
  normal jusqu'à `interpretation.interpret(...)`, sans qu'aucun indice de
  type ne doive être transmis manuellement : la couche politique redérive
  le même indice via les mêmes fonctions. Si cette interprétation échoue
  ensuite (`interpreted.ok === false` — timeout, refus, sortie malformée,
  échec de validation ou de mapping), l'orchestrateur réutilise le
  `direct.intent`/`direct.document_type` **déjà calculé plus haut** pour
  retomber sur le chemin historique exact (`documents.start(...)`, même
  `idempotencyKey`) — zéro second appel fournisseur, un seul brouillon.
* **Décision de conception associée :** la logique de démarrage de
  brouillon vide a été extraite dans une fonction partagée
  `startBlankDocument(...)`, appelée à la fois par le court-circuit
  original (propriétaire non éligible) et par le nouveau repli
  post-échec (propriétaire éligible mais interprétation en échec) — un
  seul chemin de code, jamais deux implémentations divergentes du même
  comportement historique.
* **Commit ou migration :** fusionné dans `main` via
  [PR #10](https://github.com/GueswendeOue/kadi-backend/pull/10), commit de
  merge `c23ea3bfa58ddc95baff799e617da581279d8c1f`.
* **Preuve de validation :** `tests/kadiV1PrepareDocumentConversationalPath.test.js`
  (nouveau fichier dédié, 7 tests bout-en-bout avec adaptateur
  conversationnel réel, orchestrateur réel, pipeline document réel,
  comptage réel des appels fournisseur et des brouillons créés) : message
  simple, message avec client, message avec client et articles (Moussa +
  trois tables + 45 000 confirmés préservés), propriétaire non éligible
  (zéro appel fournisseur), timeout (un seul essai, chemin historique),
  sortie malformée (un seul essai, chemin historique), rejeu de webhook
  (une seule version appliquée). Complété par
  `tests/kadiV1ConversationOrchestrator.test.js` et
  `tests/kadiV1ProductionOrchestratorComposition.test.js` pour le câblage
  du gate. Suite complète : 1092/1092.
* **Prévention :** quand un flux a plusieurs points de décision
  déterministes distincts pour un même type d'intention (ici : deux
  fonctions de détection de mots-clés dans deux fichiers différents),
  vérifier explicitement **lequel s'exécute en premier** et si le second
  est réellement atteignable — ne jamais supposer qu'une couche
  soigneusement conçue plus bas dans la pile est effectivement invoquée
  sans tracer l'ordre d'exécution réel jusqu'au premier appelant. C'est
  exactement le type d'audit qui aurait dû faire partie de la mission de
  complétion précédente (fiche M) et ne l'a été qu'à la mission suivante.
* **Test de non-régression :** les 7 tests de
  `tests/kadiV1PrepareDocumentConversationalPath.test.js` listés ci-dessus,
  en particulier les tests 5 et 6 qui assertent explicitement
  `understandCallCount() === 1` après échec (aucun second appel) et
  `documentIds.size === 1` (au plus un brouillon).

## O. Revue adversariale indépendante confirmée : télémétrie de succès émise avant confirmation backend

* **Statut :** `MERGED_DEPLOYMENT_UNVERIFIED_DISABLED_NOT_ACTIVATED` (même
  fusion que les fiches L/M/N, PR #10, commit de merge
  `c23ea3bfa58ddc95baff799e617da581279d8c1f`).
* **Période :** revue adversariale indépendante en lecture seule (mission
  dédiée), suivie d'une mission de correction.
* **Symptôme confirmé :** `kadiV1ConversationalMultimodalRuntimeAdapter.js`
  émettait `conversational_draft_applied` (et le `conversational_route_selected`
  correspondant) **avant** que l'orchestrateur n'appelle
  `documents.apply(...)` / `documents.removeContent(...)` /
  `documents.changeDocumentType(...)` — c'est-à-dire avant même de savoir si
  la mutation allait réussir. Un échec de mutation (conflit de version,
  validation) laissait un événement affirmant un succès qui n'avait pas eu
  lieu ; un webhook rejoué produisait un second événement de succès pour une
  mutation qui, elle, n'était bien appliquée qu'une seule fois
  (`kadiV1SharedDocumentPipeline.js`'s `replayFor`).
* **Cause racine confirmée :** l'émission était placée dans la couche
  d'*interprétation* (qui décide QUOI faire) plutôt que dans la couche
  d'*application* (qui sait CE QUI a réellement été fait) — cette dernière
  est `kadiV1ConversationOrchestrator.js`, pas l'adaptateur conversationnel.
  Aggravant confirmé au passage : `kadiV1RuntimeAdapters.js`'s `apply(...)`
  perdait silencieusement le indicateur `duplicate` d'`applyBrainExtraction`
  en le faisant transiter par `advanceIfComplete(...)`, qui ne reçoit que le
  document et reconstruit un résultat `ok(document)` sans le propager — même
  s'il n'y avait pas eu ce problème d'observabilité, cette perte aurait
  empêché toute détection fiable de rejeu pour la voie `documents.apply`.
* **Correctif retenu :** `kadiV1ConversationalMultimodalRuntimeAdapter.js`
  n'émet plus jamais `conversational_draft_applied` — pour les trois issues
  qui remettent une mutation à l'appelant, il attache un sac de champs déjà
  filtrés et gelés (`observabilityFields`) au résultat renvoyé.
  `kadiV1ConversationOrchestrator.js` reçoit un nouveau paramètre optionnel
  injecté `conversationalObservabilityEmit` (construit une seule fois par
  `kadiV1ProductionOrchestratorComposition.js` via la même fabrique
  `createConversationalObservabilityEmitter(...)` que l'adaptateur utilise
  pour son propre `logger` — aucune télémétrie n'est construite dans
  l'orchestrateur lui-même) et n'émet `conversational_draft_applied`
  qu'après que le port backend correspondant a renvoyé `ok:true` avec
  `duplicate !== true`. `kadiV1RuntimeAdapters.js`'s `apply(...)` a été
  corrigé pour préserver `applied.duplicate` à travers
  `advanceIfComplete(...)`.
* **Décision de conception associée :** deux fabriques indépendantes de
  `createConversationalObservabilityEmitter(...)` existent désormais (une
  dans l'adaptateur, une dans l'orchestrateur — toutes deux construites par
  `kadiV1ProductionOrchestratorComposition.js` à partir du même `logger`
  structuré), plutôt qu'une seule instance partagée injectée aux deux — cela
  évite de changer l'API déjà testée de l'adaptateur (`logger` brut) tout en
  gardant toute construction de télémétrie hors de la logique métier de
  l'orchestrateur.
* **Corrections associées, même mission :** `kadiV1ConversationalMultimodalObservability.js`'s
  `INTENT_SET` omettait `"CHANGE_DOCUMENT_TYPE"`, forçant `intent: null`
  dans les événements de cette opération malgré `operation`/`document_type`
  corrects — corrigé par ajout de la valeur à la liste fermée.
  `kadiV1ConversationalMultimodalItemLookup.js`'s `normalize()` ne
  collationnait pas les espaces internes multiples et ne tolérait aucune
  variante plurielle simple — corrigé par collation d'espaces, normalisation
  des guillemets typographiques, et un pliage pluriel strictement limité à
  un seul mot entier comparé par égalité exacte (jamais par sous-chaîne, ce
  qui aurait pu faire correspondre un mot replié court à l'intérieur d'un
  mot plus long sans rapport, ex. « plats » → « plat » à l'intérieur de
  « plateau »).
* **Commit ou migration :** fusionné dans `main` via
  [PR #10](https://github.com/GueswendeOue/kadi-backend/pull/10), commit de
  merge `c23ea3bfa58ddc95baff799e617da581279d8c1f`.
* **Preuve de validation :**
  `tests/kadiV1ConversationalDraftAppliedObservability.test.js` (nouveau, 8
  tests : 3 échecs → zéro événement, 3 succès → un événement chacun, 1 rejeu
  → un seul événement au total, 1 clarification → zéro événement),
  `tests/kadiV1PrepareDocumentConversationalPath.test.js` (test 8, bout-en-
  bout avec pipeline réel), `tests/kadiV1RuntimeAdapters.test.js` (nouveau
  test prouvant `apply(...)` renvoie `duplicate:true` sur rejeu même après
  passage par `advanceIfComplete`), `tests/kadiV1ConversationalMultimodalObservability.test.js`
  (3 nouveaux tests CHANGE_DOCUMENT_TYPE), `tests/kadiV1ConversationalMultimodalItemLookup.test.js`
  (10 nouveaux tests espaces/pluriel/guillemets/non-régression ambiguïté).
  Suite complète : 1115/1115.
* **Prévention :** quand un événement de télémétrie porte le mot « success »
  ou équivalent dans son nom, vérifier explicitement à quelle étape du flux
  il est émis — avant ou après l'opération qu'il prétend décrire — et ne
  jamais supposer qu'« interprété avec succès » et « appliqué avec succès »
  sont le même événement. Vérifier aussi que tout indicateur de rejeu
  (`duplicate`) survit à chaque couche d'enveloppement du résultat, pas
  seulement à la couche qui le calcule.
* **Test de non-régression :** les 8 tests de
  `tests/kadiV1ConversationalDraftAppliedObservability.test.js`, en
  particulier les tests 1 à 3 (échec → zéro événement) et le test 7 (rejeu →
  un seul événement au total).

## P. PDF final présenté comme brouillon, proforma non distinguée, libellé reçu générique, taxe saisie en points de base

* **Statut : `MERGED_DEPLOYED_HEALTHY_CANARY_PENDING`**
  — correctifs écrits, testés localement, committés
  (`59f365e31737cf4f1b475ab0172322cdccac6932`), revus de façon
  adversariale, fusionnés via
  [PR #12](https://github.com/GueswendeOue/kadi-backend/pull/12) (commit de
  fusion `35358e5f301e821ac0ad8f6953c118146521878c`,
  2026-08-06T12:48:49Z) et **déployés sur Render par déclenchement manuel
  explicite** (`dep-d9q97g9t0dsc73cgisog`, `live` à
  2026-08-06T14:02:47.395578Z, commit vérifié
  `35358e5f301e821ac0ad8f6953c118146521878c`, boot propre,
  `KADI_V1_WEBHOOK_READY` : `ready:true, state:"READY",
  rollout_mode:"CANARY", blocker:null`). Migration Supabase
  `20260806010000_add_kadi_v1_finalization_identity` appliquée et
  vérifiée en distant sur le projet `cmhargmwkyskbobmkrcj` le
  2026-08-06T12:11:31Z (une seule fois, fonctions et permissions
  vérifiées en lecture seule contre la source de la migration, aucune
  ligne de donnée applicative modifiée). **Ne pas présenter ces
  correctifs comme validés en CANARY** tant qu'une session WhatsApp
  fraîche et la matrice CANARY complète n'ont pas eu lieu (voir
  [`KADI_RELEASE_CHECKLIST.md`](KADI_RELEASE_CHECKLIST.md)). Voir la
  sous-section « Fenêtre de compatibilité migration-avant-déploiement »
  ci-dessous pour un incident confirmé pendant cette livraison.
* **Période :** mission « KADI V1 PDF FINAL STATE, PROFORMA AND TAX FLOW —
  DIAGNOSE AND FIX », diagnostic CANARY remonté par le fondateur (5
  symptômes : PDF final affichant « BROUILLON »/date vide/pas de numéro ;
  FACTURE proforma affichée comme « FACTURE » simple ; reçu compact
  affichant « REÇU #BROUILLON »/« CLIENT » au lieu de « Payeur » ; blocage
  générique après « Terminer les articles » ; taxe saisie en points de base
  bruts au lieu d'un pourcentage).
* **Symptôme 1 confirmé — BROUILLON/date vide/pas de numéro sur un PDF livré
  comme final :** `kadiV1GenerationLifecycleService.js`'s `runConfirmation`
  passait au renderer (`finalGenerationService.generatePrivate`) le
  `preview` chargé depuis `kadi_v1_document_previews`, construit une seule
  fois par `kadiV1PreviewService.js`'s `buildPreviewData(document)` au
  moment `VERIFIED` — donc *avant* toute finalisation, quand
  `issued_at`/`document_number` valent encore `null` par construction. Le
  PDF livré à l'utilisateur était donc rendu à partir de cet aperçu figé,
  jamais régénéré avec l'identité réelle.
* **Cause racine confirmée, plus profonde :** `issued_at` n'était assigné
  que dans la transition `MARK_GENERATED` (`kadiV1DocumentDomain.js`), qui
  se produit *après* le rendu du PDF livré (`generatePrivate` →
  `markCaptured` → `promoteFinal` → **puis** `MARK_GENERATED`) — un
  problème d'ordonnancement structurel, pas un simple oubli d'affichage.
  `document_number` n'existait nulle part dans le code : colonne présente
  en base (`kadi_v1_documents.document_number`), jamais assignée par aucune
  fonction JS ni RPC SQL (`kadi_v1_persist_transition`,
  `kadi_v1_persist_generated_transition`) — confirmé par recherche
  exhaustive avant correction.
* **Correctif retenu :** `issued_at`/`document_number` sont désormais
  assignés dès la transition `START_GENERATION` (état
  `GENERATION_IN_PROGRESS`), donc *avant* le rendu du PDF livré, jamais à
  `MARK_GENERATED` — `kadiV1DocumentDomain.js`'s `transitionDocument`
  déplacé + nouveau générateur pur `generateDocumentNumber(documentType,
  documentId, issuedAtIso)` (déterministe : préfixe par type + horodatage
  compact + segment de `document_id`, aucun compteur/séquence externe donc
  aucune migration de schéma requise côté colonnes). `MARK_GENERATED`
  refuse désormais explicitement (`DOCUMENT_FINALIZATION_IDENTITY_MISSING`)
  toute tentative de finalisation sans ces deux champs déjà présents — c'est
  la porte de secours fermée exigée par la mission. `issued_at` reste
  produit exclusivement par l'horloge serveur injectée (jamais par
  l'appelant) — invariant inchangé, seulement déplacé une transition plus
  tôt ; `tests/kadiV1DocumentDomain.test.js`'s test dédié le prouve
  explicitement (une valeur `issued_at` fournie dans le payload est
  toujours ignorée). `kadiV1GenerationLifecycleService.js`'s
  `runConfirmation` construit désormais un clone du preview stocké avec
  `issued_at`/`document_number`/`invoice_kind` réels avant d'appeler le
  renderer — le renderer reçoit toujours la version finalisée, jamais
  l'aperçu figé.
* **Migration Supabase requise, écrite, appliquée et vérifiée en
  distant :**
  `supabase/migrations/20260806010000_add_kadi_v1_finalization_identity.sql`
  (copie identique `migrations/20260806_add_kadi_v1_finalization_identity.sql`)
  — remplace `kadi_v1_persist_transition` (`create or replace function`,
  aucune migration déjà appliquée modifiée) pour assigner
  `issued_at`/`document_number` dès `GENERATION_IN_PROGRESS` au lieu de
  `GENERATED`, via `clock_timestamp()` et un nouveau
  `kadi_v1_generate_document_number(...)` SQL déterministe — cette
  migration était **génuinement requise** : la RPC précédemment en place
  refusait explicitement (`KADI_V1_SERVER_FIELD_FORBIDDEN`) toute valeur
  `issued_at` non nulle envoyée par l'appelant pour un état autre que
  `GENERATED`, ce qui aurait bloqué le correctif JS seul. **Appliquée en
  distant le 2026-08-06 sur le projet `cmhargmwkyskbobmkrcj`** (mission
  dédiée, autorisation explicite), présente exactement une fois dans
  l'historique `supabase migration list`, historique distant par
  ailleurs inchangé. Corps déployé des deux fonctions et permissions
  (`service_role` uniquement) vérifiés en lecture seule (`supabase db
  dump -s public`) contre la source de la migration — correspondance
  exacte. Voir le runbook
  [`APPLY_SUPABASE_MIGRATION.md`](runbooks/APPLY_SUPABASE_MIGRATION.md)
  pour la procédure suivie.
* **Symptôme 2 confirmé — FACTURE proforma affichée comme « FACTURE »
  simple :** `invoice_kind` n'était jamais propagé au-delà du document lui-
  même : absent de `buildPreviewData`'s `structured_preview`, donc absent
  de `previewToDocData`'s `docData.type`, donc `pdf/kadiPdfCommon.js`'s
  `resolveRendererKey` (qui ne sélectionne `facture_proforma` que si
  `docData.type` contient littéralement « PRO FORMA ») ne pouvait jamais le
  sélectionner — le renderer proforma (`pdf/kadiPdfFactureProforma.js`,
  déjà correct et déjà titré « FACTURE PRO FORMA ») était simplement
  inatteignable. `document_type` reste `FACTURE` dans tous les cas — seul
  le choix de renderer et le titre changent selon `invoice_kind`, conforme
  à la règle produit verrouillée.
* **Correctif retenu :** `buildPreviewData` expose désormais
  `invoice_kind` pour FACTURE/DEVIS ; `previewToDocData` calcule
  `type: "FACTURE PRO FORMA"` uniquement quand `document_type === "FACTURE"
  && invoice_kind === "PROFORMA"`, sinon `document_type` inchangé (DEVIS
  n'est jamais concerné, `invoice_kind` n'existe pas pour ce type).
* **Symptôme 3 confirmé — reçu affichant « CLIENT » au lieu du payeur :**
  `pdf/kadiPdfRecuA4.js` et `pdf/kadiPdfRecuCompact.js` codaient en dur le
  libellé générique « Client »/« CLIENT » alors que la source de donnée
  (`docData.client`, alimentée par `data.payer`) était déjà correcte —
  seul le libellé affiché était faux. Le même bug de BROUILLON/date vide
  (symptôme 1) affecte le reçu de façon identique, même chemin partagé,
  aucune particularité RECU.
* **Correctif retenu :** libellé remplacé par « Payeur »/« PAYEUR » dans
  les deux formats.
* **Symptôme 4 (blocage générique après « Terminer les articles ») —
  diagnostic effectué, aucun bug de code trouvé dans le chemin
  FINISH_CONTENT → DOCUMENT_OPTIONS :** l'intégralité du chemin (validation
  de l'action, dispatch de commande, `finishContent` du domaine,
  `validateReply`/`consumeReply` de session, `nextFlowForReply`,
  `openAndSendFlow`) a été tracée pas à pas et est déjà entièrement testée
  et correcte. Un seul défaut réel trouvé et corrigé au passage :
  `suggestedDataForFlow` n'avait aucun cas pour `DOCUMENT_OPTIONS`, donc
  `current_summary` affichait toujours le texte d'exemple générique du
  Flow (« Aucune option particulière. ») au lieu d'un résumé réel des
  articles — corrigé en réutilisant `buildItemsSummary`. Le seul point de
  rejet fermé plausible restant, prouvé par lecture de code, est
  `openAndSendFlow`'s vérification du format de `config.flowIds.DOCUMENT_OPTIONS`
  (`KADI_V1_PRESENTER_FLOW_ID_MISSING`), qui remonte exactement comme le
  message générique observé — mais rien ne prouve, sans accès aux logs de
  production, que c'est la cause réelle en CANARY. **Ne pas conclure que la
  cause est confirmée** ; seule une vérification en conditions réelles
  (logs Render après déploiement) peut trancher entre une mauvaise
  configuration Render (`KADI_V1_FLOW_DOCUMENT_OPTIONS_ID`) et une autre
  cause encore non identifiée.
* **Symptôme 5 confirmé — taxe saisie en points de base bruts :**
  `flows/v1_draft/kadi_document_options_v1.json` demandait littéralement à
  l'utilisateur de taper « 1800 pour 18 % » — un utilisateur pouvait
  raisonnablement taper « 18 » en pensant exprimer 18 %, produisant en
  réalité une taxe de 0,18 %. Le calcul métier lui-même
  (`kadiV1DocumentDomain.js`'s `calculateCommonTotals`, `document.taxes`
  depuis `tax_rate_basis_points`) était déjà correct — seule l'unité
  demandée à l'utilisateur était fausse.
* **Correctif retenu :** le champ Flow local (non publié) devient
  `tax_rate_percent` (libellé « Taxe (%) », exemple « 18 pour 18 % »).
  `kadiV1FlowReplyRuntime.js`'s `normalizeTaxRateFields` accepte **les deux
  champs en fenêtre de transition** — voir la sous-section « Correctifs de
  revue » ci-dessous pour le détail exact, ajouté après la revue
  adversariale indépendante qui a identifié l'absence initiale de cette
  compatibilité comme un défaut bloquant.
* **Étape de publication future requise, non exécutée par cette mission :**
  le nouveau champ `tax_rate_percent` n'existe que dans le JSON canonique
  local (`flows/v1_draft/kadi_document_options_v1.json`) — le Flow Meta
  publié conserve l'ancien champ `tax_rate_basis_points`, ce qui reste
  accepté par le backend (voir ci-dessous) tant qu'une nouvelle version
  n'est pas explicitement publiée (mission non autorisée à le faire).
* **DEVIS et DECHARGE (MONEY/GOODS/DOCUMENT/OTHER) :** confirmés affectés
  par le même bug de BROUILLON/date/numéro que la FACTURE (chemin de
  finalisation entièrement partagé, aucune branche spécifique au type) —
  corrigés par le même correctif du symptôme 1. Aucune autre anomalie de
  libellé ou de contenu trouvée pour ces deux types. Aucune option de taxe
  n'est exposée ni acceptée pour RECU/DECHARGE (non concerné par
  `normalizeOptions`'s branche FACTURE/DEVIS).
* **Commit ou migration :** committé
  (`59f365e31737cf4f1b475ab0172322cdccac6932`), fusionné via
  [PR #12](https://github.com/GueswendeOue/kadi-backend/pull/12) et déployé
  (voir statut ci-dessus) — migration appliquée et vérifiée en distant (voir
  statut ci-dessus).
* **Preuve de validation :** `tests/kadiV1DocumentDomain.test.js` (identité
  de finalisation, porte fermée, préfixes par type, idempotence),
  `tests/kadiV1GenerationLifecycle.test.js` (le renderer reçoit l'identité
  finalisée réelle, pas l'aperçu figé ; reprise après échec réutilise
  exactement la même identité), `tests/kadiV1PreviewGeneration.test.js`
  (titres FACTURE/FACTURE PRO FORMA/DEVIS), `tests/kadiV1ReceiptJourney.test.js`
  (libellé Payeur), `tests/kadiV1FlowReplyRuntime.test.js` et
  `tests/kadiV1SharedDocumentPipeline.test.js` (conversion et bornes de
  taxe, exemple canonique 500 000 × 18 % = 90 000, total 590 000),
  `tests/kadiV1FinalizationIdentityMigration.test.js` (forme de la
  migration, y compris la parité du suffixe à 8 caractères). Suite
  complète : 1137/1137 avant la revue, revérifiée après les correctifs de
  revue ci-dessous.
* **Prévention :** quand un champ serveur (`issued_at`, `document_number`,
  toute identité de finalisation) est assigné à une transition d'état,
  vérifier explicitement à quel moment du pipeline le *rendu livré à
  l'utilisateur* est produit par rapport à cette transition — un rendu
  produit avant l'assignation restera figé sur l'ancienne valeur pour
  toujours, aucun correctif d'affichage ne peut compenser un ordonnancement
  incorrect. Quand un champ numérique est exposé à l'utilisateur dans un
  Flow, vérifier que l'unité demandée correspond à l'unité que l'utilisateur
  pense manipuler (pourcentage perçu vs représentation interne en points de
  base) plutôt que d'exposer directement la représentation de stockage.
* **Test de non-régression :** `tests/kadiV1GenerationLifecycle.test.js`'s
  « the renderer receives the finalized issued_at/document_number, never
  the stale pre-finalization placeholder » et
  `tests/kadiV1DocumentDomain.test.js`'s « MARK_GENERATED fails closed when
  issued_at/document_number are missing ».

### Correctifs de revue (revue adversariale indépendante, verdict initial `REVIEW_CHANGES_REQUIRED`)

Une revue adversariale indépendante en lecture seule a examiné le diff
complet de cette branche avant tout commit et a confirmé plusieurs défauts
réels, requérant une correction avant que cette branche puisse être
proposée à la fusion. Tous corrigés ci-dessous ; la branche a ensuite été
committée (`59f365e31737cf4f1b475ab0172322cdccac6932`), poussée, fusionnée
via [PR #12](https://github.com/GueswendeOue/kadi-backend/pull/12) (commit
de fusion `35358e5f301e821ac0ad8f6953c118146521878c`) et **déployée sur
Render** (voir statut en tête de fiche).

* **HIGH confirmé — incompatibilité totale avec le Flow Meta actuellement
  publié :** le correctif initial remplaçait entièrement
  `tax_rate_basis_points` par `tax_rate_percent` dans
  `ACTION_FIELDS.SAVE_OPTIONS`, ce qui aurait rejeté 100 % des soumissions
  `SAVE_OPTIONS` (FACTURE et DEVIS) dès le déploiement du backend, quel que
  soit l'ordre de publication avec le nouveau Flow Meta. **Corrigé :**
  `kadiV1FlowReplyRuntime.js`'s `normalizeTaxRateFields` accepte désormais
  les deux champs en fenêtre de transition — `tax_rate_percent` seul,
  `tax_rate_basis_points` seul (validé comme entier de points de base,
  > 0 et ≤ 10000, comportement legacy identique à avant cette mission), les
  deux présents et d'accord (accepté, une seule valeur persistée), les deux
  présents et en désaccord (rejet fermé explicite
  `KADI_V1_FLOW_REPLY_TAX_RATE_CONFLICT`, jamais de préférence silencieuse),
  les deux absents ou vides (aucune taxe). Un seul champ persisté au final :
  `tax_rate_basis_points`.
* **HIGH confirmé (au moment de la revue) — panne totale de la génération
  finale si le backend était déployé avant la migration :** la RPC
  `kadi_v1_persist_transition` alors appliquée en distant rejetait
  explicitement (`KADI_V1_SERVER_FIELD_FORBIDDEN`) tout `issued_at` non nul
  envoyé pour un état autre que `GENERATED` — donc déployer ce backend (qui
  envoie désormais un `issued_at` réel dès `GENERATION_IN_PROGRESS`) avant
  d'appliquer `20260806010000_add_kadi_v1_finalization_identity.sql` aurait
  cassé la génération finale pour tous les types de documents, tous les
  utilisateurs. **Aucun correctif de code ne pouvait éliminer cette
  contrainte d'ordre** — voir l'ordre de déploiement obligatoire documenté
  dans [`KADI_RELEASE_CHECKLIST.md`](KADI_RELEASE_CHECKLIST.md) et
  [`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md). **Ce risque précis
  (nouveau backend déployé avant la migration) ne s'est jamais matérialisé**
  — la migration a été appliquée en distant le 2026-08-06T12:11:31Z, avant
  toute fusion. **Mais appliquer la migration seule, sans déploiement
  immédiat du nouveau backend, a ouvert le risque inverse, réellement
  matérialisé — voir la sous-section « Fenêtre de compatibilité
  migration-avant-déploiement (2026-08-06) » ci-dessous.**

### Fenêtre de compatibilité migration-avant-déploiement (2026-08-06)

* **Statut : `CONFIRMED_AND_RESOLVED`.**
* **Symptôme/risque confirmé :** entre l'application de la migration
  (`2026-08-06T12:11:31Z`) et la fusion de la PR #12
  (`2026-08-06T12:48:49Z`), puis jusqu'au déploiement Render effectif
  (`live` à `2026-08-06T14:02:47.395578Z`), **l'ancien backend
  (`f95be84b98d3d9ad6308a6aebbc3e11590717ae2`) est resté servi par
  Render**, exposé à la migration déjà appliquée. Cette combinaison n'avait
  jamais été analysée avant cet incident — toute l'attention précédente
  portait sur l'ordre inverse (nouveau backend avant migration).
* **Cause racine confirmée :** l'ancien `kadiV1DocumentDomain.js` assignait
  un `issued_at` **frais** à chaque transition `MARK_GENERATED`, sans jamais
  réutiliser une valeur déjà persistée ; `kadiV1SupabaseDocumentRepository.js`
  (inchangé par cette PR) synchronise déjà `issued_at` depuis le résultat de
  **chaque** appel `persist_transition`, y compris `START_GENERATION`. Avec
  la migration appliquée, `START_GENERATION` assigne désormais un
  `issued_at` serveur dès `GENERATION_IN_PROGRESS` ; l'ancien backend
  récupérait donc cette valeur, puis l'écrasait par une valeur différente à
  `MARK_GENERATED` — la RPC migrée rejetait alors cet `issued_at`
  incohérent avec `KADI_V1_SERVER_FIELD_FORBIDDEN`, cassant la génération
  finale de tout type de document, pour tout utilisateur CANARY réel
  atteignant ce point, pendant toute la fenêtre.
* **Découverte :** identifiée par analyse de code adversariale (pas par
  incident rapporté) lors de la revue finale de PR #12, avant toute
  correction — voir la mission « FINAL GITHUB REVIEW BEFORE CONTROLLED
  MERGE ». Confirmée activement en cours pendant la fusion via
  vérification directe de l'API Render (`GET
  /v1/services/srv-d5a93m1r0fns73879big` → `autoDeploy:"no"`), qui a
  également révélé que **`kadi-backend` ne déploie jamais automatiquement
  sur fusion `main`** — hypothèse inverse tenue pour acquise dans ce
  document et dans `KADI_RELEASE_CHECKLIST.md` jusqu'à cette découverte, et
  corrigée partout où elle apparaissait.
* **Résolution :** déploiement manuel explicite déclenché
  (`dep-d9q97g9t0dsc73cgisog`, `2026-08-06T14:01:37.902341Z`), confirmé
  `live` sur le commit fusionné `35358e5f301e821ac0ad8f6953c118146521878c`
  à `2026-08-06T14:02:47.395578Z` — ancien déploiement
  `dep-d9ppc1lbedkc73e27klg` passé à `deactivated`. Boot propre vérifié,
  `KADI_V1_WEBHOOK_READY` sans blocage. **Fenêtre totale : environ 1h51.**
  Aucun document réel n'a été généré pour prouver la fermeture de bout en
  bout (interdit par la mission de vérification) — seule la matrice CANARY
  (étape 9 de `KADI_RELEASE_CHECKLIST.md`) le fera formellement.
* **Prévention :** la compatibilité entre backend et base de données doit
  toujours être vérifiée **dans les deux sens** avant toute migration
  « forward-only » assignant un nouveau comportement à un état déjà
  atteignable par le code actuellement déployé — pas seulement dans le sens
  habituel (nouveau code face à l'ancien schéma). Une fusion GitHub réussie
  ne doit jamais être interprétée comme une preuve de déploiement : seul
  l'état `live` des métadonnées Render, sur le commit exact attendu, en
  fait foi. `GET /health` ne suffit pas non plus (réponse statique sans
  identité de commit).
* **Test de non-régression :** aucun test automatisé ne peut couvrir un
  écart de configuration de plateforme (`autoDeploy`) — la prévention
  repose sur la procédure documentée dans
  [`runbooks/DEPLOY_CANARY.md`](runbooks/DEPLOY_CANARY.md) (vérification
  explicite du commit `live` avant de considérer un déploiement terminé),
  pas sur un test de code.
* **MEDIUM confirmé — troncature du suffixe SQL à 4 caractères au lieu de
  8 :** `lpad(string, length, fill)` en PostgreSQL **tronque** `string`
  quand il est déjà plus long que `length` — `lpad(right(id, 8), 4, '0')`
  tronquait donc silencieusement les 8 caractères extraits par `right(...)`
  à seulement 4, réduisant l'entropie du suffixe de ~32 à ~16 bits côté
  Supabase, en désaccord avec la version JavaScript. **Corrigé :** cible de
  `lpad` changée de `4` à `8` dans les deux copies de migration (toujours
  byte-identiques) ; `generateDocumentNumber` (JS) aligné de la même façon
  (`padStart(8, "0")` au lieu de `padStart(4, "0")`) pour que les deux
  implémentations produisent toujours exactement 8 caractères, jamais
  moins. Test resserré : tolérance `{4,8}` remplacée par `{8}` partout, et
  un test dédié détecte spécifiquement la régression `lpad(..., 4, ...)`.
* **MEDIUM confirmé — l'invariant « assigné une seule fois » ne vivait que
  dans la couche dépôt/SQL, pas dans le domaine :** la branche
  `START_GENERATION` de `transitionDocument` recalculait un `issued_at`/
  `document_number` neuf à chaque appel, sans condition — seule la couche
  dépôt (JS in-memory et RPC SQL) empêchait, en aval, qu'un second appel
  n'écrase la valeur déjà persistée. **Corrigé :** `START_GENERATION`
  vérifie désormais explicitement l'état existant du document lui-même :
  identité déjà présente (les deux champs) → réutilisée inchangée, sans
  recalcul ; identité absente (les deux champs) → générée ; identité
  partielle (un seul des deux champs, état incohérent) → échec fermé
  explicite `DOCUMENT_FINALIZATION_IDENTITY_CORRUPT`. L'invariant vit
  désormais dans le domaine lui-même, pas seulement dans les couches en
  aval qui le respectaient déjà par ailleurs.
* **Défaut d'architecture découvert pendant l'écriture du test requis par
  la revue, désormais corrigé — voir fiche Q ci-dessous :** en tentant
  d'écrire le test « échec du rendu → nouvelle tentative → même identité »
  exactement comme demandé par la revue, il est apparu que la machine
  d'état ne permettait alors aucune reprise pour un échec survenant
  strictement au niveau du rendu/stockage privé (avant capture). Ce défaut
  préexistait à cette mission (présent avant `8718e646...` déjà) ; fiche Q
  documente le correctif complet.
* **Ordre de déploiement obligatoire, documenté ; étape 1 (migration
  appliquée et vérifiée en distant) désormais exécutée par une mission
  dédiée le 2026-08-06 :** voir
  [`KADI_RELEASE_CHECKLIST.md`](KADI_RELEASE_CHECKLIST.md) pour les étapes
  restantes (revue finale, fusion, déploiement, publication Meta, CANARY).

## Q. Reprise de génération après échec du rendu/stockage privé, avant capture

* **Statut :** correctif écrit, testé localement, committé
  (`59f365e31737cf4f1b475ab0172322cdccac6932`), fusionné via
  [PR #12](https://github.com/GueswendeOue/kadi-backend/pull/12) (commit de
  fusion `35358e5f301e821ac0ad8f6953c118146521878c`) et **déployé sur
  Render** (`live` à 2026-08-06T14:02:47.395578Z) — pas encore validé par
  une matrice CANARY fraîche.
* **Symptôme confirmé :** un document dont le rendu final échoue (erreur du
  renderer ou du stockage privé) était laissé en `RECOVERABLE_FAILURE`,
  crédit relâché, identité (`issued_at`/`document_number`) déjà réservée —
  mais **sans aucun chemin de reprise fonctionnel**. `RESUME` ramène
  correctement le document à `GENERATION_IN_PROGRESS` (son `resume_state`
  au moment de l'échec), mais cet état n'autorise ensuite que
  `MARK_GENERATED`, `RECORD_RECOVERABLE_FAILURE` ou `CANCEL` — aucune
  transition ne permet de relancer un rendu. `resumeGeneration` existant ne
  gérait que les échecs survenant *après* un rendu déjà validé (tentative
  `CAPTURED`/`PROMOTED`), renvoyant `GENERATION_RECONFIRMATION_REQUIRED`
  pour une tentative dont le statut restait `RECOVERABLE_FAILURE` (valeur
  que `releaseAndFail` assigne explicitement à la ligne d'attempt — pas
  `STARTED` comme on pourrait le supposer en lisant seulement
  `generatePrivate`).
* **Cause racine confirmée :** absence de tout chemin de service reliant
  l'état document `RECOVERABLE_FAILURE` (résumable) à une nouvelle tentative
  de rendu — un simple oubli fonctionnel plutôt qu'une contrainte de
  conception délibérée.
* **Correctif retenu :** nouvelle fonction
  `kadiV1GenerationLifecycleService.js`'s `retryFailedGeneration({quoteId,
  ownerWaId, documentVersion, idempotencyKey})`, sérialisée par la même
  file `serializeConfirmation(quoteId, ...)` que `confirmGeneration`
  (protection de concurrence identique). Aucun nouvel événement de domaine
  ajouté — réutilise `DOCUMENT_EVENTS.RESUME`, déjà narrowly-scoped et déjà
  utilisé par `resumeGeneration` pour un but équivalent (« reprendre depuis
  un échec enregistré ») ; un nouvel événement dédié aurait dupliqué
  exactement la même transition de domaine sans différence sémantique.
  Réutilise aussi la même ligne `kadi_v1_generation_attempts` (même
  `generation_attempt_id`) plutôt que d'en créer une nouvelle — un index
  unique existe sur `quote_id`, une seconde ligne pour le même devis serait
  de toute façon rejetée ; seuls `reservation_id`/`started_at`/`status` sont
  mis à jour dessus via `updateGenerationAttempt`, sans toucher à son
  identité. `issued_at`/`document_number` ne sont jamais régénérés : `RESUME`
  ne les touche pas et `START_GENERATION` n'est jamais rappelé — la
  réutilisation est structurelle (prouvée par test), pas seulement
  affirmée.
* **Conditions d'éligibilité, toutes vérifiées avant toute mutation :**
  propriétaire correspondant ; tentative de génération existante avec
  statut exactement `RECOVERABLE_FAILURE` (pas `STARTED`,
  `PDF_VALIDATED`, `CAPTURED`, `PROMOTED` ni `CANCELLED`) ; document dans
  l'état exact `RECOVERABLE_FAILURE` ; `issued_at`/`document_number`
  complets tous les deux (jamais un seul des deux — `GENERATION_RETRY_NOT_ELIGIBLE`
  sinon) ; `documentVersion` fourni correspondant exactement à la version
  persistée (`DOCUMENT_VERSION_CONFLICT` sinon) ; devis `ACTIVE` et lié au
  même document ; aperçu retrouvable.
* **Sécurité crédit/artefact/livraison :** nouvelle réservation créée
  uniquement via `walletReservationService.reserveCredits` existant (même
  politique que la confirmation initiale) ; un seul rendu, une seule
  capture, une seule promotion, une seule livraison — le pipeline exact de
  `completeAfterCapture`/`deliverFinal` déjà testé est réutilisé tel quel,
  aucune nouvelle logique de capture/promotion/livraison écrite. Un rejeu
  du même idempotencyKey après succès, ou une tentative concurrente,
  échouent tous deux proprement (`GENERATION_RETRY_NOT_ELIGIBLE`) sans
  second débit, second rendu, deuxième artefact ni deuxième livraison — la
  tentative n'est plus `RECOVERABLE_FAILURE` dès la première reprise
  réussie ou en cours.
* **Sémantique de l'identité réservée (historique) :** confirmée déjà
  correcte, aucun changement nécessaire — `kadiV1HistoryService.js`'s
  `listProjection` expose `status` sans transformation (`RECOVERABLE_FAILURE`
  reste visible tel quel, jamais confondu avec `GENERATED`/`DELIVERED`) et
  `has_final_file` reste `false` tant qu'aucun fichier final n'est
  promu — un document encore en échec récupérable n'est donc jamais
  présenté comme généré avec succès dans l'historique, même s'il porte déjà
  un `document_number`/`issued_at` réels.
* **Commit ou migration :** committé
  (`59f365e31737cf4f1b475ab0172322cdccac6932`), fusionné via
  [PR #12](https://github.com/GueswendeOue/kadi-backend/pull/12) et déployé
  (voir statut ci-dessus).
* **Preuve de validation :** `tests/kadiV1GenerationLifecycle.test.js` —
  neuf nouveaux tests couvrant le scénario complet en 19 étapes (échec du
  rendu → identité réservée → reprise → même identité réutilisée →
  exactement une capture/promotion/livraison → rejeu sans effet), les
  reprises concurrentes, l'identité partielle, l'état non éligible, la
  reprise après capture déjà effectuée, la reprise après succès complet, et
  la version périmée. Suite complète : voir section TESTS du rapport de
  mission.
* **Prévention :** avant de conclure qu'un chemin de reprise « fonctionne
  déjà » en lisant seulement la fonction qui échoue (ici `generatePrivate`),
  vérifier explicitement ce que fait l'appelant en cas d'échec — ici
  `releaseAndFail` change le statut de la tentative vers
  `RECOVERABLE_FAILURE`, une transition non visible depuis `generatePrivate`
  seul. Toujours tracer le chemin complet d'erreur jusqu'à son dernier
  effet de bord avant de concevoir un correctif qui en dépend.
* **Test de non-régression :** `tests/kadiV1GenerationLifecycle.test.js`'s
  « renderer failure then retryFailedGeneration: same identity reused,
  exactly one capture/promotion/delivery, replay of the successful retry is
  a no-op ».

### Correctifs de revue finale (revue adversariale indépendante finale, verdict initial `FINAL_REVIEW_CHANGES_REQUIRED`)

* **HIGH confirmé — `retryFailedGeneration` fusionné mais inatteignable :**
  aucun appelant réel (webhook, presenter, dispatch de commande) n'invoquait
  la fonction, seulement les tests. **Corrigé :** nouvelle fonction
  `confirmOrRetryGeneration(command)` dans
  `kadiV1GenerationLifecycleService.js` — décide entre le chemin normal et
  la reprise de rendu à partir du seul état persisté (aucune mutation dans
  la décision elle-même), puis délègue à exactement l'une des deux
  fonctions existantes, sans dupliquer leur logique.
  `kadiV1RuntimeAdapters.js`'s `createKadiV1GenerationRuntimeAdapter`
  appelle désormais `confirmOrRetryGeneration` au lieu de
  `confirmGeneration` — c'est-à-dire que **la même action `CONFIRM_GENERATION`,
  déjà dispatchée par `kadiV1FlowCommandRuntime.js` vers ce même adaptateur,
  déclenche maintenant la reprise transparente**, sans nouveau nom
  d'action, sans nouveau Flow Meta, sans nouvelle variable Render. Preuve
  bout-en-bout à travers la composition réelle (jamais un appel direct à
  `retryFailedGeneration`) : `tests/kadiV1ReleaseRecoveryE2E.test.js`, un
  fichier préexistant qui construit `kadiV1FlowCommandRuntime` +
  `kadiV1FlowReplyRuntime` + `kadiV1GenerationRuntimeAdapter` exactement
  comme `kadiV1ProductionBootstrap.js` le fait.
* **Bug confirmé et corrigé pendant l'écriture de cette preuve bout-en-bout :**
  `runRetryFailedGeneration`'s réattachement de la ligne d'attempt existante
  (`updateGenerationAttempt`) ne mettait à jour que
  `status`/`reservation_id`/`started_at`, jamais `confirmation_key` — un
  rejeu ultérieur de cette reprise (webhook dupliqué, ou une nouvelle
  confirmation normale une fois le document `DELIVERED`) retombait alors
  sur `confirmGeneration`'s détection de doublon, qui comparait
  l'`idempotencyKey` du rejeu à l'ancien `confirmation_key` — resté celui
  de la *première* confirmation échouée — et rejetait à tort avec
  `GENERATION_CONFIRMATION_CONFLICT` au lieu de reconnaître un doublon
  bénin. **Corrigé :** `confirmation_key` est désormais mis à jour vers
  l'`idempotencyKey` de la reprise dans le même appel
  `updateGenerationAttempt`.
* **MEDIUM confirmé — `resumeGeneration` mutait avant de vérifier son
  éligibilité :** appelait `persistEvent(RESUME, ...)` (persisté
  immédiatement) avant même de savoir si `attempt.status` était un état
  qu'elle savait continuer — une tentative `RECOVERABLE_FAILURE` (celle que
  `retryFailedGeneration` gère) était donc absorbée : le document passait à
  `GENERATION_IN_PROGRESS`, `recoverable_failure` était effacé, puis la
  fonction échouait quand même (`GENERATION_RECONFIRMATION_REQUIRED`) —
  laissant le document bloqué sans route de retour vers aucun des deux
  chemins de reprise. **Corrigé :** l'éligibilité (statut d'attempt
  `CAPTURED`/`PROMOTED`, ou `PDF_VALIDATED` avec réservation réellement
  `CAPTURED`) est désormais entièrement décidée avant tout appel à
  `RESUME` ; tout le reste échoue proprement, sans aucune mutation.
  L'appel manuel redondant à `markCaptured` a aussi été retiré :
  `completeAfterCapture` l'appelle déjà lui-même, de façon idempotente.
* **MEDIUM confirmé — `document.status`/`attempt.status` seuls ne
  suffisaient pas à prouver l'éligibilité de reprise :** un
  `RECOVERABLE_FAILURE` enregistré à une étape sans rapport (ex. pendant
  `COLLECTING`) aurait pu, en théorie, atteindre le chemin de reprise du
  rendu si une ligne d'attempt correspondante existait. **Corrigé :**
  `retryFailedGeneration` exige désormais explicitement
  `document.recoverable_failure?.resume_state === "GENERATION_IN_PROGRESS"`,
  en plus de `document.status`/`attempt.status`.
* **Message utilisateur :** `kadiV1WebhookRuntime.js`'s `recover(...)`
  choisit désormais un texte spécifique — « Le document n'a pas pu être
  généré. Vous pouvez réessayer sans perdre de crédit. » — pour la liste
  fermée des codes d'échec provenant exactement de
  `kadiV1FinalGenerationService.js`'s `generatePrivate`
  (`FINAL_RENDER_FAILED`, `FINAL_PDF_INVALID`, `FINAL_PDF_CORRUPT`,
  `FINAL_PDF_PAGE_COUNT_MISMATCH`, `FINAL_STORAGE_FAILED`,
  `FINAL_STORAGE_NOT_PRIVATE`) ; tout autre échec récupérable conserve le
  texte générique existant inchangé. Aucun terme technique exposé
  (`renderer`, `repository`, `generation attempt`, `issued_at`,
  `document_number`). Succès de reprise : message de succès existant
  inchangé, aucune nouvelle logique de présentation.
* **Statut de la navigation options/taxe, sans lien avec cette fiche :**
  `UNRESOLVED_PRODUCTION_DIAGNOSIS_REQUIRED` — voir
  [`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md). N'a reçu aucune
  correction de code dans cette mission ni dans aucune des précédentes ;
  seule une lacune cosmétique adjacente (résumé d'options manquant) a été
  corrigée, jamais présentée comme la cause du blocage rapporté.
* **Preuve de validation (revue finale) :**
  `tests/kadiV1GenerationLifecycle.test.js` (ordre de mutation de
  `resumeGeneration`, garde `resume_state`), `tests/kadiV1ReleaseRecoveryE2E.test.js`
  (reprise atteinte par l'action de confirmation réelle, chemin normal
  inchangé, échec non lié bloqué, propriétaire différent bloqué),
  `tests/kadiV1WebhookRuntime.test.js` (message utilisateur spécifique vs
  générique). Suite complète : voir section TESTS du rapport de mission.
* **Committé (`59f365e31737cf4f1b475ab0172322cdccac6932`), poussé, fusionné
  via [PR #12](https://github.com/GueswendeOue/kadi-backend/pull/12) (commit
  de fusion `35358e5f301e821ac0ad8f6953c118146521878c`) et déployé sur
  Render (`live` à 2026-08-06T14:02:47.395578Z) ; aucun autre système
  distant modifié (Meta, environnement Render).**

## R. Première génération CANARY par le fondateur : livraison WhatsApp échouée après capture, `retryDelivery` inatteignable, noms de fichiers finaux génériques

* **Statut : `IMPLEMENTED_REVIEWED_NOT_DEPLOYED`** — branche
  `fix/kadi-v1-delivery-retry-and-final-filenames-r0`, correctif écrit,
  testé localement (1219/1219), **non fusionné, non déployé**. Ne pas
  revendiquer de correction de production tant qu'un déploiement et une
  vraie reprise de livraison réussie n'ont pas été observés.
* **Période :** mission « KADI V1 OWNER CANARY A — CONFIRM_GENERATION
  FAILURE DIAGNOSIS » (diagnostic en lecture seule, 2026-08-06T19:03–19:08Z)
  suivie de « KADI V1 — DELIVERY RETRY AND UNIQUE FINAL FILENAMES R0 »
  (correctif).
* **Symptôme confirmé :** le tout premier document CANARY généré
  directement par le fondateur (FACTURE, 10 000 FCFA, taxe 18 %) a
  intégralement réussi sa navigation `DOCUMENT_OPTIONS` → `SAVE_OPTIONS` →
  `DOCUMENT_REVIEW` → `DOCUMENT_PREVIEW` → `GENERATION_CONFIRMATION`,
  confirmé directement par les logs Render (séquence complète
  `KADI_V1_PRESENTER`/`KADI_V1_WEBHOOK_DECISION`, aucun rejet). Le document
  a atteint `START_GENERATION` → rendu privé → capture du crédit (une
  seule fois) → promotion du fichier final → `MARK_GENERATED`, avec
  identité complète (`issued_at`, `document_number` bien formés). **La
  livraison WhatsApp du PDF a ensuite échoué** avec
  `DELIVERY_DESTINATION_MISMATCH`, laissant le document en
  `RECOVERABLE_FAILURE` (`code: DELIVERY_FAILED`,
  `resume_state: GENERATED`) — crédit capturé, PDF prêt, jamais reçu par
  l'utilisateur.
* **Cause racine confirmée (déclencheur exact) :** le fournisseur de
  livraison WhatsApp (`kadiV1ProductionInfrastructure.js`) relit
  `owner_wa_id` en base au moment de la livraison et compare son hachage à
  la référence de destination enregistrée sur la tentative de livraison. Un
  recalcul indépendant, effectué après coup avec le même `owner_wa_id`,
  produit un hachage **identique** à la référence stockée — ce qui exclut
  une incohérence de données persistante (mauvais numéro stocké, document
  associé au mauvais propriétaire). L'explication la mieux étayée par les
  preuves disponibles est un échec transitoire de la lecture de
  vérification elle-même (réseau/Supabase), que le code traitait alors
  sous le même code d'erreur qu'une incohérence confirmée — voir le point
  suivant.
* **Défaut de granularité confirmé :** `DELIVERY_DESTINATION_MISMATCH`
  recouvrait indistinctement trois causes différentes dans
  `kadiV1ProductionInfrastructure.js`'s `deliverDocument` : une erreur de
  lecture Supabase, un `owner_wa_id` absent/invalide après lecture, et une
  divergence de hachage réellement confirmée. Impossible, après coup, de
  distinguer laquelle s'était produite. **Corrigé :** les deux premiers cas
  retournent désormais `DELIVERY_DESTINATION_LOOKUP_FAILED` ; seule une
  lecture réussie avec un hachage réellement différent retourne
  `DELIVERY_DESTINATION_MISMATCH`. Les deux échouent fermé de façon
  identique (aucune livraison n'a lieu dans un cas comme dans l'autre) ;
  seul le code enregistré pour le diagnostic diffère.
* **Défaut confirmé, préexistant à cette mission — `retryDelivery`
  implémenté mais inatteignable :** `kadiV1GenerationLifecycleService.js`
  exposait déjà une fonction `retryDelivery`, et
  `kadiV1HistoryService.js`'s `actionsFor` calculait déjà un libellé
  d'action `RETRY_DELIVERY` pour exactement cet état (fichier final présent
  + livraison `RECOVERABLE_FAILURE`) — mais `RETRY_DELIVERY` n'apparaissait
  nulle part ailleurs dans le code de production : aucune action Flow,
  aucun routage de commande, aucune correspondance de présentateur ne
  consommait ce libellé. Un utilisateur réel n'avait strictement aucun
  moyen de déclencher cette fonction — recherche exhaustive confirmée avant
  correction, exactement le même schéma « implémenté mais inatteignable »
  déjà rencontré et corrigé pour `retryFailedGeneration` avant la fusion de
  la PR #12 (voir fiche P), mais jamais étendu au cas de la livraison.
* **Correctif retenu :**
  - `kadiV1GenerationLifecycleService.js`'s `retryDelivery` réécrit :
    n'accepte plus que `documentId`/`ownerWaId`/`idempotencyKey` du
    demandeur (jamais de `quoteId`, `deliveryAttemptId`, référence de
    destination ou montant) ; résout tout côté serveur (devis via
    `document.generation_quote.quote_id`, tentative de génération,
    réservation, fichier final correspondant à la version active, tentative
    de livraison via un nouveau
    `findDeliveryAttemptByFinalFileId`) ; exige `status=RECOVERABLE_FAILURE`,
    `recoverable_failure.code=DELIVERY_FAILED`,
    `recoverable_failure.resume_state=GENERATED`, identité complète,
    réservation `CAPTURED`, tentative `PROMOTED` — toutes les conditions
    vérifiées avant toute mutation. Une livraison déjà réussie (rejeu) est
    traitée de façon idempotente et sûre, indépendamment de l'état courant
    du document.
  - Exposé par **un bouton WhatsApp interactif simple** (« Réenvoyer le
    PDF », `sendButtons` déjà existant dans `whatsappApi.js`) — aucun
    nouveau Flow Meta créé ni publié, conformément à la préférence de la
    mission. Intercepté dans `kadiV1WebhookRuntime.js` **avant** la
    vérification `isNfmReply` et avant le routage `MENU_ACTION` général,
    donc totalement découplé de `kadiV1ConversationOrchestrator.js` (le
    système conversationnel, non activé) et de `kadiV1FlowReplyRuntime.js`
    (qui exige une session Flow qu'un bouton simple n'a jamais).
  - Protection de concurrence au-delà de la file en mémoire :
    `kadiV1DeliveryService.js`'s `execute` réclame désormais atomiquement la
    tentative de livraison (`PENDING`/`RECOVERABLE_FAILURE` → `IN_PROGRESS`,
    mise à jour conditionnelle avec statut attendu) **avant** tout appel au
    fournisseur — le perdant d'une course apprend l'échec de sa
    réclamation sans jamais appeler le fournisseur une seconde fois, fermant
    une fenêtre de double envoi réelle qui existait déjà dans le code avant
    cette mission.
* **Noms de fichiers finaux uniques :** `kadiV1FinalFilename.js` (nouveau,
  fonction pure) remplace les noms génériques `facture.pdf`/`recu.pdf`
  (écrasés à chaque nouveau document) par
  `<type>_<document_number>.pdf` (`facture-proforma_...` pour les
  proforma), recalculé de façon identique partout où il est utilisé
  (livraison WhatsApp, reprise de livraison, projection
  historique/téléchargement `kadiV1HistoryService.js`'s `safeFinalFile`) —
  jamais stocké de façon redondante, donc jamais susceptible de diverger
  entre les couches. Les documents déjà livrés avant ce correctif
  conservent leur nom historique, non renommé rétroactivement.
* **Commit ou migration :** aucune migration nécessaire (aucun nouveau
  champ de base de données — le nom de fichier est calculé, jamais
  stocké ; la concurrence de livraison utilise le mécanisme de révision
  déjà existant sur `kadi_v1_delivery_attempts`). Code écrit sur la branche
  `fix/kadi-v1-delivery-retry-and-final-filenames-r0`, non encore fusionné.
* **Preuve de validation :** `tests/kadiV1FinalFilename.test.js` (matrice
  complète des noms canoniques), `tests/kadiV1DeliveryProvider.test.js`
  (distinction lookup-failed/mismatch, nom de fichier livré),
  `tests/kadiV1DeliveryRetryRuntime.test.js`,
  `tests/kadiV1DeliveryRetryEligibility.test.js` (chaque rejet
  d'éligibilité, idempotence sur rejeu, concurrence réelle via
  `Promise.all` prouvant une seule livraison effective, chemin de
  production complet via le vrai `kadiV1WebhookRuntime.js`), plus les
  suites existantes mises à jour pour la nouvelle exigence `sendButtons` du
  présentateur et le nouveau port `deliveryRetryRuntime`
  (`kadiV1GenerationLifecycle`, `kadiV1ReleaseRecoveryE2E`,
  `kadiV1WebhookRuntime`, `kadiV1ProductionPresenter`,
  `kadiV1ProductionComposition`, `kadiV1ProductionMediaResolver`,
  `kadiV1ProductionBootstrap`, `kadiV1RuntimeAdapters`,
  `kadiV1HistorySearch`, `kadiV1DraftExposureGuards`,
  `kadiV1OnboardingProfileCompletion`, `kadiV1PreviewGeneration`). Suite
  complète : 1219/1219, `git diff --check` propre.
* **Prévention :** quand une fonction de reprise existe dans un service
  métier, vérifier systématiquement qu'elle est **atteignable par une
  action réelle** avant de la considérer comme un filet de sécurité — un
  libellé d'action calculé dans une projection (ici `RETRY_DELIVERY` dans
  `kadiV1HistoryService.js`) n'est qu'une donnée descriptive tant qu'aucun
  routage réel ne la consomme. Quand un code d'erreur recouvre à la fois
  « je n'ai pas pu vérifier » et « j'ai vérifié et c'est différent »,
  scinder les deux : un incident réel a directement rendu cette ambiguïté
  visible et coûteuse à diagnostiquer.
* **Non inclus dans cette correction, planifié séparément :**
  `GUIDED_ENTRY_BUTTON_NOT_IMPLEMENTED` — observé pendant ce même
  diagnostic (envoyer « Créer une facture » ouvre une demande de texte
  libre sans bouton de parcours guidé), sans lien avec l'échec de
  livraison, non corrigé dans cette mission ; appartient à une future
  mission hybride guidé/conversationnel.
