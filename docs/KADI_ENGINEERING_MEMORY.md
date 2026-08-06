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
