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

### Suite de revue finale : reprise depuis l'historique et sécurité de l'issue de livraison (2026-08-06)

* **Statut : `IMPLEMENTED_REVIEWED_NOT_DEPLOYED`** — même branche, un
  second commit, toujours non fusionné, non déployé, migrations écrites
  mais **non appliquées à distance**.
* **Trois constats confirmés par la revue adversariale indépendante de la
  R0 ci-dessus, tous corrigés dans ce suivi :**
  1. **Le document CANARY réel du fondateur (`FA-20260806190633-A0EAC605`)
     restait inatteignable même après la R0** : le libellé `RETRY_DELIVERY`
     calculé par `kadiV1HistoryService.js` n'était consommé par aucun
     présentateur/webhook en dehors du tout premier échec — rouvrir le
     document depuis l'historique affichait encore le texte générique
     « Le document est ouvert. ». **Corrigé :** `kadiV1ProductionPresenter.js`'s
     `presentFlowReply` détecte désormais `action === "OPEN_DOCUMENT"` et,
     quand `summary.actions` contient `RETRY_DELIVERY`, affiche le bon
     bouton au lieu du texte générique.
  2. **Une tentative de livraison peut rester bloquée en `IN_PROGRESS`
     indéfiniment** si l'appel fournisseur a eu lieu (ou était sur le point
     d'avoir lieu) mais que l'écriture de finalisation échoue ou que le
     processus s'interrompt — prouvé de façon empirique par une sonde de
     diagnostic locale, hors dépôt, avant tout correctif.
  3. **Une expiration après un envoi WhatsApp potentiellement réussi**
     pouvait mener à un renvoi externe incontrôlé, faute d'idempotence
     côté fournisseur pour connaître l'issue réelle.
* **Défaut de schéma supplémentaire découvert pendant le diagnostic en
  lecture seule (avant tout correctif de code) :** la contrainte `check`
  de `kadi_v1_delivery_attempts.status` (migration
  `20260803022133_add_kadi_v1_generation_lifecycle.sql`) n'autorisait que
  `'PENDING'`, `'DELIVERED'`, `'RECOVERABLE_FAILURE'` — **`'IN_PROGRESS'`
  n'y figurait pas**, alors que le mécanisme de capture atomique de la R0
  l'écrit déjà. Contre la base de test en mémoire cela passait silencieusement ;
  contre la vraie base Postgres, chaque capture aurait échoué avec
  `check_violation` (23514) avant même d'atteindre le fournisseur. Aucune
  colonne d'horodatage de capture (`claimed_at`) n'existait non plus.
  **Corrigé sans invention d'un minuteur en mémoire :** `claim()` dans
  `kadiV1DeliveryService.js` réutilise désormais la colonne déjà existante
  `last_attempt_at`, en l'écrivant au moment même de la capture (et non
  plus seulement à la finalisation) — un horodatage réel, persisté,
  utilisable par plusieurs instances et survivant à un redémarrage.
* **Deux migrations forward-only écrites, non appliquées à distance,
  autorisation séparée requise avant tout déploiement de cette PR :**
  - `supabase/migrations/20260806020000_add_kadi_v1_delivery_attempt_in_progress_status.sql`
    — élargit la contrainte `status` pour autoriser `'IN_PROGRESS'`.
  - `supabase/migrations/20260806030000_add_kadi_v1_delivery_outcome_to_history_bundle.sql`
    — `create or replace function public.kadi_v1_owned_history_bundle` pour
    exposer `last_error_code` dans l'objet `delivery` (déjà réservé
    `service_role` uniquement, portée inchangée), nécessaire pour
    distinguer un échec confirmé d'une issue inconnue depuis l'historique.
* **Modèle à trois issues introduit, sans nouvelle valeur d'énumération
  `status` pour la partie « issue inconnue »** : `CONFIRMED_FAILURE` et
  `OUTCOME_UNKNOWN` réutilisent tous deux `status = 'RECOVERABLE_FAILURE'`
  côté base ; seul `last_error_code = 'DELIVERY_OUTCOME_UNKNOWN'` distingue
  la seconde — évite d'élargir encore la contrainte `status`. Le
  fournisseur WhatsApp actuel (`kadiV1ProductionInfrastructure.js`'s
  `getDeliveryStatus`) ne renvoie honnêtement que `UNKNOWN` en toute
  circonstance : aucune preuve de succès/échec n'est aujourd'hui
  disponible après coup. La réconciliation consulte quand même ce point de
  vérité en premier (pour honorer sans changement de code une future
  capacité réelle du fournisseur), mais ne conclut **jamais** à un succès
  confirmé sans confirmation positive — en pratique, aujourd'hui, toute
  reconciliation d'une capture expirée aboutit à `OUTCOME_UNKNOWN`, jamais
  à un renvoi silencieux.
* **Renvoi d'une issue inconnue : confirmation explicite à deux temps,
  jamais automatique.** `kadiV1GenerationLifecycleService.js`'s
  `runRetryDelivery` accepte désormais un paramètre `confirmed` : sur une
  tentative `RECOVERABLE_FAILURE`/`DELIVERY_OUTCOME_UNKNOWN`, une première
  pression sur le bouton renvoie
  `DELIVERY_OUTCOME_UNKNOWN_CONFIRMATION_REQUIRED` sans jamais appeler le
  fournisseur ; seule une seconde pression, sur un bouton distinct
  (`RESEND_UNKNOWN_DELIVERY:<id>`, jamais le même identifiant que
  `RETRY_DELIVERY:<id>`), déclenche réellement l'envoi. `Annuler`
  (`CANCEL_UNKNOWN_DELIVERY:<id>`) n'appelle jamais le runtime de reprise
  de livraison — aucun état n'est modifié.
* **Écritures de finalisation bornées et rejouables :**
  `kadiV1DeliveryService.js`'s `execute()` retente désormais l'écriture de
  finalisation (celle qui suit l'appel fournisseur) jusqu'à
  `FINALIZE_MAX_ATTEMPTS` fois (horloge injectable, aucun `setTimeout` réel
  dans les tests). Si toutes les tentatives échouent, la ligne reste
  délibérément à `IN_PROGRESS` et la fonction retourne
  `DELIVERY_FINALIZE_UNRESOLVED` — jamais un succès ou un échec confirmé
  deviné. Seule la réconciliation de capture expirée pourra la résoudre
  plus tard, et seulement vers `OUTCOME_UNKNOWN`.
* **Limite résiduelle documentée, non corrigée dans cette mission :**
  `deliverFinal` (le tout premier échec, pas la reprise) retourne toujours
  littéralement `DELIVERY_RECOVERABLE_FAILURE` au webhook, sans distinguer
  un échec confirmé d'une issue de finalisation non résolue. Une pression
  immédiate sur « Réenvoyer le PDF » juste après ce premier échec peut donc
  temporairement recevoir le message générique « réessayez dans un
  instant » plutôt que l'offre à deux boutons, le temps que la capture
  devienne éligible à réconciliation. Aucun risque de sécurité (jamais de
  double envoi, jamais de perte de document) — seulement une offre
  initiale moins précise dans cette fenêtre étroite.
* **Commit ou migration :** deux migrations forward-only écrites (voir
  ci-dessus), non appliquées à distance. Second commit sur la même branche
  `fix/kadi-v1-delivery-retry-and-final-filenames-r0`.
* **Preuve de validation :** nouveaux fichiers
  `tests/kadiV1DeliveryStaleReconciliation.test.js` (réconciliation de
  capture expirée, retries de finalisation, horodatage de capture),
  extensions de `tests/kadiV1DeliveryRetryEligibility.test.js` (capture
  expirée bout en bout via le vrai service, confirmation à deux temps,
  épuisement des retries de finalisation, reprise réelle depuis
  l'historique), `tests/kadiV1HistorySearch.test.js` (classification
  `CONFIRMED_FAILURE`/`OUTCOME_UNKNOWN`/`IN_PROGRESS`, jamais le code brut
  exposé), `tests/kadiV1ProductionPresenter.test.js` et
  `tests/kadiV1WebhookRuntime.test.js` (nouveaux boutons, dispatch
  `OPEN_DOCUMENT`).
* **Défaut confirmé par la propre revue adversariale fraîche de cette
  suite, corrigé avant commit :** deux angles du même problème structurel
  ont été trouvés — (1) `finalizeWithRetries` dans
  `kadiV1DeliveryService.js` ne distinguait pas « l'écriture a réellement
  échoué » de « l'écriture a réellement abouti côté serveur mais
  l'accusé de réception a été perdu » (panne réseau réelle, pas seulement
  hypothétique) : comme toutes les tentatives de la même boucle
  réutilisent le même `expectedStatus: "IN_PROGRESS"`, une réussite
  silencieuse à la première tentative faisait échouer toutes les
  suivantes sur ce même contrôle de concurrence, et la fonction retournait
  à tort `DELIVERY_FINALIZE_UNRESOLVED` alors que la ligne était déjà
  réellement réglée. **Corrigé :** après épuisement des tentatives,
  `finalizeWithRetries` relit l'état réel de la ligne ; si elle a déjà
  quitté `IN_PROGRESS`, c'est la véritable issue déjà réglée, jamais un
  « non résolu » deviné à tort. (2) `finishAlreadyDelivered` dans
  `kadiV1GenerationLifecycleService.js` ne savait guérir
  `document.status` que depuis `RECOVERABLE_FAILURE` (via `RESUME` puis
  `MARK_DELIVERED`), jamais depuis `GENERATED` — or un document reste
  exactement à `GENERATED` si le tout premier appel de livraison plante
  avant que `deliverFinal` n'ait pu enregistrer un échec, laissant la
  tentative de livraison elle-même authentiquement `DELIVERED` mais le
  document bloqué indéfiniment. **Corrigé :** `finishAlreadyDelivered`
  guérit désormais aussi depuis `GENERATED` (transition `MARK_DELIVERED`
  directe, sans `RESUME`, exactement comme le chemin normal de
  `deliverFinal`). Nouveaux tests couvrant les deux cas dans
  `tests/kadiV1DeliveryStaleReconciliation.test.js` (perte d'accusé de
  réception, sur les deux branches succès/échec) et
  `tests/kadiV1DeliveryRetryEligibility.test.js` (guérison depuis
  `GENERATED` via un scénario de plantage simulé bout en bout). Aucun
  risque de double envoi ni de double débit trouvé dans les deux cas —
  uniquement une incohérence d'état permanente et silencieuse, dans un
  déclencheur étroit mais réel.
* **Prévention :** vérifier qu'un état intermédiaire ajouté côté
  application (ici `IN_PROGRESS`) est réellement accepté par la contrainte
  de base de données correspondante avant de le considérer opérationnel —
  un test unitaire contre un dépôt en mémoire ne le garantit pas. Quand
  l'issue réelle d'une opération externe ne peut pas être prouvée après
  coup, ne jamais deviner : introduire une classification explicite «
  inconnue » et exiger une confirmation humaine distincte avant tout effet
  de bord supplémentaire. Pour une boucle de retry qui réutilise le même
  `expectedStatus` à chaque tentative, prévoir explicitement le cas où une
  tentative antérieure de la même boucle a réussi sans que l'appelant le
  sache (relecture de l'état réel après épuisement, jamais un simple
  abandon) ; et quand une fonction de guérison ne couvre qu'un seul état
  de départ, vérifier explicitement tous les états réellement atteignables
  à ce point du code, pas seulement le plus fréquent.

### Migrations appliquées et derniers écarts LOW fermés (2026-08-07)

* **Migrations appliquées et vérifiées à distance**, sous autorisation
  explicite et séparée du fondateur, sur le projet Supabase
  `cmhargmwkyskbobmkrcj` :
  - `20260806020000_add_kadi_v1_delivery_attempt_in_progress_status` puis
    `20260806030000_add_kadi_v1_delivery_outcome_to_history_bundle`,
    appliquées dans cet ordre via un seul `supabase db push --linked`,
    fenêtre `2026-08-07T00:04:03Z`–`2026-08-07T00:04:40Z`, les deux
    confirmées en succès, sortie CLI `0`, aucun avertissement PostgreSQL.
  - Vérifié en lecture seule avant et après application : la contrainte
    `kadi_v1_delivery_attempts_status_check` autorise désormais exactement
    `PENDING`/`IN_PROGRESS`/`DELIVERED`/`RECOVERABLE_FAILURE` ; la fonction
    `kadi_v1_owned_history_bundle` conserve strictement la même signature,
    le même propriétaire (`postgres`), les mêmes droits
    (`REVOKE ALL ... FROM PUBLIC` / `GRANT ALL ... TO service_role`), et
    n'a changé qu'une seule ligne (ajout de `last_error_code` dans l'objet
    `delivery`). Compteur de lignes de `kadi_v1_delivery_attempts` par
    statut identique avant/après (5 lignes : 4 `DELIVERED`,
    1 `RECOVERABLE_FAILURE` — le document CANARY du fondateur) : aucune
    donnée applicative modifiée par la migration elle-même.
  - `supabase migration list --linked` post-application : les 27
    migrations locales et distantes concordent exactement, aucune
    migration en attente, aucune divergence.
  - Le backend actuellement déployé (`ac01557b...`) reste inchangé et sain
    (`/health` 200 avant et après) — cette mission n'a déployé aucun
    nouveau code, seulement migré le schéma.
  - **La migration de la base ne constitue pas une reprise de livraison** :
    le document CANARY du fondateur (`FA-20260806190633-A0EAC605`) reste
    `RECOVERABLE_FAILURE`, non récupéré, tant que la PR n'est ni fusionnée
    ni déployée.
* **Dernier écart LOW de la revue finale précédente fermé :** aucun test
  n'exerçait auparavant la chaîne complète « recherche d'historique →
  `OPEN_DOCUMENT` → `kadiV1HistoryService.js` → `kadiV1FlowCommandRuntime.js`
  → `kadiV1FlowReplyRuntime.js` → `kadiV1ProductionPresenter.js` → bouton
  webhook réel → `kadiV1DeliveryRetryRuntime.js` → adaptateur → `retryDelivery` »
  à travers la vraie `kadiV1ProductionComposition.js` — seuls les liens
  individuels étaient testés isolément. Nouveau fichier
  `tests/kadiV1PR14ReleaseVerificationE2E.test.js` : construit une
  composition de production réelle (session, historique, commande, reply,
  présentateur, webhook, tous réels ; seules les frontières d'I/O externes
  — API WhatsApp, fournisseur de livraison, moteur de rendu PDF — sont
  remplacées), avec un `document_id`/horloge choisis pour reproduire
  exactement le numéro du document CANARY du fondateur
  (`FA-20260806190633-A0EAC605`, via la génération déterministe de
  `kadiV1DocumentDomain.js`). Couvre le scénario d'échec confirmé (bouton
  unique « Réenvoyer le PDF », zéro nouvelle réservation/capture/rendu/
  artefact, même `final_file_id`, même numéro de document, nom de fichier
  `facture_FA-20260806190633-A0EAC605.pdf` exact) et le scénario d'issue
  inconnue (l'ouverture depuis l'historique n'appelle jamais le
  fournisseur, offre à deux boutons, seule la confirmation explicite
  atteint `retryDelivery` avec `confirmed:true`, l'annulation ne mute
  rien). Le câblage réel s'est révélé correct, sans défaut détecté.

## S. Reprise réelle par le fondateur (2026-08-07) : trois défauts de production confirmés et corrigés — recherche de destination, résultats d'historique, navigation d'édition en revue

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — branche
  `fix/kadi-v1-destination-lookup-and-history-r0`, distincte de
  `fix/kadi-v1-delivery-retry-and-final-filenames-r0` (fiche R, déjà
  fusionnée et déployée). Non fusionnée, non déployée à la date de cette
  fiche.
* **Contexte :** après le déploiement du correctif de la fiche R
  (commit `aacf7621...`), le fondateur a réellement tenté une reprise de
  livraison en conditions réelles. Trois défauts distincts ont été
  confirmés, chacun par lecture directe des logs Render réels et par
  requêtes en lecture seule contre la base réelle — jamais par simulation.

### S.1 — Recherche de destination : échec confirmé avant tout appel Meta

* **Constat :** la tentative de reprise n'a **jamais atteint Meta** —
  `kadi_v1_delivery_attempts.last_error_code` est resté
  `DELIVERY_DESTINATION_LOOKUP_FAILED` sur un document flambant neuf
  (`FA-20260807010715-1961CBCC`, généré et échoué dans la même fenêtre),
  prouvant que ce n'est pas un problème isolé au document CANARY d'origine
  (`FA-20260806190633-A0EAC605`, resté lui-même intact et non retenté).
* **Correctif :** `kadiV1ProductionInfrastructure.js`'s `deliverDocument`
  relit désormais le propriétaire jusqu'à `DESTINATION_LOOKUP_MAX_ATTEMPTS`
  fois (3, `DESTINATION_LOOKUP_RETRY_DELAY_MS` = 75 ms, horloge/sleeper
  injectables) — **uniquement** autour de cette lecture, jamais autour de
  l'envoi Meta lui-même, jamais utilisé pour remettre en cause une
  incohérence de destination réellement confirmée (`DELIVERY_DESTINATION_MISMATCH`
  reste un échec immédiat, sans retry). Une erreur de forme permanente
  (droits/schéma — codes `42501`, `42P01`, `PGRST301`, `PGRST202`) sort
  immédiatement sans épuiser le budget de tentatives.
* **Preuve :** `tests/kadiV1DeliveryProvider.test.js`, scénarios A à E.

### S.2 — Deux défauts distincts d'historique, confirmés séparément

1. **`Historique` en texte brut listait « aucun document ».** Le mot
   déclencheur lui-même était transmis comme critère de recherche
   (`query: input.text`), filtrant tout. Reproduit par une requête directe
   contre le RPC réel : `text: "Historique"` → 0 ligne ; requête vide → 11
   lignes. **Correctif minimal dans `kadiV1ConversationOrchestrator.js`** :
   seul le texte résiduel après retrait des mots déclencheurs
   (`retrouve`, `retrouver`, `historique`, `dernier(s)`, `brouillon`,
   `reprends`, `reprendre`) devient la requête ; `"Historique facture"`
   continue de chercher `"facture"`.
2. **L'action Flow `SEARCH` acceptait la recherche mais n'affichait jamais
   les résultats.** `nextFlowForReply` n'avait aucun cas pour `"SEARCH"` ;
   le texte générique « La recherche est terminée. » était renvoyé que 0
   ou 20 documents aient été trouvés, sans jamais rouvrir le Flow. Le
   contrat JSON de `kadi_history_search_v1.json` prévoyait déjà un champ
   `history_options` (dropdown de résultats) — jamais alimenté.
   **Correctif :** `canonicalReplyText` distingue désormais 0 résultat
   (texte honnête, aucun Flow rouvert) de N résultats (texte avec le
   compte réel) ; `nextFlowForReply("SEARCH", ...)` rouvre `HISTORY_SEARCH`
   uniquement quand des résultats existent ; `suggestedDataForFlow` peuple
   `history_options` avec les vrais `document_id`/`document_number`/
   `counterparty` (jamais `owner_wa_id`, jamais un identifiant complet).
   **Aucun nouveau Flow Meta requis** — le contrat existant suffisait.
* **Preuve :** `tests/kadiV1ConversationOrchestrator.test.js`,
  `tests/kadiV1ProductionPresenter.test.js`,
  `tests/kadiV1HistorySearchPresentationE2E.test.js` (chaîne complète
  réelle : `nfm_reply(SEARCH)` → présentateur → `history_options` réels →
  `nfm_reply(OPEN_DOCUMENT)` → « Réenvoyer le PDF » atteint).

### S.3 — Navigation d'édition en revue : dérivée vers un défaut distinct, observée en cours de mission

* **Constat (fenêtre 2026-08-07T01:24–01:26Z) :** depuis l'écran de revue,
  choisir « Modifier le client », « Modifier les articles » ou « Modifier
  les options » renvoyait systématiquement le texte attendu (« Vous pouvez
  modifier le client. », etc.) mais **rouvrait à chaque fois l'écran de
  revue lui-même** (`flow_key: 'DOCUMENT_REVIEW'` dans les logs), jamais le
  Flow d'édition réel — l'utilisateur ne voyait ensuite que l'action
  générique « Vérifier ». L'annulation explicite (« Annuler ») a, elle,
  fonctionné correctement (« L'opération est annulée. ») — **ce n'est pas
  un défaut**, seulement la confirmation que la voie de sortie normale
  restait, elle, opérationnelle.
* **Cause racine confirmée (classification B —
  REVIEW_EDIT_ACTION_MAPPING_WRONG) :** `kadiV1ProductionPresenter.js`'s
  `nextFlowForReply` évaluait `routeDocument(document)` (qui mappe
  `READY_FOR_REVIEW` → `DOCUMENT_REVIEW`) **avant** le mappage explicite de
  `EDIT_CLIENT`/`EDIT_CONTENT`/`EDIT_OPTIONS`, qui existait pourtant déjà
  dans le code mais n'était jamais atteint pour ce statut précis.
* **Correction DOC-001 (audit exploratoire du 2026-08-07) :** la phrase
  précédente de cette fiche attribuait à tort le statut
  `READY_FOR_REVIEW` observé à `reopenForCorrection`
  (`kadiV1SharedDocumentPipeline.js`) — c'est inexact. Lu directement dans
  le code : `beginEdit` (`kadiV1RuntimeAdapters.js`) court-circuite avant
  même d'appeler `reopenForCorrection` dès que le document est déjà dans un
  état éditable mais non `VERIFIED` (`if (loaded.value.status !==
  "VERIFIED") return loaded;`) — il renvoie alors le document strictement
  inchangé, sans aucune transition. `reopenForCorrection` n'est appelé que
  lorsque le document est réellement `VERIFIED`, et il fait alors passer le
  document à `COLLECTING` (via l'événement `MODIFY` de
  `kadiV1DocumentStateMachine.js`), **jamais** à `READY_FOR_REVIEW`. Le
  correctif de routage lui-même reste entièrement correct et n'a pas eu à
  être modifié — seule cette explication de la cause était imprécise.
  Confirmé par lecture directe du code (aucune preuve par test de
  composition de production requise pour cette correction documentaire).
* **Correctif :** le mappage explicite `EDIT_CLIENT`/`EDIT_CONTENT`/
  `EDIT_OPTIONS` (y compris ses cas spéciaux RECU→`RECEIPT_DETAILS` et
  DECHARGE→`DISCHARGE_DETAILS`) est désormais évalué **avant**
  `routeDocument`, uniquement pour ces trois actions — aucune autre
  action/route n'est affectée.
* **Preuve :** `tests/kadiV1ProductionPresenter.test.js`, nouveaux tests
  reproduisant exactement le document `READY_FOR_REVIEW` post-édition pour
  les trois actions, plus la confirmation que `CANCEL` reste inchangé.
* **Limite assumée, comblée depuis (voir fiche T) :** au moment de cette
  fiche, le correctif n'avait **pas** reçu de test de composition de
  production complet avec le vrai `documentRuntime.beginEdit` bout en bout
  (contrainte de temps) — les tests couvraient le présentateur réel avec la
  forme exacte de document que `beginEdit` produit réellement (vérifiée par
  lecture directe du code), ce qui prouvait le correctif sans exercer la
  chaîne complète de mutation. L'audit exploratoire suivant (fiche
  KADI_V1_FULL_EXPLORATORY_PRODUCT_AUDIT, 2026-08-07) a confirmé par lecture
  directe du code que ceci n'était qu'une limite de couverture de test, pas
  un défaut vivant — voir la correction DOC-001 ci-dessus. La fiche T ajoute
  le test de composition de production complet resté manquant ici
  (scénario B : `EDIT_CLIENT` → vrai `beginEdit` → `SAVE_CLIENT` → retour
  réel à `DOCUMENT_REVIEW`).
* **Prévention :** quand une fonction de mutation fait transiter un
  document vers un statut partagé par une règle de routage générique,
  vérifier explicitement l'ordre d'évaluation entre cette règle générique
  et tout mappage spécifique à l'action qui a déclenché la mutation — un
  mappage présent dans le code n'est une garantie de rien s'il n'est
  jamais atteint.

## T. Audit exploratoire (2026-08-07) : contenu de revue jamais réel, retours d'édition mal routés — trois défauts confirmés et corrigés

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — même branche
  `fix/kadi-v1-destination-lookup-and-history-r0`, PR #15, toujours non
  fusionnée, non déployée.
* **Contexte :** avant fusion de la PR #15, une mission d'audit exploratoire
  complète en lecture seule (`KADI_V1_FULL_EXPLORATORY_PRODUCT_AUDIT_COMPLETE`)
  a exploré l'ensemble des parcours Kadi V1 supportés à la recherche de
  parcours bloqués, circulaires ou incomplets. Quatre défauts ont été
  confirmés par lecture directe du code puis corrigés dans une mission de
  correction dédiée sur la même branche.

### T.1 — REVIEW-001 : l'écran de revue n'a jamais montré le vrai document

* **Constat :** `kadiV1ProductionPresenter.js`'s `suggestedDataForFlow()`
  n'avait **aucune branche** pour `flowKey === "DOCUMENT_REVIEW"` — le champ
  `review_summary` restait donc systématiquement le texte d'exemple statique
  du contrat JSON du Flow (« Résumé du document à vérifier. »), pour tous
  les types de document, à chaque fois. `review_actions` restait de même
  l'exemple statique — par coïncidence identique à l'ensemble d'actions
  universel réellement souhaité pour FACTURE/DEVIS, ce qui masquait le
  défaut côté navigation tout en laissant le contenu totalement faux.
* **Correctif :** nouvelles fonctions `buildReviewSummary`/
  `buildReviewActions` dans `kadiV1ProductionPresenter.js`, construites à
  partir de la même projection `kadiV1PreviewService.buildPreviewData(document)`
  déjà utilisée pour `DOCUMENT_PREVIEW`, plus les champs propres au document
  (`tax_rate_basis_points`, `notes`, `payment_terms`). RECU et DECHARGE
  reçoivent chacun un unique bouton d'édition combiné (au lieu de trois
  boutons identiquement destinés au même Flow combiné) ; DECHARGE n'expose
  plus jamais « Modifier le client ». Aucun nouvel identifiant d'action
  n'est introduit — tout reste dans la liste fermée déjà validée par
  `kadiV1FlowReplyRuntime.js`'s `FLOW_ACTIONS.DOCUMENT_REVIEW`.

### T.2 — INV-001 : corriger le client depuis la revue forçait l'ajout d'un article

* **Constat :** `SAVE_CLIENT` est atteignable depuis deux écrans distincts
  avec le même nom d'action — `DOCUMENT_CLIENT` (création initiale) et
  `EDIT_CLIENT` (correction depuis la revue) — mais `nextFlowForReply`
  routait `SAVE_CLIENT` de façon inconditionnelle vers `ARTICLE_FORM`.
  Corriger le client d'une facture déjà en revue forçait donc l'utilisateur
  dans un formulaire d'article obligatoire (aucune option pour ignorer),
  sans retour possible vers la revue sans ajouter un article indésirable.
* **Correctif :** l'écran d'origine réel de la réponse (`flow_key`,
  vérifié par la session avant que la réponse ne soit exécutée —
  `kadiV1ConversationSession.js`'s `validateReply` rejette tout `flow_key`
  ne correspondant pas à `expected_flow_key` de la session, jamais une
  valeur envoyée par le client) est désormais transmis par
  `kadiV1FlowReplyRuntime.js` jusqu'au présentateur
  (`result.flow_key`), qui l'utilise pour distinguer les deux origines :
  `SAVE_CLIENT` originaire de `EDIT_CLIENT` retourne à `DOCUMENT_REVIEW`
  rafraîchi ; originaire de `DOCUMENT_CLIENT` (ou sans origine connue),
  le comportement initial vers `ARTICLE_FORM` reste inchangé.

### T.3 — INV-002 : corriger les articles depuis la revue ne pouvait jamais se terminer

* **Constat :** même défaut que T.2 pour `FINISH_CONTENT` (routait toujours
  vers `DOCUMENT_OPTIONS`) — et un défaut plus profond : l'écran
  `EDIT_CONTENT` n'avait ni donnée réelle (`items_summary`/`item_options`
  restaient l'exemple statique du Flow, avec un faux identifiant
  `item:example` que `UPDATE_CONTENT`/`REMOVE_CONTENT` réels ne pouvaient
  jamais résoudre), ni même la possibilité de signaler la fin de la
  correction — `kadiV1FlowReplyRuntime.js`'s `FLOW_ACTIONS.EDIT_CONTENT`
  n'autorisait que `ADD_CONTENT`/`UPDATE_CONTENT`/`REMOVE_CONTENT`, jamais
  `FINISH_CONTENT`. Le parcours de correction d'articles était donc
  entièrement bloqué, pas seulement mal routé.
* **Correctif :** `FINISH_CONTENT` ajouté à `FLOW_ACTIONS.EDIT_CONTENT` ;
  `suggestedDataForFlow` peuple désormais `EDIT_CONTENT` avec les vrais
  articles courants (`item_options` avec les vrais `item_id`) et un
  `edit_actions` construit côté serveur (n'offre « Terminer la
  modification » que lorsqu'il reste au moins un article). `nextFlowForReply`
  fait boucler `ADD_CONTENT`/`UPDATE_CONTENT`/`REMOVE_CONTENT` originaires
  de `EDIT_CONTENT` vers `EDIT_CONTENT` (jamais vers `DOCUMENT_CONTENT`,
  qui n'accepte pas ces actions), et route `FINISH_CONTENT` originaire de
  `EDIT_CONTENT` vers `DOCUMENT_REVIEW` rafraîchi.

### T.4 — Défaut distinct découvert incidemment, non corrigé dans cette mission

* **CLIENT-001 — CONFIRMED → `FIXED_ON_BRANCH` (voir fiche U ci-dessous) :**
  en construisant les tests de composition de production pour T.2,
  `SAVE_CLIENT` a échoué avec `DOCUMENT_CLIENT_FIELD_UNKNOWN` dès qu'un
  champ `tax_id` était soumis — or `flows/v1_draft/kadi_document_client_v1.json`
  **et** `flows/v1_draft/kadi_edit_client_v1.json` soumettent tous deux
  systématiquement un champ `tax_id` (Meta soumet tous les champs déclarés
  du formulaire, y compris vides). `CLIENT_FIELDS`
  (`kadiV1SharedDocumentPolicies.js`) n'autorisait que
  `name`/`phone`/`address`/`email`/`ifu`/`rccm` — jamais `tax_id`. En l'état
  du code à cette date, **toute soumission réelle de `SAVE_CLIENT` aurait
  échoué**, que ce soit à la création initiale ou en correction. Confirmé
  par exécution réelle (pas seulement lecture) : les tests de ce correctif
  ont dû volontairement omettre `tax_id` de leurs données soumises pour
  pouvoir exercer T.2/T.3, ce qui documentait le défaut sans le corriger.
  Strictement hors périmètre de cette mission (limitée à REVIEW-001/
  INV-001/INV-002/DOC-001) au moment de la fiche T — corrigé dans une
  mission dédiée immédiatement suivante, voir fiche U.

### Preuve

* `tests/kadiV1ProductionPresenter.test.js` : nouveaux tests
  REVIEW-001/INV-001/INV-002 au niveau présentateur.
* `tests/kadiV1FlowReplyRuntime.test.js` : `flow_key` propagé dans
  l'enveloppe de réponse ; `EDIT_CONTENT` accepte `FINISH_CONTENT`.
* `tests/kadiV1ReviewEditReturnJourneysE2E.test.js` (nouveau) : onze
  scénarios de composition de production réelle bout en bout (A à K, sans
  section J numérotée séparément dans le fichier mais couverte), avec le
  vrai `sharedPipeline`/`dischargePipeline`/`documentRuntime` — jamais de
  simulation du résultat de `beginEdit`. Chaque port sans rapport
  (paiement, génération, recharge, historique, solde) est un bouchon qui
  lève une exception au moindre appel : si une correction touchait par
  erreur la facturation, le rendu ou un fichier final, le test échouerait
  immédiatement.

### Sécurité re-vérifiée

Aucune réservation de crédit, aucune capture, aucun rendu, aucun fichier
final créé pendant une correction (prouvé structurellement par les bouchons
ci-dessus, pas seulement affirmé) ; même `document_id`, même propriétaire,
même type de document ; `document_number`/`issued_at` non affectés (jamais
assignés avant génération) ; rejeu strictement idempotent (`duplicate: true`
sur une réponse rejouée, aucune mutation supplémentaire) ; une réponse
d'édition obsolète (version de document dépassée par une autre mutation
entre-temps) est rejetée, jamais appliquée silencieusement ; l'annulation
explicite reste inchangée et reste la seule voie d'annulation normale.

## U. CLIENT-001 — corrigé : `tax_id` du Flow n'était jamais reconnu comme l'`ifu` canonique du domaine

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — même branche
  `fix/kadi-v1-destination-lookup-and-history-r0`, PR #15, toujours non
  fusionnée, non déployée.
* **Constat, reproduit par exécution réelle (pas seulement par lecture) :**
  voir T.4 ci-dessus.

### Contrat canonique déterminé avant toute correction

Recherche exhaustive de `tax_id`/`ifu`/`rccm` dans tout le dépôt (contrats
Flow, schéma document, politiques, aperçu, rendu PDF, persistance,
documentation, tests) :

* `ifu` est le nom canonique reconnu par **toutes** les couches V1 qui
  connaissent ce concept : `CLIENT_FIELDS`
  (`kadiV1SharedDocumentPolicies.js`) et le contrat du cerveau
  conversationnel (`kadiV1BrainContracts.js`) n'utilisent tous deux que
  `ifu`, jamais `tax_id`.
* `tax_id` n'apparaît **nulle part ailleurs** dans le dépôt comme concept
  distinct persisté — ni dans le domaine, ni dans la projection d'aperçu,
  ni dans un quelconque rendu, ni dans l'ancien système pré-V1 (qui utilise
  lui aussi `ifu`, avec un champ Flow historique nommé différemment,
  `client_ifu`).
* Le champ Flow `tax_id` porte le libellé **« Identifiant fiscal »** — la
  traduction française exacte de ce que signifie IFU (Identifiant Financier
  Unique) au Burkina Faso.
* `rccm` (registre du commerce, un concept distinct — pas un identifiant
  fiscal) reste accepté par la politique mais n'est soumis par **aucun**
  écran Flow V1 réel actuellement ; aucune incohérence ne s'ensuit, donc
  aucun correctif n'était nécessaire pour `rccm`.
* **Conclusion (option A du choix proposé par la mission) : `tax_id` est
  l'alias du Flow pour le champ canonique `ifu` du domaine.** Ni une
  option B (champ distinct supporté), ni C (champ obsolète à ne plus
  soumettre — les deux Flows réels le soumettent toujours), ni un autre
  mapping.

### Correctif

Nouvelle fonction `normalizeClientTaxIdentifier(action, data)` dans
`kadiV1FlowReplyRuntime.js`, insérée dans la même séquence de
normalisation Flow→domaine que celle déjà utilisée pour
`tax_rate_percent`/`tax_rate_basis_points` (fiche P) : appelée uniquement
pour `SAVE_CLIENT`, elle retire `tax_id` du payload et, s'il contient une
valeur non vide après nettoyage, la fusionne dans `ifu`. `ifu` ajouté à
`ACTION_FIELDS.SAVE_CLIENT` (uniquement pour permettre la détection de
conflit ci-dessous — aucun des deux Flows réels ne soumet `ifu`
directement aujourd'hui). Si `tax_id` et `ifu` sont tous deux soumis avec
des valeurs non vides et **différentes**, la soumission échoue
explicitement (`KADI_V1_FLOW_REPLY_CLIENT_TAX_IDENTIFIER_CONFLICT`) plutôt
que de choisir silencieusement l'une des deux. Un `tax_id` vide (le cas
normal, la grande majorité des soumissions réelles) ne laisse aucune trace
(`tax_id` ni `ifu` dans le document persisté). Aucune autre validation de
champ n'est affaiblie : la liste fermée de champs connus
(`KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN`) reste strictement appliquée.

### Preuve

* `tests/kadiV1FlowReplyRuntime.test.js` : scénarios A à D de la mission
  (soumission initiale réelle avec `tax_id` vide, soumission d'édition
  réelle avec `tax_id` vide, valeur légitime normalisée vers `ifu`, valeurs
  identiques sans conflit, valeurs contradictoires rejetées, champ inconnu
  toujours rejeté), plus un test de parité qui reconstruit la vraie forme
  de soumission des deux Flows réels (`kadi_document_client_v1.json`,
  `kadi_edit_client_v1.json`) directement depuis leurs fichiers JSON, pour
  empêcher toute dérive future entre ce que le Flow soumet et ce que la
  politique accepte.
* `tests/kadiV1ReviewEditReturnJourneysE2E.test.js` : les données
  `SAVE_CLIENT` de tous les scénarios ont été restaurées à la vraie forme
  de soumission (avec `tax_id`, plus une valeur légitime réelle dans le
  scénario A) — CLIENT-001 est donc fermé sur la même composition de
  production qui a servi à le découvrir, pas seulement par un test isolé.
  Onze scénarios toujours verts après correctif, y compris la persistance
  effective de `document.client.ifu` et l'absence de toute clé `tax_id`
  résiduelle.
* Suite complète après correctif : voir section Tests de la mission
  courante dans `docs/KADI_RELEASE_CHECKLIST.md`.

### Sécurité re-vérifiée

Aucun champ arbitraire non déclaré n'est accepté (le test D le confirme
explicitement) ; aucune donnée n'est perdue silencieusement (un `tax_id`
non vide est toujours soit fusionné dans `ifu`, soit rejeté par conflit,
jamais simplement abandonné) ; le comportement est identique pour la
création initiale et la correction ; aucun champ soumis par le client ne
contrôle le routage (le routage reste piloté uniquement par `action` et le
`flow_key` d'origine vérifié par la session, comme pour les correctifs de
la fiche T) ; aucune réservation de crédit, capture, rendu ou fichier
final pendant un `SAVE_CLIENT`. Aucune migration Supabase requise ; aucune
mutation Meta requise (le contrat Flow existant, `tax_id` inclus, reste
valide tel quel).

### Prévention

Quand une même donnée métier a deux noms différents entre la couche Flow
(pilotée par ce que Meta a historiquement publié comme libellé/nom de
champ) et la couche domaine (pilotée par le vocabulaire métier canonique),
normaliser une fois, à la frontière de validation Flow→domaine déjà
établie pour ce genre de cas (voir aussi fiche P) — jamais laisser
persister deux représentations contradictoires, et toujours faire échouer
explicitement un conflit plutôt que d'en choisir une silencieusement.

## V. Revue finale de fusion de la PR #15 : deux défauts confirmés et corrigés avant fusion

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — même branche
  `fix/kadi-v1-destination-lookup-and-history-r0`, PR #15, toujours non
  fusionnée, non déployée.
* **Contexte :** revue finale de fusion (« merge-gate ») de l'intégralité
  de la PR #15, comparant `main@aacf76211552800054983c726a1211f22ed29aeb`
  à la tête de branche. Un balayage borné de cohérence entre chaque
  contrat Flow réellement touché ou dépendant de la PR et la politique
  backend correspondante (même méthode que celle qui a révélé CLIENT-001)
  a révélé un second défaut de la même famille ; une revue croisée de
  l'observabilité a révélé un défaut d'intégration distinct.

### V.1 — EDIT-CONTENT-001 : le formulaire combiné d'édition d'articles était rejeté pour trois de ses quatre actions réelles

* **Constat :** `flows/v1_draft/kadi_edit_content_v1.json` est un formulaire
  unique combiné pour les quatre actions `EDIT_CONTENT`
  (`ADD_CONTENT`/`UPDATE_CONTENT`/`REMOVE_CONTENT`/`FINISH_CONTENT`) — son
  unique bouton de pied de page soumet toujours
  `item_id`/`description`/`quantity`/`unit`/`unit_custom`/`unit_price`
  ensemble, quelle que soit l'action choisie (Meta soumet tous les champs
  déclarés du formulaire à chaque soumission). Avant correctif, seule la
  liste blanche d'`UPDATE_CONTENT` acceptait déjà l'ensemble exact de ces
  champs ; les trois autres rejetaient la vraie soumission avec
  `KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN` : `ADD_CONTENT` et `FINISH_CONTENT`
  sur `item_id`, `REMOVE_CONTENT` et `FINISH_CONTENT` sur le groupe
  `description`/`quantity`/`unit`/`unit_custom`/`unit_price`. **Ce défaut
  préexistait mais était resté invisible/sans conséquence pratique tant
  que INV-002 (fiche T) n'avait pas rendu `EDIT_CONTENT` réellement
  atteignable** (avant ce correctif, l'écran n'avait ni données réelles ni
  action de fin) — le propre correctif de cette PR pour INV-002 rendait ce
  défaut actif pour la première fois, sans que les tests de composition de
  production existants (qui reproduisaient une forme de soumission
  incomplète, à l'image de l'erreur initiale sur `tax_id`) ne le
  détectent.
* **Correctif :** `ACTION_FIELDS.ADD_CONTENT`/`REMOVE_CONTENT`/`FINISH_CONTENT`
  élargis pour accepter la vraie forme combinée du formulaire ;
  `item_id`, non pertinent pour un nouvel article, est retiré une seule
  fois par une nouvelle fonction `normalizeAddContentItemId`, à la même
  frontière de normalisation Flow→domaine que `resolveUnitCustom` et
  `normalizeClientTaxIdentifier` — jamais transmis au domaine, qui ne le
  reconnaît pas. `ARTICLE_FORM`'s propre `ADD_CONTENT` (sans `item_id`)
  reste inchangé.
* **Preuve :** `tests/kadiV1FlowReplyRuntime.test.js`, quatre scénarios
  directs (`ADD_CONTENT`/`REMOVE_CONTENT`/`FINISH_CONTENT` avec la vraie
  forme complète, `ARTICLE_FORM` non affecté) plus un test de parité qui
  dérive les quatre actions déclarées et le vrai jeu de champs soumis
  directement depuis `kadi_edit_content_v1.json`. `tests/kadiV1ReviewEditReturnJourneysE2E.test.js`
  (scénarios C et J) corrigés pour soumettre la vraie forme complète —
  fermé sur la même composition de production qui aurait dû le détecter.

### V.2 — L'observateur de cycle de vie ne filtrait jamais rien en conditions réelles

* **Constat :** `kadiV1GenerationLifecycleService.js`'s vrai `emit()`
  appelle l'observateur avec **un seul objet fusionné**
  (`observer(Object.freeze({ event, ...details }))`) — le contrat
  préexistant déjà utilisé ailleurs (`kadiV1GenerationLifecycle.test.js`,
  `kadiV1Recharge.test.js` : `observer: (event) => ...`). Le nouvel
  observateur introduit par la fiche R/S attendait à tort **deux**
  arguments séparés (`(event, details)`). Appelé de la vraie façon,
  `event` recevait l'objet fusionné entier et `details` restait toujours
  `{}` par défaut — la liste blanche de filtrage
  (`SAFE_LIFECYCLE_OBSERVER_KEYS`) ne s'exécutait donc jamais réellement,
  bien qu'elle passe ses propres tests unitaires (qui appelaient
  l'observateur isolément avec la forme à deux arguments qu'il attendait
  lui-même, sans jamais l'exercer avec le vrai `emit()`). **Aucune fuite
  réelle n'en a résulté** : chaque site d'appel réel d'`emit()` ne passe
  aujourd'hui que `reason_code`/`duplicate`, jamais un champ sensible —
  mais la garantie de défense en profondeur elle-même était inopérante,
  et un futur `emit()` portant un champ non prévu aurait atteint le
  logger sans filtrage.
* **Correctif :** l'observateur accepte désormais l'objet fusionné unique
  réel, en extrait `event` puis filtre le reste selon la même liste
  blanche.
* **Preuve :** `tests/kadiV1ProductionBootstrap.test.js` — les trois tests
  existants adaptés à la vraie forme d'appel, plus un nouveau test
  d'intégration qui construit le vrai `kadiV1GenerationLifecycleService`
  avec le vrai observateur ensemble (pas chacun isolément contre sa propre
  hypothèse de contrat) et vérifie qu'un événement réellement émis
  n'atteint le logger qu'avec des champs de la liste blanche.

### Prévention (les deux)

Un composant testé isolément contre sa propre hypothèse de contrat ne
prouve rien sur son intégration réelle avec l'unique appelant qui compte —
toujours ajouter au moins un test qui construit les deux côtés réels
ensemble. Et, comme pour CLIENT-001 : quand un écran Flow combine
plusieurs actions dans un seul formulaire, vérifier explicitement que la
vraie forme de soumission (tous les champs déclarés, à chaque fois) est
acceptée pour **chacune** des actions qu'il peut soumettre, pas seulement
celle testée en premier.

## W. Cause racine confirmée et corrigée : `DELIVERY_DESTINATION_LOOKUP_FAILED` en production réelle était une colonne physique inexistante (PostgreSQL 42703)

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — nouvelle branche dédiée
  `fix/kadi-v1-delivery-destination-schema-r0`, créée depuis `main` au
  commit `0335d3758f3dc1d4841fd5137c8273d03ee68843` (celui-là même déployé
  en production). PR distincte, brouillon, non fusionnée, non déployée.

### Défaut de production observé

Après le déploiement de la PR #15, une vraie tentative de reprise du
propriétaire sur `FA-20260807010715-1961CBCC` a de nouveau échoué avec
`DELIVERY_DESTINATION_LOOKUP_FAILED` — le budget de retries borné introduit
par la PR #15 (fiche S.1) s'est bien exécuté (`attempt_count` incrémenté)
mais n'a rien résolu.

### Cause racine sous-jacente, prouvée par reproduction directe (pas seulement par lecture de code)

`lookupDestinationOwner()` (`kadiV1ProductionInfrastructure.js`) exécutait :

```js
supabase.from("kadi_v1_documents")
  .select("owner_wa_id,document_type,options,document_number")
  .eq("document_id", documentId)
  .maybeSingle()
```

Reproduit en lecture seule, avec le même client `@supabase/supabase-js` et
les mêmes identifiants (service-role) que la production, contre la vraie
base : **`PostgreSQL 42703` — `column kadi_v1_documents.options does not
exist`** (HTTP 400). Confirmé par une lecture `select("*")` de la même
ligne : les colonnes physiques réelles sont `active_version, cancelled_at,
created_at, currency, document_id, document_number, document_type,
generated_file, generation_cost, generation_quote, issued_at,
issuer_profile_id, legacy_id, legacy_source, metadata, owner_wa_id,
preview, recoverable_failure, status, updated_at` — **`options` n'existe
pas**. `owner_wa_id`/`document_type`/`document_number` existent bien ;
seul `options` était inventé.

### Pourquoi le correctif borné de la PR #15 (fiche S.1) ne pouvait pas résoudre ceci

`42703` n'était pas dans `PERMANENT_LOOKUP_ERROR_CODES` — la classification
par défaut (« tout code inconnu est probablement transitoire ») traitait
donc cette erreur, pourtant déterministe à 100 % (une requête mal formée
échoue identiquement à chaque tentative, indépendamment du réseau), comme
si elle pouvait réussir au prochain essai. Le budget de 3 tentatives était
donc intégralement épuisé, en pure perte, avant l'échec final.

### D'où vient réellement `invoice_kind` (source authentique déterminée avant tout correctif, jamais supposée)

`document.options` (utilisé pour construire le nom de fichier canonique)
n'est **jamais** une colonne physique de `kadi_v1_documents` — c'est un
champ du domaine JS, reconstruit à l'hydratation. La vraie architecture
(confirmée en lisant `kadiV1SupabaseDocumentRepository.js`'s
`getDocumentById`, déjà correcte et déjà utilisée partout ailleurs dans le
code) : `kadi_v1_documents` (colonnes physiques scalaires) est joint à
`kadi_v1_document_versions.snapshot` (JSONB, l'objet document complet —
`client`, `items`, `options`, `receipt`, `discharge`, etc.) via
`restoreDocumentSnapshot`. La colonne `metadata` de `kadi_v1_documents`
n'a **aucun rapport** avec `options` — elle sert uniquement au suivi de
migration/provenance (`source`, `schema_version`, `legacy_status`,
`migration_batch`, `correlation_ref`, `reason_code`, `attempt` — liste
fermée dans `kadiV1DocumentRepository.js`'s `METADATA_KEYS`).

### Correctif — séparation architecturale stricte, comme exigé

* **A. Vérification propriétaire/destination** (`lookupDestinationOwner`) :
  requête brute minimale, `select("owner_wa_id")` uniquement — la seule
  colonne physique réellement nécessaire pour cette étape. Reste
  volontairement une requête brute (et non un appel au repository complet)
  car `getDocumentById` exige de connaître déjà `owner_wa_id` pour scoper
  sa lecture (une protection de sécurité correcte pour tout autre
  appelant) — or c'est précisément ce que cette étape découvre, à partir
  du seul `document_id`, avant tout contact Meta.
* **B. Métadonnées de nom de fichier** (`resolveDeliveryFilenameMetadata`,
  nouvelle fonction) : appelée strictement **après** que A a réussi, avec
  le `owner_wa_id` désormais authentifié par A — réutilise le
  `documentRepository` déjà authentique et déjà testé partout ailleurs,
  plutôt qu'une deuxième requête brute inventée (exactement l'erreur qui a
  causé le défaut en A). `createKadiV1WhatsAppDeliveryProvider` reçoit
  désormais `documentRepository` en dépendance ;
  `kadiV1ProductionBootstrap.js` lui passe la **même instance** déjà
  construite pour le reste de la composition — aucune construction
  redondante.
* **`42703` ajouté à `PERMANENT_LOOKUP_ERROR_CODES`** : échoue désormais
  immédiatement (une seule lecture, zéro sommeil) plutôt que d'épuiser le
  budget de retries en pure perte.
* Aucune mutation Meta, aucune migration Supabase requise — correctif
  entièrement applicatif.

### Preuve

* `tests/kadiV1DeliveryProvider.test.js` — réécrit intégralement : chaque
  test distingue désormais explicitement A (vérification, requête brute
  minimale asserted) de B (métadonnées, via un faux `documentRepository`
  qui lève une exception s'il est appelé avant que A n'ait réussi — preuve
  structurelle de l'ordre, pas seulement une affirmation). Matrice complète
  : lecture réussie, `42703` échoue en une tentative sans sommeil,
  transitoire puis succès, incohérence confirmée, propriétaire
  manquant/malformé, les cinq noms de fichiers canoniques (FACTURE
  FINAL/PROFORMA, DEVIS, RECU, DECHARGE), échec de résolution des
  métadonnées après vérification réussie (échec fermé, jamais un nom de
  fichier deviné).
* `tests/kadiV1DeliveryDestinationSchemaE2E.test.js` (nouveau) — seule
  composition de production de ce dépôt à utiliser le **vrai**
  `createKadiV1WhatsAppDeliveryProvider` (tous les autres tests de reprise
  de livraison simulent entièrement l'interface du provider, ce qui
  explique pourquoi ce défaut n'avait jamais été détecté par un test).
  Scénario complet : document `RECOVERABLE_FAILURE` → `RETRY_DELIVERY` →
  vraie vérification de destination (schéma corrigé) → vrai fournisseur de
  livraison atteint exactement une fois → `DELIVERED`, même fichier final,
  aucune nouvelle réservation/capture/rendu. Plus un cas PROFORMA dédié et
  un cas DEVIS/RECU/DECHARGE, prouvant que `invoice_kind` et les autres
  métadonnées survivent au correctif via le chemin d'hydratation
  authentique.
* Suite complète : 1327/1327. `git diff --check` : propre.

### Sécurité re-vérifiée

Aucun contact Meta avant succès de la vérification A (structurellement
prouvé — B ne peut jamais s'exécuter avant A dans le code, et les tests le
démontrent en faisant lever une exception à B si appelée trop tôt) ; aucun
retry autour de l'envoi Meta lui-même (inchangé) ; aucune incohérence de
destination réellement confirmée n'est jamais retentée ; `owner_wa_id`
utilisé pour B provient exclusivement du résultat vérifié de A, jamais
d'une valeur cliente ; même document, même fichier final, même
`document_number`/`issued_at` ; aucun nouveau rendu, aucune nouvelle
réservation, aucune nouvelle capture sur une reprise (prouvé par la
composition de production, pas seulement affirmé) ; non-propriétaire
toujours bloqué ; incohérence de destination toujours bloquée ; portail
CANARY inchangé.

### Prévention

Une requête brute écrite à la main contre une base réelle doit toujours
être vérifiée contre le vrai schéma physique avant d'être fusionnée — ne
jamais supposer qu'un nom de champ du modèle de domaine JS correspond à
une colonne SQL du même nom. Quand une lecture combine plusieurs
responsabilités (ici : vérification de sécurité **et** métadonnées
d'affichage), les séparer clairement et laisser chacune utiliser la source
la plus sûre/authentique pour son propre besoin, plutôt qu'une seule
requête raccourcie inventée pour couvrir les deux à la fois. Et,
structurellement : un test qui simule entièrement l'interface d'un
composant ne peut jamais détecter un défaut interne à ce composant — au
moins un test de composition doit utiliser l'implémentation réelle de
chaque composant critique, pas seulement son interface simulée.

## X. OPTIONS-001 — corrigé : le contrat d'options FACTURE/DEVIS n'acceptait pas la vraie forme combinée du Flow `DOCUMENT_OPTIONS`

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — nouvelle branche dédiée
  `fix/kadi-v1-options-contract-r0`, créée depuis `main` au commit
  `d2fee1a1adbae59ce452411f2eb37fe8bcb5b298`. PR distincte, brouillon, non
  fusionnée, non déployée.
* **Origine :** item T1 du backlog produit par l'audit final
  « KADI V1 — FINAL ROADMAP GAP AUDIT R0 », qui avait identifié trois
  parcours cœur totalement cassés (`OPTIONS-001`/T1, `HISTORY-CONTRACT-001`/T2,
  `RECHARGE-CONTRACT-001`/T3) partageant tous le même défaut de classe déjà
  vu deux fois dans ce dépôt (`CLIENT-001` fiche U, `EDIT-CONTENT-001` fiche
  V.1) : un formulaire Flow combiné soumet toujours l'ensemble de ses champs
  déclarés, quelle que soit l'action réellement voulue par l'utilisateur ;
  la liste blanche de champs backend ne couvrait pas cet ensemble complet.

### Constat, reproduit par exécution réelle

`flows/v1_draft/kadi_document_options_v1.json` (et son pendant d'édition
`kadi_edit_options_v1.json`) n'a qu'un seul pied de page, qui soumet
toujours ensemble `tax_rate_percent` (ou l'ancien `tax_rate_basis_points`),
`discount_amount`, `notes`, `payment_terms`, `validity_days`,
`payment_method` et `reference` — les sept champs, y compris ceux laissés
vides. `kadiV1FlowReplyRuntime.js`'s `ACTION_FIELDS.SAVE_OPTIONS` acceptait
déjà cette forme complète, mais `kadiV1SharedDocumentPolicies.js`'s
`normalizeOptions` (la couche suivante, qui alimente réellement le pipeline
document partagé) ne connaissait que `validity_days` sous sa forme
imbriquée historique (`options.validity_days`) et ignorait totalement
`payment_method`/`reference` pour FACTURE/DEVIS. Reproduit directement :

```js
normalizeOptions("FACTURE", { discount_amount: 0, notes: "", payment_terms: "",
  tax_rate_basis_points: 1800, validity_days: "" })
// → { ok: false, error: "DOCUMENT_OPTIONS_FIELD_UNKNOWN" }
```

**Conséquence en production réelle : aucune FACTURE ni aucun DEVIS ne
pouvait jamais quitter l'écran `DOCUMENT_OPTIONS` via le vrai Flow Meta** —
la toute première soumission d'options réelle échouait systématiquement,
quel que soit ce que l'utilisateur avait réellement rempli.

Un second défaut de la même fonction, jusque-là invisible car masqué par le
premier (le rejet par champ inconnu se déclenchait toujours avant), a été
découvert pendant la conception du correctif : `discount_amount: ""` (la
valeur réaliste qu'un champ Meta `input-type: "number"` soumet quand il est
laissé vide) était déjà rejeté avec `DOCUMENT_OPTIONS_AMOUNT_INVALID`,
faute de la même tolérance au blanc déjà établie pour `tax_rate_percent`
(fiche P). Corrigé dans le même correctif : même classe de défaut, même
fonction, découvert par la même investigation — pas un élargissement de
périmètre vers T2/T3/T4.

### Contrat canonique déterminé avant toute correction

* **`validity_days`** : sa place canonique est `document.options.validity_days`
  (imbriqué), exactement comme la convention déjà établie pour
  `invoice_kind`/`receipt_format` (également sous `document.options` —
  voir `kadiV1DocumentDomain.js`). Le défaut n'était jamais un mauvais
  emplacement de stockage : c'est que le Flow soumet le champ **à plat**
  alors que le normaliseur n'acceptait que la forme imbriquée. Correctif :
  accepter la forme plate et la fusionner dans la structure imbriquée ;
  si les deux formes sont soumises simultanément avec des valeurs
  différentes, échec explicite (`DOCUMENT_VALIDITY_CONFLICT`) plutôt que
  de choisir silencieusement l'une des deux — même principe que
  `tax_id`/`ifu` (fiche U).
* **`payment_method`/`reference`** : recherche exhaustive dans tout le
  domaine (`kadiV1DocumentDomain.js`, `kadiV1PreviewService.js`,
  `kadiV1SharedDocumentPipeline.js`, `kadiV1FinalGenerationService.js`) —
  ces deux champs n'ont **aucune** signification FACTURE/DEVIS nulle part ;
  leur seule signification existante dans tout le dépôt est celle du reçu
  (`document.receipt.payment_method`/`.reference`). Conformément à la
  consigne explicite de la mission (ne pas élargir aveuglément une liste
  blanche, ni inventer une nouvelle signification persistée), ils sont
  désormais acceptés par la liste blanche FACTURE/DEVIS **uniquement**
  pour ne plus faire échouer la vraie soumission complète du Flow, et
  explicitement abandonnés (jamais persistés) pour ces deux types de
  document.

### Correctif

`kadiV1SharedDocumentPolicies.js` : `COMMON_OPTION_FIELDS` élargi à
`validity_days`/`payment_method`/`reference` ; nouvelle fonction
`parseOptionalInteger` (tolérance au blanc, réutilisée pour
`discount_amount` et `validity_days`, même convention que
`normalizePercentText`) ; `normalizeOptions` réécrit pour fusionner
`validity_days` plat/imbriqué avec détection de conflit, et pour ignorer
silencieusement `payment_method`/`reference` sur FACTURE/DEVIS.
`DOCUMENT_OPTIONS_EMPTY` supprimé (aucun appelant n'en dépendait — la
couche adaptateur court-circuite déjà toute soumission brute réellement
vide avant d'atteindre cette fonction) : une soumission réelle où tous les
champs optionnels sont vides doit désormais réussir comme un non-événement
inoffensif, jamais comme une erreur.

`DECHARGE` volontairement laissé hors périmètre : son parcours initial
utilise `SAVE_DETAILS` et sa propre politique dédiée
(`kadiV1DischargePolicy.js`'s `normalizeOptions`, appelée uniquement avec
un payload `{observations}` construit côté serveur, jamais un passage
direct de la forme du Flow partagé) — confirmé par lecture du code, pas
supposé, et couvert par un test de non-régression dédié.

### Preuve

* `tests/kadiV1SharedDocumentPipeline.test.js` : neuf nouveaux scénarios —
  forme réelle complète FACTURE acceptée, `validity_days` plat DEVIS
  persisté et relu après rechargement, conflit plat/imbriqué rejeté,
  champs optionnels vides sans corruption, chaîne numérique acceptée,
  `payment_method`/`reference` acceptés puis abandonnés pour FACTURE/DEVIS,
  champ réellement inconnu toujours rejeté, liste blanche RECU propre
  toujours inchangée, soumission entièrement vide acceptée comme
  non-événement.
* `tests/kadiV1FlowReplyRuntime.test.js` : nouveau test de parité qui
  reconstruit la vraie forme de soumission des deux Flows réels
  (`kadi_document_options_v1.json`, `kadi_edit_options_v1.json`)
  directement depuis leurs fichiers JSON, pour empêcher toute dérive
  future entre ce que le Flow soumet et ce que cette couche accepte (même
  méthode que celle qui a révélé `CLIENT-001`).
* `tests/kadiV1ReviewEditReturnJourneysE2E.test.js` : le générateur
  `buildFactureAtReview` (utilisé par la quasi-totalité des scénarios du
  fichier) restauré à la vraie forme complète à sept champs ; nouveau
  scénario E2 (DEVIS, `validity_days` plat, persistance confirmée après
  rechargement, `payment_method`/`reference` confirmés jamais persistés) ;
  nouveaux scénarios L/M (rejeu et version obsolète, spécifiquement pour
  `SAVE_OPTIONS`, sur le même modèle que I/J/K) ; nouveau scénario N
  (non-régression explicite du parcours `DECHARGE` `SAVE_DETAILS`, hors
  périmètre confirmé). Composition de production réelle inchangée : tous
  les ports non liés (aperçu, génération, recharge, historique, wallet)
  restent des bouchons qui lèvent une exception au moindre appel.
* Focused : 180/180. Suite complète : 1341/1341. `git diff --check` :
  propre.

### Sécurité re-vérifiée

Aucun champ arbitraire non déclaré n'est accepté pour FACTURE/DEVIS (la
liste blanche reste fermée, testée explicitement) ; aucune donnée n'est
perdue silencieusement (`validity_days` est toujours soit persisté soit
rejeté par conflit, jamais simplement abandonné) ; `payment_method`/
`reference` sont abandonnés **par conception documentée**, pas par bug ;
`RECU` garde sa propre liste blanche stricte, non affectée ; aucun calcul
financier ni total serveur-autoritaire modifié ; aucun débit, aucune
réservation, aucun rendu, aucune génération pendant `SAVE_OPTIONS` (prouvé
structurellement par la composition de production) ; idempotence et rejet
de version obsolète inchangés et testés spécifiquement pour `SAVE_OPTIONS`
pour la première fois. Aucune migration Supabase requise ; aucune mutation
Meta requise (le contrat Flow existant reste valide tel quel).

### Suivi requis (hors périmètre de cette correction, à ne pas ignorer)

Le même défaut de classe (liste blanche backend en retard sur la vraie
forme combinée d'un Flow) a maintenant été trouvé indépendamment quatre
fois (`CLIENT-001`, `EDIT-CONTENT-001`, `OPTIONS-001`, et confirmé encore
présent pour `HISTORY-CONTRACT-001`/T2 et `RECHARGE-CONTRACT-001`/T3 par
l'audit qui a produit ce backlog). Un **`FLOW-PARITY-GATE`** global est
requis : un test structurel unique qui, pour chaque Flow JSON réel de
`flows/v1_draft/`, dérive automatiquement sa vraie forme de soumission
combinée et vérifie qu'elle est acceptée par la politique backend
correspondante — plutôt que de découvrir chaque cas un par un, par mission
séparée. Ne pas construire ce gate dans le cadre de cette mission (portée
strictement limitée à T1) ; le programmer explicitement dans le backlog
suivant.

### Prévention

Quand un écran Flow combine plusieurs champs optionnels dans un seul pied
de page, vérifier explicitement, à partir du vrai fichier JSON (jamais
d'un sous-ensemble choisi à la main), que **chaque** champ qu'il peut
soumettre a un traitement backend explicite : accepté et persisté avec une
sémantique réelle, ou accepté et explicitement abandonné avec une raison
documentée — jamais un troisième cas silencieux où le champ fait échouer
toute la soumission. Et, comme pour `CLIENT-001`/`EDIT-CONTENT-001` : la
liste blanche d'une couche (ici `ACTION_FIELDS` dans
`kadiV1FlowReplyRuntime.js`) peut déjà être correcte pendant que la couche
suivante (ici `normalizeOptions` dans `kadiV1SharedDocumentPolicies.js`)
reste en retard — vérifier la parité Flow↔backend à **chaque** couche de
validation, pas seulement la première atteinte.

### X.1 — EDIT_OPTIONS-001 : corrigé avant fusion, revue indépendante — les champs `notes`/`payment_terms` non pré-remplis pouvaient être effacés silencieusement

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — même branche
  `fix/kadi-v1-options-contract-r0`, PR #17, toujours non fusionnée, non
  déployée.
* **Origine :** revue adversariale indépendante de la PR #17 (mission « KADI
  V1 — T1 OPTIONS-001 INDEPENDENT REVIEW FIX R1 »), constat MEDIUM/bloquant
  de fusion.

### Constat, reproduit avant tout correctif

Contrairement à `EDIT_CLIENT`/`EDIT_CONTENT`, le vrai formulaire
`EDIT_OPTIONS` ne pré-remplit jamais `notes`/`payment_terms` avec les
valeurs actuelles du document — son formulaire unique combiné les soumet
vides à chaque fois que le propriétaire ne les touche pas, exactement comme
les champs numériques (`discount_amount`/`validity_days`) déjà traités par
la fiche X. Le correctif X initial traitait déjà correctement les champs
numériques vides comme « non fournis », mais copiait toujours
`notes`/`payment_terms` vides tels quels dans le correctif persisté — et
`kadiV1SharedDocumentPipeline.js`'s `setOptions` fusionne ce correctif à
plat directement sur le document existant. Reproduit directement :

```js
normalizeOptions("FACTURE", {
  tax_rate_basis_points: 1800, discount_amount: "", notes: "", payment_terms: "",
  validity_days: "", payment_method: "", reference: "",
})
// avant correctif → { ok: true, value: { tax_rate_basis_points: 1800, notes: "", payment_terms: "" } }
```

**Conséquence en production réelle : une correction portant uniquement sur
la taxe (le cas le plus courant) aurait silencieusement effacé une note ou
une condition de paiement réelle et déjà enregistrée**, en violation directe
de l'exigence d'acceptation de T1 selon laquelle les champs optionnels
vides ne doivent jamais corrompre l'état persisté.

### Sémantique du texte vide déterminée avant correction

Même règle que pour les champs numériques (« vide = non fourni, jamais
zéro/vidé ») appliquée à `notes`/`payment_terms`, pour la raison suivante :
puisque `EDIT_OPTIONS` ne pré-remplit jamais ces deux champs, un champ vide
soumis par le vrai Flow ne peut structurellement **jamais** distinguer
« le propriétaire n'a rien tapé » de « le propriétaire veut effacer la
valeur existante » — les deux produisent exactement la même soumission.
Choisir « vide = non fourni » est donc la seule interprétation qui ne
risque jamais de perte de donnée silencieuse, au prix d'une conséquence
assumée : il devient structurellement impossible d'effacer une note déjà
enregistrée via ce Flow. **Question produit/UX séparée, non résolue ici** —
consigné en suivi ci-dessous, pas de nouveau sentinel client-contrôlé
inventé (explicitement écarté par la mission). Même règle appliquée sans
distinction à la soumission initiale `DOCUMENT_OPTIONS` : un champ vide y
signifie aussi « pas de note », ce qu'omettre la clé obtient de façon
identique — un seul principe canonique couvre les deux écrans, pas besoin
d'un traitement distinct.

### Correctif

`kadiV1SharedDocumentPolicies.js`'s `normalizeOptions` : la boucle
`notes`/`payment_terms` n'inclut désormais le champ dans le correctif que
si sa valeur n'est pas la chaîne vide (ni `null`) — même principe que
`parseOptionalInteger`, sans réutiliser cette fonction (le texte n'est pas
numérique). Une valeur explicitement non vide continue de mettre à jour
normalement.

Effet de bord découvert pendant la correction, également corrigé dans le
même correctif : une soumission réelle où **tout** est vide (y compris la
taxe) normalise désormais vers un correctif entièrement vide (`{}`), ce que
`kadiV1DocumentDomain.js`'s `modifyDocument` rejette avec
`DOCUMENT_PATCH_INVALID` (il exige un correctif non vide). Corrigé dans
`kadiV1SharedDocumentPipeline.js`'s `setOptions` : un correctif normalisé
entièrement vide (hors RECU, chemin distinct et non atteint par le vrai
Flow) renvoie désormais explicitement le document chargé inchangé, sans
appeler `persistModifiedLoaded` — même comportement de non-événement que le
court-circuit déjà existant côté adaptateur pour une soumission brute
réellement vide, appliqué ici au niveau du correctif normalisé.

### Preuve

* `tests/kadiV1SharedDocumentPipeline.test.js` : reproduction directe suivie
  de quatre nouveaux scénarios — correction taxe seule préserve
  `notes`/`payment_terms` existants et relus après rechargement ;
  soumission initiale avec champs vides ne modifie ni ne corrompt
  `notes`/`payment_terms` ; mise à jour explicite non vide fonctionne
  toujours normalement ; le scénario « soumission entièrement vide » déjà
  existant renforcé pour vérifier explicitement l'absence de changement de
  version (non-événement réel, pas seulement une valeur inchangée par
  coïncidence).
* `tests/kadiV1ReviewEditReturnJourneysE2E.test.js` : nouveau scénario O,
  composition de production réelle complète — document créé avec
  `notes`/`payment_terms` réels non vides → revue → `EDIT_OPTIONS` →
  soumission réelle à sept champs avec seule la taxe changée → document
  rechargé → `notes`/`payment_terms` toujours présents, identiques,
  visibles dans le résumé de revue rafraîchi.
* Focused : 184/184. Suite complète : 1345/1345. `git diff --check` :
  propre.

### Sécurité re-vérifiée

Aucune donnée n'est perdue silencieusement pour le cas réel (correction
partielle) ; une valeur explicitement soumise continue de mettre à jour
normalement ; le comportement `discount_amount`/`validity_days`/
`tax_rate_basis_points`/liste blanche/rejeu/version obsolète du correctif X
reste inchangé (confirmé par la suite complète, aucune régression) ; RECU
non affecté (chemin `setOptions` non atteint par son vrai Flow, confirmé
par lecture du code) ; aucune migration Supabase requise ; aucune mutation
Meta requise.

### Suivi requis (hors périmètre de cette correction)

* **Effacement explicite d'une note existante** : aujourd'hui
  structurellement impossible via `EDIT_OPTIONS` (conséquence assumée de la
  règle « vide = non fourni »). Nécessite soit un vrai pré-remplissage côté
  Meta (mutation de Flow), soit un mécanisme explicite de suppression
  distinct d'un champ simplement laissé vide — question produit/UX séparée,
  non traitée ici.
* **Incohérence d'affichage FACTURE/DEVIS non bloquante** : le Flow
  `DOCUMENT_OPTIONS`/`EDIT_OPTIONS` réel affiche toujours visuellement des
  champs `payment_method`/`reference` pour FACTURE/DEVIS, alors que le
  correctif X les abandonne délibérément (aucune signification
  invoice-level confirmée dans le domaine). L'utilisateur peut donc voir un
  champ qui semble accepté sans jamais avoir d'effet persistant. Non
  bloquant pour T1 (aucune perte de donnée, aucun échec) ; à traiter par une
  future mutation de Flow qui retire ces deux champs de l'écran FACTURE/DEVIS,
  hors périmètre de ce correctif.

### Prévention

Quand un champ Flow n'est **jamais pré-rempli** avec la valeur actuelle du
document (contrairement aux écrans qui rouvrent avec les vraies valeurs),
une soumission vide de ce champ ne peut structurellement jamais exprimer
une intention de le vider — elle ne peut signifier que « non touché ».
Traiter alors systématiquement vide comme absent, jamais comme une valeur
à appliquer, y compris pour du texte libre (pas seulement les champs
numériques déjà couverts par ce principe). Et, plus généralement : quand un
correctif normalisé peut légitimement devenir vide après avoir retiré tous
les champs vides, vérifier que la couche de fusion en aval (ici
`domain.modifyDocument`, qui rejette un correctif vide) est explicitement
gérée par l'appelant plutôt que de laisser échouer une soumission qui ne
change réellement rien.

## Y. HISTORY-CONTRACT-001 — corrigé : le contrat de recherche/ouverture d'historique n'acceptait pas la vraie forme combinée du Flow `HISTORY_SEARCH`

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — nouvelle branche dédiée
  `fix/kadi-v1-history-contract-r0`, créée depuis `main` au commit
  `7f09f624b60b58d2de56eedae086be69883f4dad`. PR distincte, brouillon, non
  fusionnée, non déployée.
* **Origine :** item T2 du backlog produit par l'audit final « FINAL
  ROADMAP GAP AUDIT R0 » (voir fiche X pour T1/`OPTIONS-001`, déjà
  corrigé) : `HISTORY-CONTRACT-001`, même classe de défaut que
  `CLIENT-001`/`EDIT-CONTENT-001`/`OPTIONS-001`, confirmée cette fois pour
  l'écran `HISTORY_SEARCH`.

### Constat, reproduit par exécution réelle

`flows/v1_draft/kadi_history_search_v1.json` est un formulaire combiné
unique : un seul groupe de boutons radio `action` (`SEARCH`/
`OPEN_DOCUMENT`) et un unique pied de page qui soumet toujours ensemble
`query`, `document_type`, `date_from`, `date_to` et `document_id`, quelle
que soit l'action choisie. Avant correctif :

```js
validateActionPayload("HISTORY_SEARCH", "SEARCH", { query: "", document_type: "", date_from: "", date_to: "", document_id: "" })
// → { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" }  (document_id inattendu pour SEARCH)
validateActionPayload("HISTORY_SEARCH", "OPEN_DOCUMENT", { query: "x", document_type: "FACTURE", date_from: "...", date_to: "...", document_id: "doc:1" })
// → { ok: false, error: "KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN" }  (query/document_type/date_from/date_to inattendus pour OPEN_DOCUMENT)
```

**Conséquence en production réelle : aucune recherche ni aucune ouverture
de document depuis l'historique ne pouvait jamais réussir via le vrai
Flow Meta** — la toute première soumission réelle échouait systématiquement,
quelle que soit l'action choisie.

### Deux défauts supplémentaires découverts pendant l'investigation, dans la même chaîne

En traçant `kadiV1FlowCommandRuntime.js`'s `SEARCH` (qui transmet
`{ownerWaId, criteria: data}` à `historyRuntime.search`) jusqu'à
`kadiV1RuntimeAdapters.js`'s `createKadiV1HistoryRuntimeAdapter`, deux
défauts distincts et jusque-là masqués par le rejet `FIELD_FORBIDDEN`
ci-dessus ont été confirmés :

1. **Le texte de recherche réel n'était jamais transmis.** L'adaptateur
   vérifiait `command.query` (un champ à plat) alors que le vrai chemin
   Flow transmet le texte sous `command.criteria.query` (imbriqué) — la
   condition ne se déclenchait donc jamais pour ce chemin, et la ligne
   suivante supprimait purement et simplement la clé `query` du critère
   sans jamais la copier vers `text` (le nom canonique attendu par
   `kadiV1HistoryService.js`). Toute recherche réelle par nom de client ou
   mot-clé aurait silencieusement ignoré ce que l'utilisateur avait tapé.
   (Le chemin conversationnel de `kadiV1ConversationOrchestrator.js`, qui
   appelle `historyRuntime.search({ownerWaId, query, limit})` à plat, n'est
   pas affecté — c'est précisément la forme que l'adaptateur vérifiait
   correctement.)
2. **`date_from`/`date_to` (noms du Flow) ne correspondaient à rien côté
   service.** `kadiV1HistoryService.js`'s `normalizeFilters` ne reconnaît
   que les noms canoniques `from`/`to` — reproduit directement :
   `searchDocuments({filters: {date_from: "...", date_to: "..."}})` →
   `{ok: false, error: "HISTORY_FILTER_UNKNOWN"}`, quelle que soit la
   valeur (même vide). Une fois le premier défaut `FIELD_FORBIDDEN`
   corrigé sans corriger celui-ci, **toute** soumission `SEARCH` réelle
   (même entièrement vide) aurait donc continué à échouer, cette fois à la
   couche service plutôt qu'à la couche Flow.

### Correctif

* `kadiV1FlowReplyRuntime.js`'s `ACTION_FIELDS.SEARCH` élargi pour inclure
  `document_id` (accepté, jamais transmis à la recherche) ;
  `ACTION_FIELDS.OPEN_DOCUMENT` élargi pour inclure `query`/
  `document_type`/`date_from`/`date_to` (acceptés, jamais lus —
  `kadiV1FlowCommandRuntime.js`'s traitement d'`OPEN_DOCUMENT` ne lit que
  `data.document_id`, inchangé).
* `kadiV1RuntimeAdapters.js`'s `createKadiV1HistoryRuntimeAdapter`'s
  `search()` réécrite : nouvelle fonction `nonBlankString` (même
  convention de tolérance au vide que les fiches P/X/X.1 : `""` traité
  comme non fourni) ; `criteria.query` (chemin Flow imbriqué) et
  `command.query` (chemin conversationnel à plat, inchangé) fusionnés vers
  `text` ; `date_from`/`date_to` mappés vers `from`/`to`, la seule
  frontière de traduction entre le vocabulaire du Flow et celui du
  service ; `document_id` jamais transmis au service, quelle que soit sa
  valeur — il ne doit jamais influencer `SEARCH`.
* Aucune modification de `kadiV1HistoryService.js` ni de
  `kadiV1HistoryRepository.js` — leur logique de filtrage
  (`document_type`/`from`/`to`/`text`/...) était déjà correcte ; seule la
  frontière de traduction Flow→service était en cause.

### Preuve

* `tests/kadiV1FlowReplyRuntime.test.js` : reproduction directe des deux
  échecs `FIELD_FORBIDDEN`, plus un test de parité qui dérive la vraie
  forme combinée et les deux actions déclarées directement depuis
  `kadi_history_search_v1.json` (même méthode que les fiches U/V/X).
* `tests/kadiV1RuntimeAdapters.test.js` : nouveaux scénarios prouvant le
  mappage `query`/`date_from`/`date_to` → `text`/`from`/`to`, la
  tolérance au vide (une soumission entièrement vide devient une
  recherche non contrainte, jamais un filtre qui ne correspond à rien), et
  l'abandon de `document_id` — le scénario préexistant du chemin
  conversationnel reste vert sans modification.
* `tests/kadiV1HistorySearchPresentationE2E.test.js` : le générateur de
  dépôt d'historique délègue désormais au vrai
  `createInMemoryV1HistoryRepository` (`kadiV1HistoryRepository.js`) au
  lieu d'ignorer les filtres, ce qui a permis de prouver un filtrage
  réellement discriminant plutôt que simplement accepté sans effet. Onze
  scénarios de composition de production réelle : soumission combinée
  réelle complète (recherche puis ouverture, valeurs `query`/
  `document_type`/`date_from`/`date_to` volontairement obsolètes laissées
  dans le formulaire au moment d'`OPEN_DOCUMENT`, ignorées comme
  attendu) ; `document_id` vide sur `OPEN_DOCUMENT` échoue proprement ;
  champ inconnu toujours rejeté par la chaîne complète ; recherche par
  nom de client ; recherche par type de document ; recherche par
  `date_from`/`date_to` restreignant réellement les résultats ; recherche
  non contrainte renvoyant les vrais `history_options` (jamais l'exemple
  statique du schéma) ; isolation propriétaire (un propriétaire ne peut
  jamais ouvrir le document d'un autre en soumettant son identifiant) ;
  rejeu de `SEARCH` et d'`OPEN_DOCUMENT` reconnus comme doublons sans
  second effet ; parcours de reprise de livraison existant toujours
  atteignable depuis l'historique.
* Focused : 238/238. Suite complète : 1361/1361. `git diff --check` :
  propre.

### Réconciliation du constat terrain (téléphone)

Le constat observé (« recherche trouve 5 documents ; `HISTORY_SEARCH`
rouvert ; tentative d'ouverture/continuation → échec générique ») est
maintenant expliqué de bout en bout par le code, sans supposition :
la fiche S.2 avait déjà corrigé la présentation des résultats de
recherche (texte honnête, `history_options` réels peuplés,
`HISTORY_SEARCH` rouvert) — la recherche « réussissait » donc
visiblement, y compris via le défaut n°1 ci-dessus (un `query` vide ou
silencieusement ignoré ne filtrant simplement rien). Mais l'écran
`HISTORY_SEARCH` réel conserve dans son unique formulaire les valeurs
`query`/`document_type`/`date_from`/`date_to` de l'étape de recherche —
la vraie pression sur « Continuer » avec `action=OPEN_DOCUMENT` soumettait
donc ces quatre champs en plus de `document_id`, et
`ACTION_FIELDS.OPEN_DOCUMENT` (qui n'acceptait alors que `document_id`)
rejetait cette vraie soumission avec `KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN`
— exactement l'« échec générique » observé. Reproduit et fermé par le
scénario E2E ci-dessus, qui soumet délibérément ces quatre champs comme
obsolètes au moment d'`OPEN_DOCUMENT`.

### Sécurité re-vérifiée

Aucun champ arbitraire non déclaré n'est accepté (testé explicitement) ;
`document_id` n'influence jamais `SEARCH` ; `query`/`document_type`/
`date_from`/`date_to` n'influencent jamais quel document `OPEN_DOCUMENT`
ouvre (seul `data.document_id` est lu, inchangé) ; un propriétaire ne peut
jamais ouvrir le document d'un autre en soumettant ou devinant son
identifiant (vérification propriétaire du dépôt inchangée, testée) ;
aucun identifiant WhatsApp complet exposé ; aucune génération, rendu,
débit, réservation ni capture ne se produit lors d'une `SEARCH`/
`OPEN_DOCUMENT` (prouvé structurellement — tous les ports non liés lèvent
une exception au moindre appel) ; rejeu/idempotence inchangés et testés
spécifiquement pour ces deux actions pour la première fois ; le parcours
de reprise de livraison déjà construit (fiche R) reste atteignable depuis
l'historique. Aucune migration Supabase requise ; aucune mutation Meta
requise (le contrat Flow existant reste valide tel quel).

### Suivi requis (hors périmètre de cette correction)

T3 (`RECHARGE-CONTRACT-001`) reste non traité, à corriger dans une mission
séparée. Le `FLOW-PARITY-GATE` global (fiche X) reste un suivi de backlog
distinct — cette correction ajoute la couverture de parité spécifique à
`HISTORY_SEARCH`, sans construire le gate générique.

### Prévention

Même principe que les fiches U/V/X : quand un écran Flow combine plusieurs
actions dans un seul formulaire, vérifier explicitement, à partir du vrai
fichier JSON, que chaque champ qu'il peut soumettre a un traitement
backend explicite pour **chaque** action déclarée — jamais un rejet
générique du fait de la présence d'un champ non pertinent pour l'action en
cours. Et, spécifique à cette fiche : quand un même adaptateur sert deux
appelants réels de formes différentes (ici un chemin conversationnel à
plat et un chemin Flow imbriqué), vérifier explicitement, avec un test qui
construit chaque forme réelle séparément, que le champ pertinent est bien
lu à l'endroit où l'appelant le place réellement — une condition qui
vérifie le mauvais chemin ne produit ni erreur ni avertissement, elle
échoue simplement en silence.

### Y.1 — HISTORY-CONTRACT-001, suite : `date_to` excluait silencieusement le jour de fin d'une recherche par date

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — même branche
  `fix/kadi-v1-history-contract-r0`, PR #18, toujours non fusionnée, non
  déployée.
* **Origine :** revue adversariale indépendante de la PR #18 (mission
  « KADI V1 — T2 HISTORY-CONTRACT-001 INDEPENDENT REVIEW FIX R1 »), constat
  MEDIUM/bloquant de fusion.

### Constat, reproduit avant tout correctif

Le vrai champ Flow `date_to` (libellé « Au ») soumet une date calendaire
brute (`"2026-04-01"`), jamais un horodatage complet. Les deux
implémentations du dépôt d'historique comparent `to` comme une borne
supérieure **inclusive** contre un vrai horodatage
(`issued_at`/`updated_at`) avec `<=` :

* Dépôt de référence en mémoire (`kadiV1HistoryRepository.js`) :
  `new Date(document.issued_at || document.updated_at) > new Date(filters.to)` → exclu.
* RPC Supabase en production, vérifiée en lecture seule dans
  `supabase/migrations/20260803022258_add_kadi_v1_history_search.sql`,
  jamais modifiée :
  `coalesce(d.issued_at, d.updated_at) <= (p_filters->>'to')::timestamptz`.

Une date brute analysée comme horodatage correspond exactement à minuit ce
jour-là. **Conséquence : `date_to: "2026-04-01"` excluait silencieusement
tout document du reste de cette journée** — reproduit directement avant
correctif avec trois documents (31 mars 23h, 1er avril 10h, 2 avril 0h) et
une recherche `from`/`to` = 1er avril/1er avril : résultat vide, alors que
le document du 1er avril 10h aurait dû apparaître.

### Sémantique canonique déterminée avant correction

`from` ne nécessite **aucun** correctif : une date brute s'analyse déjà
comme minuit ce jour-là, exactement la borne inférieure inclusive qu'une
plage calendaire attend. Seul `to` doit être étendu à la toute fin de la
même journée calendaire.

**Fuseau horaire — aucune nouvelle politique inventée :** le Burkina Faso
(Africa/Ouagadougou) est à UTC+0 fixe, sans heure d'été — déjà la
convention produit documentée ailleurs dans le dépôt : `index.js`
(« Burkina = UTC »), `kadiReengagementWorker.js` (« Burkina = UTC+0 »), et
`issued_at_timezone: "Africa/Ouagadougou"` enregistré aux côtés
d'horodatages UTC dans `kadiInvoiceFlowCompletion.js`/
`kadiInvoiceFlowEndpoint.js`. Traiter une date calendaire brute comme un
jour calendaire UTC réutilise cette convention déjà établie, sans en
inventer une nouvelle.

Une date déjà accompagnée d'une composante horaire (un horodatage ISO
complet, déjà une partie existante du contrat du service — voir
`tests/kadiV1HistorySearch.test.js`) reste **intégralement inchangée** :
jamais réinterprétée comme une date calendaire.

### Correctif — la plus petite correction sûre, aucune migration Supabase

Une seule frontière de normalisation, dans `kadiV1HistoryService.js`'s
`normalizeFilters` (le point unique par lequel passent les deux
implémentations de dépôt) : une valeur `to` correspondant exactement au
format `YYYY-MM-DD` est étendue vers `${to}T23:59:59.999Z` avant d'être
transmise au dépôt. Le dépôt en mémoire n'a besoin d'aucune modification
propre (il reçoit déjà la valeur étendue) ; le dépôt Supabase transmet la
valeur telle quelle au RPC, qui la caste en `timestamptz` — un horodatage
explicitement suffixé `Z` est interprété sans ambiguïté par PostgreSQL
quel que soit le fuseau horaire de session, donc compatible avec le `<=`
existant sans aucune modification SQL. **Aucune mutation ni migration
Supabase effectuée ni requise.**

La vérification de plage inversée (`from > to`) utilise désormais la
valeur `to` **étendue** pour la comparaison — nécessaire pour qu'une plage
sur un seul jour (`from === to`) ou un `from` explicite tardif dans la
journée avec un `to` calendaire du même jour ne soit jamais rejetée à tort
comme inversée.

### Preuve

* Reproduction directe avant correctif (script isolé contre
  `kadiV1HistoryService.js`/`kadiV1HistoryRepository.js`, résultat vide),
  confirmée corrigée après (le document du 1er avril 10h apparaît).
* `tests/kadiV1HistorySearch.test.js` : nouveaux scénarios — plage sur un
  seul jour calendaire (inclut le document du jour de fin, exclut le
  lendemain) ; `from` seul ; `to` seul ; plage mars→avril déjà existante
  toujours correcte avec le jour de fin désormais réellement inclusif ;
  horodatage ISO complet explicite préservé exactement, jamais
  réinterprété ; date invalide toujours rejetée après la normalisation ;
  plage réellement inversée toujours rejetée, plage sur un seul jour
  jamais confondue avec une plage inversée ; valeur transmise au RPC
  Supabase vérifiée être l'horodatage de fin de journée étendu (lecture
  seule, aucune mutation).
* `tests/kadiV1HistorySearchPresentationE2E.test.js` : nouveau scénario de
  composition de production réelle utilisant la vraie forme combinée à
  cinq champs — recherche `date_from`/`date_to` = même jour calendaire,
  document du jour de fin inclus, document du lendemain exclu.
* Focused : 115/115 (fichiers concernés). Suite complète : 1367/1367.
  `git diff --check` : propre.

### Sécurité re-vérifiée

Aucune mutation ni migration Supabase ; aucune mutation Meta ; recherche
par texte/type de document inchangée et testée ; `OPEN_DOCUMENT`
inchangé et testé ; isolation propriétaire inchangée et testée ; date
invalide et plage réellement inversée toujours rejetées ; horodatage ISO
complet explicite jamais réinterprété comme une date calendaire.

### Prévention

Quand un filtre de plage inclusif (`<=`) compare une date fournie par
l'utilisateur sous forme calendaire (« Au : 1er avril ») à un horodatage
réel, vérifier explicitement ce qu'une comparaison exacte de date brute
signifie réellement — une date calendaire n'est jamais un instant précis,
c'est une journée entière. Toujours normaliser à la frontière unique par
laquelle passent toutes les implémentations concernées (ici le service,
en amont des deux dépôts), jamais dans chaque implémentation séparément ;
et toujours vérifier la convention de fuseau horaire déjà établie dans le
dépôt avant d'en choisir une, plutôt que d'en inventer une nouvelle.

## Z. RECHARGE-CONTRACT-001 — corrigé : le contrat de sélection de pack/vérification de paiement/annulation n'acceptait pas la vraie forme combinée du Flow `RECHARGE`

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — nouvelle branche dédiée
  `fix/kadi-v1-recharge-contract-r0`, créée depuis `main` au commit
  `07ea815ce016ac4a034498e436db391486b420ff` (PR #18 fusionnée). PR
  distincte, brouillon, non fusionnée, non déployée.
* **Origine :** item T3 du backlog produit par l'audit final « FINAL
  ROADMAP GAP AUDIT R0 » (voir fiche X pour T1/`OPTIONS-001`, fiche Y pour
  T2/`HISTORY-CONTRACT-001`, tous deux déjà corrigés et fusionnés) :
  `RECHARGE-CONTRACT-001`, même classe de défaut que `CLIENT-001`/
  `EDIT-CONTENT-001`/`OPTIONS-001`/`HISTORY-CONTRACT-001`, confirmée cette
  fois pour l'écran `RECHARGE`.

### Constat, reproduit par exécution réelle

`flows/v1_draft/kadi_recharge_v1.json` est un formulaire combiné unique :
un seul groupe de boutons radio `action` (`SELECT_PACK`/`CHECK_PAYMENT`/
`CANCEL`) et un unique pied de page qui soumet toujours ensemble `pack_id`
et `payment_reference`, quelle que soit l'action choisie. Avant correctif,
les trois actions réelles échouaient systématiquement avec
`KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN` — reproduit directement pour chacune.
**Conséquence en production réelle : aucune sélection de pack, aucune
vérification de paiement et aucune annulation de recharge ne pouvait
jamais réussir via le vrai Flow Meta.**

### Contrainte architecturale : `CANCEL` est une action globale partagée

`ACTION_FIELDS.CANCEL` (`[]`) est une entrée **unique**, partagée par
`DOCUMENT_REVIEW`, `DOCUMENT_PREVIEW`, `GENERATION_CONFIRMATION` et
`RECHARGE` — `validateActionPayload(flowKey, action, data)` ne consultait
jusqu'ici que `action`, jamais `flowKey`, pour déterminer la liste blanche
de champs. Élargir `ACTION_FIELDS.CANCEL` globalement aurait fait accepter
silencieusement `pack_id`/`payment_reference` à `DOCUMENT_REVIEW`/
`DOCUMENT_PREVIEW`/`GENERATION_CONFIRMATION` — jamais validé comme
intentionnel, et réouvrant exactement la classe de défaut visée par cette
correction.

**Correctif structurel minimal :** nouvelle table
`FLOW_ACTION_FIELD_OVERRIDES`, consultée en premier dans
`validateActionPayload` (`FLOW_ACTION_FIELD_OVERRIDES[flowKey]?.[action] || ACTION_FIELDS[action] || []`)
— une seule entrée, `RECHARGE.CANCEL`, acceptant `pack_id`/
`payment_reference`. Aucune autre paire (`flowKey`, `action`) n'est
affectée. `SELECT_PACK`/`CHECK_PAYMENT` n'ont, eux, aucun risque
inter-Flow (déclarés uniquement pour `RECHARGE` dans `FLOW_ACTIONS`) et
sont élargis directement dans la table globale `ACTION_FIELDS`, comme pour
`OPTIONS-001`/`HISTORY-CONTRACT-001`.

### Traçage complet de la chaîne : aucun défaut de second niveau trouvé

Contrairement à `OPTIONS-001`/`HISTORY-CONTRACT-001`, le traçage complet
(Flow JSON → `validateActionPayload` → session → `FlowCommandRuntime` →
`kadiV1ProductionInfrastructure.js`'s `createKadiV1RechargeRuntime` →
`kadiV1RechargeService.js`/`kadiV1RechargeRepository.js`/fournisseur de
paiement) n'a révélé **aucun** défaut masqué supplémentaire :

* `kadiV1FlowCommandRuntime.js`'s `SELECT_PACK` ne lit jamais que
  `data.pack_id` ; `CHECK_PAYMENT` ne lit jamais que
  `data.payment_reference` ; `RECHARGE`/`CANCEL` ne transmet aucune
  donnée du tout à l'exécution recharge — les trois ignoraient déjà
  correctement les champs non pertinents avant ce correctif.
* `selectPack()` résout le pack exclusivement depuis le catalogue
  serveur ; `createRechargeSession` rejette explicitement toute
  soumission contenant `amount`/`currency`/`credits`.
* `checkPayment()` vérifie déjà `resolved.value.owner_wa_id !== ownerWaId`
  avant tout accès — isolation propriétaire déjà correcte.
* `cancel()` dérive déjà exclusivement `ownerWaId` du contexte
  authentifié (jamais un identifiant de session/paiement fourni par le
  client) et ne prend même pas `pack_id`/`payment_reference` en
  paramètre.

Le seul défaut réel était la couche `validateActionPayload` — corrigée
ici, sans aucune autre modification de fichier de production.

### Constat annexe enregistré, non corrigé (T4)

`kadi_generation_confirmation_v1.json` est **également** un formulaire
combiné : son unique pied de page soumet toujours `quote_id`, y compris
pour `CANCEL` — mais `ACTION_FIELDS.CANCEL` reste `[]`, donc une vraie
soumission `GENERATION_CONFIRMATION`/`CANCEL` échoue encore aujourd'hui
avec `KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN`, même classe de défaut.
**Volontairement non corrigé dans cette mission** (hors périmètre T3
explicite) — reproduit et consigné par un test dédié qui prouve que ce
défaut reste inchangé, prêt pour un futur T4.

### Preuve

* `tests/kadiV1FlowReplyRuntime.test.js` : reproduction directe des trois
  échecs `FIELD_FORBIDDEN` ; acceptation avec champ non pertinent vide ou
  obsolète pour chaque action ; champ inconnu toujours rejeté ; un champ
  d'autorité financière (`credits`) toujours rejeté
  (`KADI_V1_FLOW_REPLY_AUTHORITY_FIELD_FORBIDDEN`) ; isolation flow-aware
  de `CANCEL` prouvée explicitement sur `DOCUMENT_REVIEW` et
  `DOCUMENT_PREVIEW` (acceptent toujours `{}`, rejettent toujours
  `pack_id`/`payment_reference`) ; défaut `GENERATION_CONFIRMATION`
  consigné, non corrigé ; test de parité qui dérive la vraie forme
  combinée et les trois actions déclarées directement depuis
  `kadi_recharge_v1.json`.
* `tests/kadiV1RechargeContractE2E.test.js` (nouveau) : composition de
  production réelle complète — vrai `createKadiV1RechargeRuntime`
  (`kadiV1ProductionInfrastructure.js`), vrai `kadiV1RechargeService.js`,
  vrai dépôt recharge en mémoire, fournisseur de paiement factice
  (aucun appel réseau réel, aucune mutation Supabase — un faux client
  Supabase minimal implémente uniquement la requête brute en lecture que
  `cancel()` émet, synchronisée avec le vrai dépôt en mémoire). Treize
  scénarios couvrant les seize exigences de la mission : `SELECT_PACK`
  avec forme combinée réelle (`payment_reference` vide ou obsolète),
  pack exact du catalogue sélectionné, aucune donnée client injectée
  (montant/devise/crédits) ; `pack_id` vide échoue proprement ; rejeu
  `SELECT_PACK` idempotent (session et paiement créés au plus une fois) ;
  `CHECK_PAYMENT` avec `pack_id` obsolète ignoré, référence vide échoue
  proprement, isolation propriétaire stricte, rejeu sans double crédit ;
  `CANCEL` avec les deux champs obsolètes ignorés, aucun changement de
  crédit ; champ inconnu rejeté ; `DOCUMENT_REVIEW`/`CANCEL` toujours
  isolé via la chaîne complète ; aucun port document/aperçu/génération
  jamais touché (preuve structurelle).
* Focused : 226/226. Suite complète : 1387/1387. `git diff --check` :
  propre.

### Constat annexe sur le rejeu de `CANCEL`

Contrairement à `SELECT_PACK` (création de session par clé
d'idempotence) et `CHECK_PAYMENT` (crédit confirmé par empreinte
d'événement, également par clé d'idempotence), le vrai chemin
`RECHARGE`/`CANCEL` ne porte aucune clé d'idempotence propre — il
re-résout à chaque fois « la session `CREATED`/`PAYMENT_PENDING` la plus
récente du propriétaire ». **Comportement préexistant, non modifié par ce
correctif** (`cancel()` lui-même n'a subi aucune modification) : un rejeu
exact échoue proprement (`RECHARGE_SESSION_NOT_FOUND`, plus rien à
annuler) plutôt que de silencieusement réussir une seconde fois ou de
corrompre l'état — sûr dans les faits, mais pas signalé `duplicate: true`
par la couche session. Documenté ici, non traité comme un défaut de cette
mission (le `RECHARGE-EXACTLY-ONCE-GATE` dédié reste une tâche séparée).

### Sécurité re-vérifiée

Aucun champ arbitraire non déclaré n'est accepté pour aucune des trois
actions (testé explicitement) ; aucun champ financier fourni par le
client (`amount`/`currency`/`credits`) n'est jamais accepté ; le pack
sélectionné provient exclusivement du catalogue serveur ; l'isolation
propriétaire de `CHECK_PAYMENT` et `CANCEL` reste inchangée et testée à
travers la chaîne complète ; le remplacement flow-aware de `CANCEL` ne
fuit vers aucun autre Flow (testé explicitement pour
`DOCUMENT_REVIEW`/`DOCUMENT_PREVIEW`) ; aucune génération, aucun rendu,
aucune mutation de document ne se produit lors d'une sélection, vérification
ou annulation de recharge (preuve structurelle) ; aucun prix, aucun
nombre de crédits, aucune version de tarification, aucun calcul de
portefeuille modifié. Aucune migration Supabase requise ; aucune
mutation Meta requise ; aucun appel réseau réel vers Orange Money ou tout
autre fournisseur.

### Suivi requis (hors périmètre de cette correction)

* `GENERATION_CONFIRMATION`/`CANCEL` (T4) — même classe de défaut,
  reproduit et consigné, non corrigé.
* Le `FLOW-PARITY-GATE` global (fiche X) reste un suivi de backlog
  distinct.
* Le `RECHARGE-EXACTLY-ONCE-GATE` dédié (durcissement financier
  exactement-une-fois de bout en bout, au-delà de ce que ce correctif de
  contrat de champs prouve) reste une tâche séparée.
* La tarification actuelle des packs (`legacy-v1`) est intentionnellement
  laissée inchangée — la tâche produit « 200 FCFA/crédit » reste future
  et hors périmètre.
* La copie du présentateur pour `RECHARGE` (le Flow rouvert après
  `SELECT_PACK` ne repeuple pas `pack_options`/`balance_summary`, contrairement
  à `HISTORY_SEARCH`'s `history_options` — les instructions de paiement
  elles-mêmes sont bien envoyées comme texte réel) est une question UX,
  pas un défaut de contrat ou de sécurité ; consignée pour une future
  tâche présentateur/recharge, non traitée ici.

### Prévention

Quand une action partagée par plusieurs Flows (ici `CANCEL`) doit
accepter un contrat de champs différent pour un seul de ces Flows, ne
jamais élargir la liste blanche globale de cette action — introduire une
table de correspondance explicitement indexée par `(flowKey, action)`,
consultée en priorité, qui ne modifie le comportement que pour la paire
concernée. Et, comme confirmé ici positivement pour la première fois dans
cette série : un traçage complet de la chaîne peut légitimement ne
révéler aucun défaut de second niveau — le correctif de la liste blanche
suffit alors, et il ne faut pas en chercher un là où il n'y en a pas.

### Z.1 — RECHARGE-CONTRACT-001, suite : `CANCEL` pouvait annuler une recharge appartenant à un contexte Flow différent (HIGH/P0)

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — même branche
  `fix/kadi-v1-recharge-contract-r0`, PR #19, toujours non fusionnée, non
  déployée.
* **Origine :** revue adversariale indépendante de la PR #19 (mission
  « KADI V1 — T3 RECHARGE-CONTRACT-001 INDEPENDENT REVIEW FIX R1 »),
  constat HIGH/P0, bloquant de fusion.

### Constat, reproduit deux fois avant tout correctif

`kadiV1FlowReplyRuntime.js`'s `handle()` appelle
`commands.execute(...)` **sans condition**, même quand
`sessions.consumeReply()` a déjà signalé `consumed.duplicate === true` — le
présentateur supprime ensuite l'affichage à l'utilisateur, mais la
commande métier s'exécute quand même une seconde fois. Pour
`SELECT_PACK`/`CHECK_PAYMENT`, ceci était masqué par leur propre
idempotence par clé plus bas dans la pile
(`createRechargeSession`'s `findSessionByIdempotencyKey`,
`confirmPaymentAndCredit`'s empreinte d'événement). `RECHARGE`/`CANCEL`
n'avait **aucune** clé d'idempotence de ce type :
`createKadiV1RechargeRuntime`'s `cancel({ownerWaId} = {})` ne
déstructurait que `ownerWaId` — la `idempotencyKey` que
`kadiV1FlowCommandRuntime.js` lui transmettait était silencieusement
ignorée — et résolvait toujours à nouveau « la session `CREATED`/
`PAYMENT_PENDING` la plus récente du propriétaire », sans aucune borne.
Vérifié en lecture seule contre la base réelle : aucune contrainte
unique n'impose une seule recharge active par propriétaire, et
`kadi_v1_create_recharge_session` ne l'impose pas non plus — plusieurs
sessions actives séquentielles sont un état de base valide.

**Reproduction A (rejeu exact différé), prouvée dans la composition de
production :** `SELECT_PACK` crée la recharge A → un message `CANCEL` C
annule A avec succès → une nouvelle recharge B est créée pour le même
propriétaire → le même message C exact est rejoué → la couche session
identifie correctement le rejeu comme doublon, **mais la commande
s'exécute quand même** et annule B, la recharge active la plus récente à
ce moment, au lieu de A.

**Reproduction B (Flow obsolète, première soumission réelle), également
prouvée :** un Flow `RECHARGE` est ouvert (jamais encore soumis) → une
recharge B plus récente est créée par un tout autre aller-retour → le
Flow obsolète toujours valide est soumis pour la première fois avec
`action=CANCEL` → **ce n'est pas un rejeu** (`duplicate: false`), pourtant
B pouvait être annulée simplement parce qu'elle était la recharge active
la plus récente au moment de l'annulation.

### Contrat d'exécution de doublon (constat, non modifié dans ce correctif)

Le signal `consumed.duplicate` de la couche session est déjà autoritaire
et déjà utilisé pour supprimer l'affichage utilisateur
(`kadiV1ProductionPresenter.js`'s `presentFlowReply` retourne
immédiatement sans rien envoyer quand `result.duplicate === true`), mais
`handle()` ne l'utilise **pas** pour empêcher une seconde exécution de la
commande métier elle-même. Un raccourci générique dans `handle()` (ne
jamais appeler `commands.execute(...)` quand `consumed.duplicate ===
true`) a été envisagé comme le mécanisme préféré, mais explicitement
**non retenu** ici : aucune preuve exhaustive n'a été établie qu'aucun
Flow existant ne dépend d'une réexécution après un doublon confirmé par
`consumeReply`, et introduire un tel changement générique sans cette
preuve aurait été un risque non maîtrisé pour une mission dont le
périmètre est `RECHARGE`. La correction ci-dessous est donc
délibérément la plus petite solution durable, spécifique à `RECHARGE`.

### Contrat de ciblage de `RECHARGE`/`CANCEL` — correctif

Puisque le vrai Flow `RECHARGE` ne porte aucun `recharge_session_id`
propre, `cancel()` doit nécessairement résoudre « quelle session » depuis
un contexte plutôt qu'un identifiant explicite fourni par le client
(jamais `pack_id`/`payment_reference` pour cela — déjà établi en R0).
**Correctif :** `sessionOpenedAt` — l'instant serveur de confiance
auquel cette session Flow précise a été ouverte, fourni uniquement par
`kadiV1FlowReplyRuntime.js` depuis l'enregistrement de session déjà
authentifié, jamais fourni par le client — borne désormais l'éligibilité
au niveau de `cancel()` : seule une session de recharge créée à ou avant
cet instant peut jamais être ciblée
(`.lte("created_at", sessionOpenedAt)`, ajouté à la requête brute
existante). Une annulation réellement courante ouvre toujours une
session fraîche immédiatement avant sa soumission, donc cette borne
n'exclut jamais une annulation réelle et actuelle — elle exclut
uniquement les sessions de recharge qui n'existaient pas encore quand ce
Flow précis a été ouvert. **Aucune nouvelle colonne Supabase requise** :
`kadi_v1_conversation_sessions.opened_at` et
`kadi_v1_recharge_sessions.created_at` existent déjà toutes les deux —
aucune migration, aucune mutation Supabase.

Plomberie : `kadiV1FlowReplyRuntime.js`'s `handle()` transmet désormais
`sessionOpenedAt: session.opened_at` dans chaque commande (champ neuf,
inoffensif pour toute action qui ne le lit pas — confirmé par régression
complète) ; `kadiV1FlowCommandRuntime.js`'s branche `RECHARGE`/`CANCEL`
valide sa présence (`KADI_V1_FLOW_COMMAND_SESSION_CONTEXT_INVALID` sinon)
et la transmet ; `kadiV1ProductionInfrastructure.js`'s `cancel()` la
valide à nouveau et l'applique à la requête.

### Sémantique du libellé produit — signalée, non modifiée

Le bouton `CANCEL` du vrai Flow `RECHARGE` porte le libellé « Revenir
plus tard » — qui suggère une pause reprenable. Le comportement réel
(`cancelRechargeSession`) place la session en état terminal `CANCELLED` :
`initiatePayment` exige `status === "CREATED"`, et
`confirmPaymentEvent`'s vérification de correspondance exige
`status === "PAYMENT_PENDING"` — une session `CANCELLED` ne peut donc
plus jamais être créditée, même si l'utilisateur paie réellement après
avoir appuyé sur ce bouton ; il faudrait recommencer une toute nouvelle
sélection de pack. **Incohérence entre le libellé et le comportement
signalée telle quelle, non modifiée dans cette mission** — décision
produit à trancher séparément (soit un libellé plus honnête, soit un
véritable état « en pause, reprenable »), hors périmètre de ce correctif
de sécurité de contrat de champs.

### Preuve

* `tests/kadiV1RechargeContractE2E.test.js` : les deux reproductions
  ci-dessus, prouvées d'abord contre le code non corrigé, puis remplacées
  par leurs contreparties de régression fermée après correctif — rejeu
  différé de C laisse B strictement inchangée (`PAYMENT_PENDING`, solde
  inchangé), Flow obsolète échoue proprement
  (`RECHARGE_SESSION_NOT_FOUND`) sans jamais toucher B ; nouveau scénario
  prouvant qu'une annulation réellement courante continue de fonctionner
  normalement (la borne ne bloque jamais un cas réel) ; nouveau scénario
  prouvant que le présentateur n'envoie strictement rien pour une réponse
  dupliquée ; `DOCUMENT_PREVIEW`/`CANCEL` ajouté à la preuve d'isolation
  déjà existante pour `DOCUMENT_REVIEW`/`CANCEL`, à travers la chaîne
  complète.
* `tests/kadiV1FlowCommandRuntime.test.js` : nouveau scénario prouvant
  qu'un `sessionOpenedAt` manquant ou invalide échoue explicitement
  (`KADI_V1_FLOW_COMMAND_SESSION_CONTEXT_INVALID`) sans jamais appeler
  `cancelRecharge` — pas de repli silencieux vers l'ancien comportement
  non borné.
* Un correctif d'horloge de la suite de tests était nécessaire pour que
  ces preuves soient significatives : l'horloge fixe précédemment
  utilisée par la composition de test rendait tous les horodatages
  identiques, masquant silencieusement toute borne temporelle — remplacée
  par une horloge réellement croissante, partagée entre le service de
  session et le service de recharge.
* Focused : 240/240 (fichiers concernés). Suite complète : 1393/1393.
  `git diff --check` : propre.

### Sécurité re-vérifiée

`sessionOpenedAt` provient exclusivement de l'enregistrement de session
déjà authentifié et persisté côté serveur, jamais d'une valeur cliente ;
aucune nouvelle table ni colonne ; la requête Supabase reste paramétrée
(aucun risque d'injection) ; aucun autre appelant réel de `cancel()`
n'existe dans le dépôt en dehors de `kadiV1FlowCommandRuntime.js`
(vérifié) ; isolation propriétaire, rejet des champs inconnus,
comportement `SELECT_PACK`/`CHECK_PAYMENT`, et non-régression T4
(`GENERATION_CONFIRMATION`/`CANCEL` toujours volontairement non corrigé)
tous confirmés inchangés par la suite complète. Aucune migration ni
mutation Supabase, Meta, Render ou WhatsApp réelle.

### Suivi requis (hors périmètre de cette correction)

* Le raccourci générique de doublon dans `kadiV1FlowReplyRuntime.js`'s
  `handle()` reste une option architecturale plus large, non implémentée
  ici faute de preuve exhaustive de son innocuité pour tous les Flows
  existants — à évaluer séparément si un besoin similaire réapparaît
  ailleurs.
* Le `RECHARGE-EXACTLY-ONCE-GATE` dédié (déjà noté en fiche Z) reste une
  tâche séparée.
* Décision produit requise sur la sémantique de « Revenir plus tard »
  (libellé vs état terminal `CANCELLED`) — signalée, non tranchée ici.

### Prévention

Quand une action métier doit résoudre implicitement « sur quelle entité
agir » à partir du contexte plutôt que d'un identifiant explicite fourni
par le client (parce que le vrai contrat Flow n'en porte aucun), vérifier
systématiquement qu'une borne de fraîcheur/appartenance existe et est
appliquée — sans quoi un rejeu différé ou un contexte obsolète peut cibler
une entité totalement différente créée entre-temps. Le signal de doublon
d'une couche ne suffit pas à lui seul : si la couche métier en dessous
peut être réexécutée indépendamment de ce signal, elle doit se protéger
elle-même. Et, quand une correction de sécurité candidate est générique
(ici : court-circuiter toute commande dupliquée), préférer la solution la
plus petite et la plus spécifique dont la sûreté est prouvée dans le
périmètre de la mission, plutôt qu'un changement de comportement large
non prouvé sur l'ensemble du système.

### Z.2 — RECHARGE-CONTRACT-001, suite : `sessionOpenedAt` seul ne suffisait pas quand plusieurs recharges actives préexistaient (HIGH/P0)

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — même branche
  `fix/kadi-v1-recharge-contract-r0`, PR #19, toujours non fusionnée, non
  déployée.
* **Origine :** revue adversariale indépendante de la PR #19 (mission
  « KADI V1 — T3 RECHARGE-CONTRACT-001 INDEPENDENT REVIEW FIX R2 »),
  constat HIGH/P0, bloquant de fusion. Le correctif R1 (`sessionOpenedAt`,
  fiche Z.1) reste correct et inchangé.

### Constat, reproduit avant tout correctif

`sessionOpenedAt` (R1) empêche un `CANCEL` obsolète ou rejoué d'affecter
une recharge créée **après** l'ouverture de cette session Flow, mais ne
rend pas `cancel()` idempotent quand **plusieurs** sessions actives
éligibles existaient déjà **avant** l'ouverture de la session Flow de
`CANCEL`. Rien dans le code n'impose une seule recharge active par
propriétaire : `createRechargeSession()` ne déduplique que par clé
d'idempotence de la commande, et `SELECT_PACK` peut être appelé plusieurs
fois de suite, créant A puis B, toutes deux `PAYMENT_PENDING`, avant
qu'un `CANCEL` ne soit jamais soumis.

**Reproduction, prouvée dans la composition de production :** A et B sont
créées (toutes deux `PAYMENT_PENDING`) → la session Flow C de `CANCEL`
n'est ouverte qu'ensuite → le premier `CANCEL` annule B (la plus récente
éligible), A reste `PAYMENT_PENDING` — comportement R1 correct → le même
message `CANCEL` exact est rejoué → `consumeReply()` identifie
correctement le doublon, mais **avant le correctif R2**, `handle()`
exécutait quand même la commande une seconde fois → la recherche se
résout maintenant sur A (la nouvelle session éligible la plus récente
puisque B est déjà `CANCELLED`) → A est annulée à tort elle aussi.
`sessionOpenedAt` ne protège pas contre ce cas car A **et** B ont toutes
deux été créées avant `C.opened_at`.

### Contrat d'exécution de doublon — décision retenue en R2

Le signal `consumed.duplicate` de `kadiV1ConversationSession.js`'s
`consumeReply()` est déjà autoritaire et persistant : il ne devient `true`
que lorsque la session est déjà `CONSUMED` **et** que
`consumed_reply_key` correspond exactement à la clé d'idempotence
soumise — un état enregistré en base, jamais un indicateur en mémoire de
processus, donc valide après un redémarrage. `RECHARGE`/`CANCEL` reste la
seule action sans clé d'idempotence de commande propre (voir fiche Z.1) ;
c'est donc la seule où ce signal doit **aussi** empêcher une seconde
exécution de la commande elle-même, pas seulement supprimer l'affichage.

**Correctif retenu :** un court-circuit strictement borné à la paire
`(RECHARGE, CANCEL)` dans `kadiV1FlowReplyRuntime.js`'s `handle()` :
quand `consumed.duplicate === true` **et** `flowKey === "RECHARGE"` **et**
`action === "CANCEL"`, `commands.execute(...)` n'est **jamais** appelé —
un résultat `{handled:true, action, flow_key, duplicate:true, result:null}`
est retourné directement, de la même forme que le chemin normal, donc
déjà compatible avec `presentFlowReply` (qui court-circuite lui-même dès
`result.duplicate === true`, avant de jamais lire `result.result`). Un
raccourci générique pour toute commande dupliquée a été explicitement
écarté (voir fiche Z.1) faute de preuve exhaustive de son innocuité pour
les Flows existants ; ce correctif reste donc délibérément scindé et
spécifique.

`input.flowKey`/`input.action` sont déjà dignes de confiance à cet
endroit : `validateReplyEnvelope` (appelée juste avant) a déjà vérifié
`FLOW_ACTIONS[flowKey]?.includes(action)`, et `consumeReply` a déjà
vérifié que la session chargée a bien `expected_flow_key === flowKey` —
aucun risque d'usurpation.

### Compromis de conception assumé, documenté

`consumeReply()` marque la session `CONSUMED` **avant** que
`commands.execute(...)` ne soit appelé, y compris quand ce premier appel
échoue ensuite (ex. erreur transitoire Supabase). Conséquence assumée :
un premier `CANCEL` réellement échoué, puis rejoué via un nouveau webhook
identique, sera désormais lui aussi court-circuité comme doublon — la
reprise automatique par rejeu de webhook n'est plus possible pour
`RECHARGE`/`CANCEL` spécifiquement (elle reste inchangée pour toutes les
autres actions, dont la reprise après échec transitoire reste couverte
par le test préexistant « recoverable command failure can be retried
through consumed-session replay »). C'est le compromis explicitement
demandé par la mission R2 et jugé plus sûr pour une mutation financière
qu'un rejeu automatique incertain : en cas d'échec réel, l'utilisateur
doit rouvrir une nouvelle session Flow `RECHARGE` pour retenter
l'annulation, plutôt que de dépendre d'un rejeu de webhook.

### Preuve

* `tests/kadiV1RechargeContractE2E.test.js` : Test A — deux sessions
  actives A et B préexistant à l'ouverture de la session Flow, premier
  `CANCEL` annule B, rejeu exact du même message laisse A **et** B
  strictement inchangées (aucune seconde mutation) ; Test B — le même
  scénario, mais après reconstruction complète de la pile runtime
  (`FlowReplyRuntime`/`FlowCommandRuntime`/runtime recharge/présentateur/
  composition) autour des **mêmes** dépôts déjà persistés
  (session, recharge, index propriétaire, fournisseur de paiement),
  simulant un redémarrage de processus — la protection survit parce
  qu'elle dérive de l'état de session persisté, jamais d'un indicateur en
  mémoire. Les deux scénarios R1 existants et le scénario d'annulation
  réellement courante mis à jour pour refléter le court-circuit (la
  réponse au rejeu devient désormais `accepted:true, duplicate:true` au
  lieu d'un échec `RECHARGE_SESSION_NOT_FOUND`).
* `tests/kadiV1FlowReplyRuntime.test.js` : test unitaire dédié prouvant
  qu'un rejeu exact de `RECHARGE`/`CANCEL` n'appelle jamais
  `commands.execute` une seconde fois ; trois tests dédiés prouvant que le
  court-circuit ne s'applique **pas** à `DOCUMENT_REVIEW`/`CANCEL`,
  `DOCUMENT_PREVIEW`/`CANCEL` ni `GENERATION_CONFIRMATION`/`CANCEL` — les
  trois continuent d'appeler `commands.execute` une seconde fois sur un
  rejeu exact, comportement générique préexistant totalement inchangé.
* Focused : 248/248 (fichiers concernés). Suite complète : 1399/1399.
  `git diff --check` : propre.

### Sécurité re-vérifiée

`input.flowKey`/`input.action` déjà vérifiés authentiques avant ce point
(aucun risque d'usurpation) ; le court-circuit ne modifie la forme du
résultat d'aucune autre paire Flow/action ; `presentFlowReply` gère déjà
`result.result === null` sur un doublon sans jamais y accéder ; aucune
nouvelle table, colonne ni migration ; isolation propriétaire, contrat de
champs combiné, et non-régression T4
(`GENERATION_CONFIRMATION`/`CANCEL` toujours volontairement non corrigé)
tous confirmés inchangés par la suite complète. Aucune mutation Supabase,
Meta, Render ou WhatsApp réelle.

### Suivi requis (hors périmètre de cette correction)

* Repris de la fiche Z.1 : raccourci générique de doublon dans `handle()`
  toujours non implémenté au-delà de `RECHARGE`/`CANCEL`, décision produit
  sur « Revenir plus tard », `RECHARGE-EXACTLY-ONCE-GATE` dédié.
* Le compromis « pas de reprise automatique par rejeu de webhook pour un
  `CANCEL` réellement échoué » (voir ci-dessus) reste à documenter côté
  produit si un besoin de reprise fiable pour ce cas précis apparaît plus
  tard — non traité ici, comportement jugé acceptable et volontaire pour
  cette mission.

### Prévention

Quand le signal de doublon d'une couche session est utilisé pour empêcher
la réexécution d'une commande, vérifier explicitement à quel moment la
session est marquée consommée par rapport à l'exécution de cette
commande — si la session est marquée consommée avant que la commande
n'ait fini (succès ou échec), le court-circuit empêchera aussi la reprise
d'un échec réellement transitoire pour cette action précise ; documenter
ce compromis plutôt que de le découvrir en production. Et, quand une
première protection (ici `sessionOpenedAt`) semble suffire, vérifier
explicitement qu'elle couvre bien **tous** les états de base valides
possibles avant l'instant de référence choisi — ici, plusieurs entités
actives simultanées pour un même propriétaire étaient un état valide non
couvert par une simple borne temporelle.

### Z.3 — RECHARGE-CONTRACT-001, suite : la requête de ciblage pouvait glisser vers une recharge plus ancienne (HIGH/P0)

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — même branche
  `fix/kadi-v1-recharge-contract-r0`, PR #19, toujours non fusionnée, non
  déployée. Les correctifs R1 (`sessionOpenedAt`, fiche Z.1) et R2
  (court-circuit de doublon, fiche Z.2) restent corrects et inchangés.
* **Origine :** revue adversariale indépendante de la PR #19 (mission
  « KADI V1 — T3 RECHARGE-CONTRACT-001 INDEPENDENT REVIEW FIX R3 »),
  constat HIGH/P0, bloquant de fusion.

### Constat, reproduit avant tout correctif

La requête de ciblage de R1 filtrait le statut (`IN (CREATED,
PAYMENT_PENDING)`) **avant** de trier/limiter à la session contextuelle
la plus récente :

```sql
owner_wa_id = owner
  and status in ('CREATED', 'PAYMENT_PENDING')
  and created_at <= sessionOpenedAt
order by created_at desc
limit 1
```

Si la session qui était réellement la plus récente au moment de
l'ouverture du Flow change ensuite d'état (créditée, annulée par une
autre interaction, etc.) **avant** que `CANCEL` ne soit jamais soumis, le
filtre de statut l'exclut silencieusement et la requête **glisse** vers
une ligne plus ancienne qui correspond encore au filtre de statut et à
la borne `created_at` — annulant une recharge dont ce contexte Flow n'a
jamais parlé, même sur une soumission réellement première (pas un
rejeu).

**Reproduction, prouvée dans la composition de production :** A et B
créées (toutes deux `PAYMENT_PENDING`), B plus récente que A → la session
Flow C de `CANCEL` n'est ouverte qu'après que A et B existent — B est la
recharge contextuelle la plus récente à cet instant → **avant** de
soumettre `CANCEL`, B passe à `CREDITED` via un vrai `CHECK_PAYMENT` →
`CANCEL` est soumis pour la première fois (pas un rejeu) → **avant
correctif**, la requête exclut B (statut filtré) et glisse vers A, qui
est annulée à tort. Variante prouvée également avec B déjà `CANCELLED`
plutôt que `CREDITED`.

### Principe de ciblage retenu

Résoudre la candidate contextuelle **d'abord** :

1. uniquement les sessions créées à ou avant `sessionOpenedAt` (borne de
   confiance déjà établie en R1) ;
2. triées par `created_at` décroissant ;
3. exactement la plus récente, **quel que soit son statut** ;
4. **ensuite seulement** déterminer si cette session précise est
   annulable.

Si la session contextuelle la plus récente n'est plus annulable :
**échec fermé**, jamais de recherche d'une autre recharge plus ancienne.

### Correctif

`createKadiV1RechargeRuntime.cancel()` : la requête brute retire le
filtre `.in("status", ...)` et sélectionne désormais `status` en plus de
`recharge_session_id` ; l'éligibilité au statut est vérifiée **après**
avoir résolu la session contextuelle exacte, contre un ensemble
`CANCELLABLE_STATUSES` explicite (`CREATED`, `PAYMENT_PENDING`) — si la
session résolue n'y figure pas, échec immédiat
(`RECHARGE_SESSION_NOT_CANCELLABLE`), sans jamais retenter une autre
ligne. **L'ensemble annulable visible par ce runtime reste
intentionnellement inchangé** : `kadiV1RechargeService.js`'s
`cancelRechargeSession` accepte déjà aussi `FAILED` en interne (une
question produit préexistante, distincte), mais ce correctif ne l'étend
pas au niveau de ce runtime sans autorisation produit explicite — conforme
à la consigne de la mission de préserver le comportement actuellement
visible.

### Preuve

* `tests/kadiV1RechargeContractE2E.test.js` : Test A — B créditée via un
  vrai `CHECK_PAYMENT` avant la première soumission de `CANCEL`, échec
  fermé (`RECHARGE_SESSION_NOT_CANCELLABLE`), B reste `CREDITED`, A reste
  `PAYMENT_PENDING`, aucun changement de crédit ; Test B — variante avec B
  déjà `CANCELLED` par une annulation réelle distincte, même échec fermé,
  A intacte ; Test C — annulation normale courante avec B toujours active,
  toujours annulée normalement (aucune régression du cas nominal). Le
  fournisseur de paiement factice du fichier a été corrigé pour suivre le
  montant/la devise réels par identifiant de paiement (il renvoyait
  auparavant toujours ceux de `PACK_1000`, provoquant un
  `PAYMENT_EVENT_MISMATCH` dès qu'un autre pack était crédité) — défaut de
  fixture de test, pas de code de production.
* Régression complète R0+R1+R2 : tous les scénarios existants
  (`SELECT_PACK`/`CHECK_PAYMENT` inchangés, isolation propriétaire,
  isolation `DOCUMENT_REVIEW`/`DOCUMENT_PREVIEW`/`GENERATION_CONFIRMATION`,
  rejeu exact R2 avec sa protection après reconstruction complète de la
  pile) toujours verts sans modification de leur logique.
* Focused : 251/251 (fichiers concernés). Suite complète : 1402/1402.
  `git diff --check` : propre.

### Sécurité re-vérifiée

`status` n'est jamais journalisé ni exposé à l'utilisateur (utilisé
uniquement en interne pour la vérification d'éligibilité) ; la
vérification finale de statut au niveau de `cancelRechargeSession`'s
`expectedStatuses` reste un filet de sécurité supplémentaire contre toute
condition de course entre la lecture et l'écriture (préexistant,
inchangé) ; isolation propriétaire, contrat de champs combiné, protection
R1 (`sessionOpenedAt`) et protection R2 (court-circuit de doublon) tous
confirmés inchangés par la suite complète ; non-régression T4
(`GENERATION_CONFIRMATION`/`CANCEL` toujours volontairement non corrigé).
Aucune migration ni mutation Supabase, Meta, Render ou WhatsApp réelle.

### Suivi requis (hors périmètre de cette correction)

* Reprises des fiches Z.1/Z.2 : décision produit sur « Revenir plus
  tard », `RECHARGE-EXACTLY-ONCE-GATE` dédié, raccourci générique de
  doublon non implémenté au-delà de `RECHARGE`/`CANCEL`.
* Question produit distincte, non traitée : `cancelRechargeSession`
  accepte déjà `FAILED` en interne alors que ce runtime ne l'expose pas —
  à clarifier si un besoin produit d'annuler explicitement une recharge
  `FAILED` apparaît.

### Prévention

Quand une requête combine un filtre de sélection (ici le statut) avec un
tri/limite destiné à choisir « le candidat contextuellement pertinent »,
vérifier explicitement l'ordre d'application : filtrer d'abord peut faire
glisser silencieusement le résultat vers un candidat différent de celui
réellement visé par le contexte, si le vrai candidat contextuel ne
correspond plus au filtre au moment de la requête. Résoudre toujours le
candidat contextuel en premier (sans filtre de statut), puis appliquer
la validation de statut comme une décision séparée et fermée sur cette
cible exacte — jamais comme un filtre qui élargit implicitement la
recherche à un autre candidat.

## AA. GENERATION_CONFIRMATION-001 — corrigé : le contrat d'annulation de confirmation de génération n'acceptait pas la vraie forme combinée du Flow `GENERATION_CONFIRMATION`

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — branche isolée dédiée
  `fix/kadi-v1-generation-confirmation-cancel-t4`, créée depuis
  `main@71362c71a5524d1c24192f584ca3cb7f3fe20785` (PR #19/T3 déjà
  fusionnée), PR brouillon ouverte, non fusionnée, non déployée.
* **Origine :** mission « KADI V1 — T4 GENERATION_CONFIRMATION/CANCEL
  ROOT-CONTRACT FIX », faisant suite au constat déjà consigné et
  volontairement laissé non corrigé dans les fiches Z/Z.1/Z.2/Z.3 (T3).

### Constat, reproduit avant tout correctif

Le vrai Flow Meta combiné `flows/v1_draft/kadi_generation_confirmation_v1.json`
n'a qu'un seul écran (`GENERATION_CONFIRMATION`) et un seul Footer, qui
soumet toujours :

```json
{ "quote_id": "${data.quote_id}" }
```

— quelle que soit l'action choisie par l'utilisateur
(`CONFIRM_GENERATION` ou `CANCEL`), exactement le même défaut de classe
que `CLIENT-001`/`EDIT-CONTENT-001`/`OPTIONS-001`/`RECHARGE-CONTRACT-001`.
Avant correctif : `ACTION_FIELDS.CONFIRM_GENERATION` acceptait déjà
`quote_id`, mais `ACTION_FIELDS.CANCEL` est globalement `[]` (correct pour
`DOCUMENT_REVIEW`/`DOCUMENT_PREVIEW`, dont le vrai Flow ne soumet aucune
donnée pour `CANCEL`) — donc toute vraie soumission
`GENERATION_CONFIRMATION`/`CANCEL` échouait systématiquement à la
frontière de validation avec `KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN`, avant
même d'atteindre le chemin d'annulation de document existant. Reproduit
directement par `validateActionPayload("GENERATION_CONFIRMATION",
"CANCEL", { quote_id: "quote:1" })`, qui retournait cette erreur avant
correctif (test dédié dans
`tests/kadiV1FlowReplyRuntime.test.js`, préexistant depuis T3 — voir fiche
Z).

### Modèle d'autorité d'annulation (inspecté, confirmé correct, non modifié)

`quote_id` est un champ incident du formulaire combiné réel : il ne doit
jamais devenir une autorité de ciblage pour savoir quel document annuler.
Inspection du chemin complet **avant toute modification** :

`kadiV1FlowCommandRuntime.js`'s `execute()` : pour `(CANCEL,
GENERATION_CONFIRMATION)`, la branche spéciale `(CANCEL, RECHARGE)` ne
s'applique pas (flowKey différent) — la commande tombe dans la branche
générique de document, qui construit `documentBase` uniquement à partir de
`command.documentContext` (jamais `command.data`) et route vers
`documentRuntime.cancel(documentBase)`. `command.documentContext` lui-même
provient exclusivement de `kadiV1FlowReplyRuntime.js`'s `handle()`, à
partir du contexte document de la session serveur de confiance
(`session.document_id`/`document_version`/`document_type`/`document_state`),
jamais du payload client. `createKadiV1DocumentRuntimeAdapter.cancel()`
(`kadiV1RuntimeAdapters.js`) ne lit ensuite que
`ownerWaId`/`documentId`/`expectedVersion`/`documentType` — jamais
`command.data` — avant de router vers `shared.cancelDocument`/
`discharge.cancelDischarge`. **Ce modèle était déjà correct avant T4 et
n'a nécessité aucune modification.**

### Correctif

Un seul fichier de production modifié, `kadiV1FlowReplyRuntime.js` : ajout
d'une entrée `GENERATION_CONFIRMATION: { CANCEL: ["quote_id"] }` dans la
table `FLOW_ACTION_FIELD_OVERRIDES` déjà introduite en T3 pour exactement
cette classe de défaut — consultée avant le tableau global
`ACTION_FIELDS`, et remplaçant entièrement sa recherche pour la paire
`(flowKey, action)` concernée sans toucher aux autres. `CONFIRM_GENERATION`
n'a pas d'entrée dans cette table et continue de résoudre `quote_id` via
`ACTION_FIELDS.CONFIRM_GENERATION`, inchangé. `RECHARGE`/`CANCEL` (T3),
`DOCUMENT_REVIEW`/`CANCEL` et `DOCUMENT_PREVIEW`/`CANCEL` restent
inchangés — chaque entrée de la table est indépendante par `flowKey`.
Aucune modification de `kadiV1FlowCommandRuntime.js`, `kadiV1RuntimeAdapters.js`,
`kadiV1SharedDocumentPipeline.js`, `kadiV1DischargePipeline.js` ni
`kadiV1DocumentStateMachine.js` — le modèle d'autorité et la sémantique de
`CANCEL` (`AWAITING_GENERATION_CONFIRMATION → CANCELLED`, terminal, déjà
présente dans `TRANSITIONS`) étaient déjà corrects.

### Traçage complet de la chaîne (défauts de second niveau masqués)

Chaîne inspectée en entier après la levée du premier défaut : Flow JSON →
`FlowReplyRuntime` → session de conversation → `FlowCommandRuntime` →
`documentRuntime.cancel` → pipeline partagé/décharge → dépôt document/
version → présentateur. **Aucun défaut de second niveau masqué trouvé** :

* **Rejeu exact.** L'annulation de document a déjà sa propre idempotence,
  indépendante et préexistante, au niveau du pipeline document partagé
  (`replayFor` dans `kadiV1SharedDocumentPipeline.js`, clé dérivée de
  l'idempotencyKey de la commande Flow) — contrairement à
  `RECHARGE`/`CANCEL` (T3), qui n'avait aucune clé d'idempotence propre.
  **Aucun court-circuit spécifique de doublon copié depuis T3** : la
  mission demandait explicitement de ne pas généraliser ce mécanisme sans
  preuve dédiée, et cette preuve dédiée confirme qu'il n'est pas
  nécessaire ici.
* **Version/état obsolète.** Constat confirmé par inspection directe de
  `kadiV1DocumentDomain.js`'s `transitionDocument` : les transitions
  d'état pures (`CANCEL` inclus, et toutes les transitions sortantes
  possibles depuis `AWAITING_GENERATION_CONFIRMATION`) ne font **jamais**
  avancer `document.version` — seules les mutations de contenu
  (`modifyDocument`, utilisées par `SAVE_CLIENT`/`ADD_CONTENT`/
  `SAVE_OPTIONS`, etc.) le font, et aucune n'est atteignable une fois le
  document rendu à `AWAITING_GENERATION_CONFIRMATION`. Le risque réel pour
  un Flow `GENERATION_CONFIRMATION`/`CANCEL` obsolète n'est donc pas une
  course de version mais une **course d'état** : si le document a déjà
  basculé ailleurs (par exemple déjà `CANCELLED` par une interaction
  différente), la vérification `fromState` du pipeline document
  (`loadMutation`), combinée à la table `TRANSITIONS` (aucune arête
  sortante depuis `CANCELLED`), échoue fermé de façon tout aussi fiable —
  sans jamais introduire de champ de version contrôlé par le client, et
  sans étape de sélection de candidat pouvant glisser vers un autre
  document (l'identité du document reste toujours l'identifiant de session
  de confiance, jamais choisie par une requête).
* **Devis (quote).** `kadiV1GenerationQuoteService.js` inspecté : aucune
  réservation ni capture de crédit à la création du devis
  (`createGenerationQuote`) — uniquement du tarifage. `CANCEL` ne touche
  jamais le devis directement, mais toute tentative future de l'utiliser
  (par exemple un `CONFIRM_GENERATION` obsolète sur le même document)
  échoue déjà via `kadiV1GenerationLifecycleService.js`'s
  `confirmOrRetryGeneration`, qui vérifie `document.status ===
  "AWAITING_GENERATION_CONFIRMATION"` en premier — un document `CANCELLED`
  échoue immédiatement, avant même la validation du devis.

### Preuve

* `tests/kadiV1FlowReplyRuntime.test.js` : contrat combiné réel accepté
  pour `CANCEL` (`quote_id` inclus, y compris vide), champ non déclaré
  toujours rejeté, non-fuite vers `DOCUMENT_REVIEW`/`DOCUMENT_PREVIEW`/
  `RECHARGE`, non-régression de `CONFIRM_GENERATION`, parité Flow/backend
  dérivée directement de `kadi_generation_confirmation_v1.json`.
* `tests/kadiV1GenerationConfirmationCancelE2E.test.js` (nouveau, 12
  scénarios) : composition de production réelle (domaine document réel,
  pipeline partagé réel, dépôt document en mémoire réel, service
  d'aperçu/rendu/devis réel avec stockage en mémoire, seuls les ports
  onboarding/recharge/historique/portefeuille/livraison sont des bouchons
  qui lèvent une exception au moindre appel — `generationRuntime.confirm`
  est un espion qui enregistre les appels, jamais un bouchon, pour prouver
  positivement la non-régression de `CONFIRM_GENERATION`) — un vrai
  FACTURE est mené jusqu'à `AWAITING_GENERATION_CONFIRMATION` via le vrai
  pipeline aperçu/rendu/devis (PDF réel via `pdf-lib`, aucune donnée
  fabriquée à la main) : annulation réelle avec le vrai `quote_id`
  acceptée et transitionne le document à `CANCELLED` ; deux documents A/B
  du même propriétaire — le Flow de A ne peut jamais annuler B même avec
  le vrai `quote_id` de B dans le payload ; isolation propriétaire ; Flow
  obsolète après que le document a déjà basculé ailleurs échoue fermé sans
  seconde mutation ; rejeu exact reconnu comme doublon sans seconde
  transition ; zéro appel à `generationRuntime.confirm`, zéro appel
  crédit/portefeuille/livraison structurellement prouvé ; champ inconnu
  rejeté ; isolation `DOCUMENT_REVIEW`/`DOCUMENT_PREVIEW`/`RECHARGE`
  (contrat T3 non affecté) ; `CONFIRM_GENERATION` toujours fonctionnel de
  bout en bout avec le vrai `quote_id` atteignant `generation.confirm`.
* Focused : 287/287 (fichiers concernés, dont l'ensemble T1/T2/T3 déjà
  fusionné). Suite complète : 1418/1418. `git diff --check` : propre.

### Sécurité re-vérifiée

`quote_id` n'est jamais journalisé ni utilisé comme sélecteur — seul le
contexte document de session (jamais le payload) détermine le document
affecté ; isolation propriétaire confirmée inchangée ; contrat
`RECHARGE`/`CANCEL` (T3, R0–R3) confirmé inchangé par la suite complète ;
`DOCUMENT_REVIEW`/`DOCUMENT_PREVIEW`/`CANCEL` confirmés inchangés. Un seul
fichier de production modifié, ajout strictement additif. Aucune migration
ni mutation Supabase, Meta, Render ou WhatsApp réelle ; aucun rendu PDF
réel ; aucune génération réelle.

### Suivi requis (hors périmètre de cette correction)

* `FLOW-PARITY-GATE` global — toujours un suivi de backlog distinct, non
  construit dans cette mission.
* T5 — prochaine mission de correction dédiée, non commencée (périmètre à
  définir).
* Validation téléphone réelle requise après un déploiement éventuel, comme
  pour toute correction de cette famille.

### Prévention

Même classe de défaut que `CLIENT-001`/`EDIT-CONTENT-001`/`OPTIONS-001`/
`RECHARGE-CONTRACT-001` : tout écran Meta Flow combiné (un seul Footer,
plusieurs actions) doit être vérifié directement contre le JSON réel du
Flow avant de faire confiance à un allowlist de champs par action —
`ACTION_FIELDS`/`FLOW_ACTIONS` déclarés dans le code ne garantissent rien
sur ce que Meta soumet réellement. Quand une action (ici `CANCEL`) est
partagée par plusieurs Flows avec des contrats de champs différents,
utiliser systématiquement `FLOW_ACTION_FIELD_OVERRIDES` (jamais élargir
l'entrée globale) — et vérifier explicitement, comme ici, que le champ
incident ajouté ne devient jamais une autorité de ciblage pour l'entité
affectée par l'action.

### AA.1 — GENERATION_CONFIRMATION-001, suite : une session obsolète pouvait annuler un document ayant changé de phase métier (HIGH/P0)

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — même branche
  `fix/kadi-v1-generation-confirmation-cancel-t4`, PR #20, toujours non
  fusionnée, non déployée. Le correctif R0 (override de champ `quote_id`,
  fiche AA) reste correct et inchangé.
* **Origine :** revue adversariale indépendante de la PR #20 (mission
  « KADI V1 — T4 GENERATION_CONFIRMATION/CANCEL INDEPENDENT REVIEW FIX
  R1 »), constat HIGH/P0, bloquant de fusion.

### Constat, reproduit avant tout correctif

`kadiV1FlowCommandRuntime.js` porte déjà `document.value.document_state`
(le statut du document capturé au moment où la session Flow a été
ouverte) dans `documentBase.documentState`, mais
`createKadiV1DocumentRuntimeAdapter.cancel()`
(`kadiV1RuntimeAdapters.js`) ne le lisait jamais — il ne transmettait que
`ownerWaId`/`documentId`/`expectedVersion`/`idempotencyKey` aux pipelines
d'annulation. Ces pipelines chargent alors le document **courant** et
appliquent `CANCEL` depuis son état **courant**, en ne vérifiant que la
version (`loadMutation`), jamais l'état attendu par la session Flow.

Or, confirmé par inspection directe de `kadiV1DocumentDomain.js`'s
`transitionDocument` (déjà établi en fiche AA) : les transitions d'état
pures ne font **jamais** avancer `document.version`. La machine d'état
(`kadiV1DocumentStateMachine.js`) autorise en outre `CANCEL` aussi bien
depuis `RECHARGE_REQUIRED` que depuis `GENERATION_IN_PROGRESS`. Une
session `GENERATION_CONFIRMATION` obsolète, ouverte pendant que le
document était `AWAITING_GENERATION_CONFIRMATION`, pouvait donc encore
annuler à tort ce même document après qu'une interaction plus récente
l'ait fait légitimement basculer vers une autre phase métier — y compris
pendant une génération réellement en cours.

**Reproduction A (RECHARGE_REQUIRED), prouvée dans la composition de
production, pile de génération réelle, avant correctif :** document réel
mené jusqu'à `AWAITING_GENERATION_CONFIRMATION` → session obsolète
`S_old` ouverte → un vrai `CONFIRM_GENERATION` frais, avec un solde
insuffisant, fait légitimement basculer le document vers
`RECHARGE_REQUIRED` (`document.version` inchangé, confirmé) → `S_old` /
`CANCEL` soumis pour la première fois → **avant correctif**, accepté à
tort, document annulé alors qu'il aurait dû rester `RECHARGE_REQUIRED`.

**Reproduction B (GENERATION_IN_PROGRESS, scénario financier HIGH/P0),
prouvée avec une barrière déterministe sur le renderer réel (jamais un
`sleep`) insérée dans le point d'E/S injecté
(`finalGenerationService`'s renderer) :** un vrai `CONFIRM_GENERATION`
frais réserve les crédits, persiste `START_GENERATION`
(`GENERATION_IN_PROGRESS`, version inchangée), puis se bloque
exactement au point d'appel du renderer — après la persistance de
l'état, avant la capture. Pendant que la génération est réellement en
vol (réservation `RESERVED` confirmée), `S_old` / `CANCEL` est soumis
pour la première fois → **avant correctif**, accepté à tort, document
annulé mid-génération sans libérer la réservation ni nettoyer la
tentative de génération. Même défaut confirmé, avec le même schéma de
reproduction, sur la pipeline `DECHARGE` (`kadiV1DischargePipeline.js`).

### Modèle d'autorité d'état retenu

Le contexte de session — `document_id`/`document_version`/
`document_type`/`document_state` — reste la seule source de confiance,
jamais le payload client. Pour `GENERATION_CONFIRMATION`/`CANCEL`,
l'état attendu authentique est exactement `AWAITING_GENERATION_CONFIRMATION` :
une session Flow n'est jamais légitimement ouverte ailleurs (confirmé :
`kadiV1GenerationQuoteService.js`'s `createGenerationQuote` persiste
`CALCULATE_COST` et `REQUEST_GENERATION_CONFIRMATION` dans le même appel
réussi — un état `COST_CALCULATED` durable et visible au présentateur
n'existe pas sur le chemin de succès).

### Exigence d'atomicité

Une vérification à un niveau supérieur (`getDocumentById()` puis
`if (status === expected)` puis `cancel()`) aurait laissé une fenêtre
TOCTOU entre la lecture et l'écriture. La condition d'état attendu doit
participer au **même contrat de mutation durable** que l'annulation
elle-même — c'est-à-dire réutiliser la vérification atomique
`row.status === fromState` que `repository.persistTransition` effectue
déjà au moment du commit, jamais l'inventer à un niveau séparé.

### Correctif

Conception « la plus petite garantie durable » :

1. `kadiV1FlowCommandRuntime.js` : nouvelle branche dédiée pour
   `(CANCEL, GENERATION_CONFIRMATION)`, avant le chemin générique de
   document (partagé par `DOCUMENT_REVIEW`/`DOCUMENT_PREVIEW`/`CANCEL`,
   inchangé). Vérifie d'abord que la session Flow de confiance a
   effectivement été capturée avec `document_state ===
   "AWAITING_GENERATION_CONFIRMATION"` (échec fermé immédiat sinon —
   `KADI_V1_FLOW_COMMAND_GENERATION_CONFIRMATION_STATE_INVALID`), puis
   transmet `expectedState: "AWAITING_GENERATION_CONFIRMATION"` (une
   constante serveur, jamais dérivée du client) dans `documentBase`.
2. `kadiV1RuntimeAdapters.js`'s `cancel()` : `command.expectedState` est
   optionnel — validé contre `DOCUMENT_STATES` s'il est présent, puis
   transmis tel quel aux pipelines. Chaque autre appelant de `CANCEL`
   (`DOCUMENT_REVIEW`, `DOCUMENT_PREVIEW`) ne le fournit jamais et reste
   complètement inchangé.
3. `kadiV1SharedDocumentPipeline.js`'s `persistStateTransition` et
   `kadiV1DischargePipeline.js`'s `persistTransition` : quand
   `command.expectedState` est fourni, il est comparé au `loaded.value.status`
   déjà lu par `loadMutation()` — **aucune lecture supplémentaire,
   aucune fenêtre TOCTOU élargie** — avant même de tenter la transition
   (`DOCUMENT_CANCEL_STATE_MISMATCH` sinon). La vérification atomique
   `row.status === fromState` déjà existante dans
   `storage.persistTransition` reste le filet final contre toute course
   réelle survenant entre cette lecture et le commit. `markReadyForReview`/
   `verifyDocument`/`verifyDischarge` ne fournissent jamais
   `expectedState` — inertes, complètement inchangés.

### Preuve

* `tests/kadiV1GenerationConfirmationCancelStateAuthorityE2E.test.js`
  (nouveau, 12 scénarios, pile de génération réelle — service de
  réservation de portefeuille réel, service de génération finale réel
  avec stockage en mémoire, service de livraison réel avec fournisseur
  synthétique, dépôt de cycle de vie de génération en mémoire réel) :
  Reproduction A (RECHARGE_REQUIRED) et B (GENERATION_IN_PROGRESS,
  barrière déterministe) **prouvées concrètement avant correctif** (le
  correctif de production a été temporairement retiré via `git stash`
  puis restauré, exactement comme pour les rounds R1/R2/R3 de
  RECHARGE-CONTRACT-001) ; annulation courante non obsolète toujours
  fonctionnelle ; après rejet de l'annulation obsolète pendant la
  génération en vol, la libération de la barrière permet à la génération
  fraîche de se terminer normalement avec exactement une réservation,
  une capture, un fichier final et une livraison — aucun
  `DOCUMENT_STATE_CONFLICT` causé par la tentative obsolète ; rejeu exact
  de `CANCEL` toujours idempotent ; isolation propriétaire ; isolation
  multi-documents ; non-pertinence de `quote_id` ; non-régression de
  `CONFIRM_GENERATION` (cycle complet réel jusqu'à `DELIVERED`) ; même
  scénario RECHARGE_REQUIRED reproduit et corrigé sur la pipeline
  `DECHARGE`, annulation courante DECHARGE toujours fonctionnelle ;
  `DOCUMENT_REVIEW`/`CANCEL` toujours fonctionnel sans jamais référencer
  `AWAITING_GENERATION_CONFIRMATION` ; contrat `RECHARGE`/`CANCEL` (T3)
  inchangé.
* Régression complète R0 (contrat de champ `quote_id`) : tous les
  scénarios existants toujours verts sans modification de leur logique.
* Focused : 378/378 (fichiers concernés, dont T1/T2/T3 déjà fusionnés).
  Suite complète : 1430/1430. `git diff --check` : propre.

### Sécurité re-vérifiée

`expectedState` n'est jamais dérivé d'un payload client — soit une
constante serveur (`GENERATION_CONFIRMATION_CANCEL_EXPECTED_STATE`), soit
absent. Aucune fuite vers `DOCUMENT_REVIEW`/`DOCUMENT_PREVIEW`/`CANCEL`
(ces appelants ne le fournissent jamais). Comportement générique
d'annulation non affaibli pour aucun autre Flow. Contrat T3
(`RECHARGE`/`CANCEL`, R0–R3) confirmé inchangé par la suite complète.
Aucune migration ni mutation Supabase, Meta, Render ou WhatsApp réelle ;
aucune génération, capture ou livraison réelle (fournisseurs synthétiques
en mémoire uniquement).

### Suivi requis (hors périmètre de cette correction)

* `FLOW-PARITY-GATE` global — toujours un suivi de backlog distinct.
* T5 — prochaine mission de correction dédiée, non commencée.
* Validation téléphone réelle requise après un déploiement éventuel.
* Question ouverte, non traitée dans cette correction : la même classe de
  risque (session Flow obsolète autorisant une transition d'état après
  que le document a changé de phase, sans bump de version) pourrait
  exister ailleurs dans le produit partout où une session Flow porte un
  `document_state` de confiance non vérifié au moment de la mutation —
  seul `GENERATION_CONFIRMATION`/`CANCEL` a été corrigé ici, car c'est le
  seul Flow dont l'état d'origine précède immédiatement des opérations
  financières réelles (réservation, capture, génération, livraison) ;
  toute généralisation nécessiterait sa propre mission et preuve dédiées.

### Prévention

Un champ de contexte de session capturé au moment de l'ouverture d'un
Flow (ici `document_state`) n'est fiable qu'au moment de cette capture —
jamais implicitement au moment du commit. Si une opération de mutation
d'état doit rester bornée à l'état dans lequel son Flow d'origine a été
ouvert, cette borne doit être vérifiée explicitement, contre l'état
**réellement lu** au moment de la mutation, et participer au même
contrat atomique que la mutation elle-même — jamais une vérification
séparée à un niveau supérieur, qui rouvrirait une fenêtre TOCTOU. Ne pas
supposer qu'un identifiant de version inchangé signifie qu'aucun
changement métier significatif n'a eu lieu : certaines transitions
(les transitions d'état pures, ici) ne font délibérément pas avancer la
version.

## AA.2 — T4.5/DOCUMENT_CANCEL_STATE_AUTHORITY_GATE : le même défaut d'autorité d'état de session obsolète existait pour `DOCUMENT_REVIEW`/`CANCEL` et `DOCUMENT_PREVIEW`/`CANCEL`

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** — nouvelle branche isolée
  `fix/kadi-v1-document-cancel-state-authority-t4-5`, créée depuis
  `main@a2c2ead17e109c2de5c46905c291f5133cc817ab` (PR #20/T4 déjà
  fusionnée), PR brouillon ouverte, non fusionnée, non déployée.
* **Origine :** revue adversariale indépendante de la PR #20 lors de sa
  fusion (mission « KADI V1 — T4.5 GLOBAL DOCUMENT CANCEL
  STATE-AUTHORITY GATE »), constat HIGH/P0.

### Constat, reproduit avant tout correctif

Le correctif R1 de T4 (fiche AA.1) n'avait fermé cette classe de défaut
que pour `GENERATION_CONFIRMATION`/`CANCEL`. `DOCUMENT_REVIEW`/`CANCEL`
et `DOCUMENT_PREVIEW`/`CANCEL` routaient tous deux, sans aucune
modification depuis T3, par la branche générique de document de
`kadiV1FlowCommandRuntime.js`, qui ne transmet jamais `expectedState`.
Comme les transitions d'état pures ne font jamais avancer
`document.version` (confirmé en fiche AA), une session `DOCUMENT_REVIEW`
ou `DOCUMENT_PREVIEW` obsolète pouvait encore annuler à tort un document
ayant légitimement changé de phase métier depuis l'ouverture de cette
session précise.

**Preuve d'architecture, établie avant toute correction :** ouvrir une
nouvelle session Flow ne révoque jamais les sessions `OPEN` précédentes.
`kadiV1ConversationSession.js`'s `open()` ne fait que créer une nouvelle
ligne ; `revoke()` existe mais n'a **aucun appelant en production**
(seul `kadiInvoiceFlowSession.js`, le module legacy pré-V1 sans rapport,
appelle une fonction de même nom). Plusieurs sessions `OPEN` peuvent donc
authentiquement coexister pour le même propriétaire — une soumission
obsolète est un scénario toujours possible en production, jamais
seulement théorique.

**États légitimes de chaque Flow, tracés depuis le routage réel de
production (jamais devinés depuis la seule connectivité de la machine
d'état) :** `kadiV1ProductionPresenter.js`'s `routeDocument` et
`kadiV1ConversationOrchestrator.js`'s `routeForDocument` s'accordent
exactement : `DOCUMENT_REVIEW` n'est routé que depuis
`READY_FOR_REVIEW` (état unique) ; `DOCUMENT_PREVIEW` est routé depuis
`VERIFIED` (cas normal après `VERIFY`) et depuis `PREVIEW_READY` — un
état de repos réel et durable, confirmé par inspection de
`kadiV1PreviewService.js`'s `persistPreview` (qui exige `VERIFIED` puis
persiste `PREPARE_PREVIEW` → `PREVIEW_READY`) et de
`kadiV1GenerationQuoteService.js`'s `createGenerationQuote` (qui exige
`PREVIEW_READY` avant de calculer le devis) : si une étape ultérieure du
même appel `prepare()` échoue (par exemple la création du devis), le
document reste authentiquement à `PREVIEW_READY`.

**Reproduction A1/A2 (`DOCUMENT_REVIEW`), prouvée dans la composition de
production, avant correctif :** document réel mené jusqu'à
`READY_FOR_REVIEW` → session obsolète `R_old` ouverte → un vrai `VERIFY`
frais fait légitimement basculer le document vers `VERIFIED`
(`document.version` inchangé, confirmé) → `R_old`/`CANCEL` soumis pour la
première fois → **avant correctif**, accepté à tort, document annulé
alors qu'il aurait dû rester `VERIFIED`. Variante A2 poussée plus loin
jusqu'à `AWAITING_GENERATION_CONFIRMATION` (via un vrai `PREPARE_PDF`
frais) : même résultat, annulation à tort confirmée.

**Reproduction B1/B2/B3 (`DOCUMENT_PREVIEW`), prouvée dans la
composition de production, pile de génération réelle, avant correctif :**

* B1 : document réel mené jusqu'à `VERIFIED` → session obsolète `P_old`
  ouverte → un vrai `PREPARE_PDF` frais fait légitimement basculer le
  document vers `AWAITING_GENERATION_CONFIRMATION` → `P_old`/`CANCEL`
  soumis pour la première fois → **avant correctif**, accepté à tort.
* B2 : même scénario, poussé jusqu'à `RECHARGE_REQUIRED` via un vrai
  `CONFIRM_GENERATION` frais à solde insuffisant → **avant correctif**,
  `P_old`/`CANCEL` accepté à tort.
* B3 (scénario financier HIGH/P0) : même scénario, avec une barrière
  déterministe insérée dans le renderer réel (jamais un `sleep`) — le
  document atteint réellement `GENERATION_IN_PROGRESS`, une réservation
  de crédits `RESERVED` confirmée, avant que `P_old`/`CANCEL` ne soit
  soumis pour la première fois → **avant correctif**, accepté à tort,
  document annulé mid-génération sans libérer la réservation ni nettoyer
  la tentative de génération.

Même défaut confirmé, avec le même schéma de reproduction, sur la
pipeline `DECHARGE` (`kadiV1DischargePipeline.js`) pour les deux Flows.

### Modèle d'autorité d'état retenu

Réutilisation stricte, sans aucune modification, du primitif
`expectedState` déjà introduit et prouvé en T4 (fiche AA.1) :
`kadiV1RuntimeAdapters.js`'s `cancel()`,
`kadiV1SharedDocumentPipeline.js`'s `persistStateTransition`,
`kadiV1DischargePipeline.js`'s `persistTransition` — déjà génériques,
déjà atomiques (contrôle `row.status === fromState` de
`storage.persistTransition` comme filet final contre toute course
réelle), n'ont nécessité **aucune** modification. Le seul changement de
production est dans `kadiV1FlowCommandRuntime.js` :

* `DOCUMENT_REVIEW`/`CANCEL` : la session de confiance doit avoir capturé
  exactement `document_state === "READY_FOR_REVIEW"` (échec fermé sinon,
  `KADI_V1_FLOW_COMMAND_DOCUMENT_CANCEL_STATE_INVALID`), puis
  `expectedState` transmis est cette valeur unique.
* `DOCUMENT_PREVIEW`/`CANCEL` : la session de confiance doit avoir
  capturé `document_state` égal à `"VERIFIED"` **ou** `"PREVIEW_READY"`
  (échec fermé sinon), puis `expectedState` transmis est la valeur
  **exacte déjà validée de la session** — jamais une constante unique
  arbitraire, contrairement à `GENERATION_CONFIRMATION` qui n'a qu'un
  seul état légitime. Une session capturée à `VERIFIED` ne peut donc
  jamais réussir si le document est maintenant `PREVIEW_READY`, et
  inversement — les deux valeurs restent strictement distinctes au
  niveau de la vérification finale.

### Preuve

* `tests/kadiV1DocumentCancelStateAuthorityE2E.test.js` (nouveau, 22
  scénarios, pile de génération réelle identique à celle de la fiche
  AA.1) : les huit reproductions ci-dessus **prouvées concrètement avant
  correctif** (le correctif de production a été temporairement retiré
  via `git stash` puis restauré, comme pour AA.1 et les rounds R1/R2/R3
  de RECHARGE-CONTRACT-001) ; annulation courante non obsolète toujours
  fonctionnelle pour les deux Flows ; après rejet de l'annulation
  obsolète pendant la génération en vol (B3), la libération de la
  barrière permet à la génération fraîche de se terminer normalement
  avec exactement une réservation, une capture, un fichier final et une
  livraison ; rejeu exact toujours idempotent pour les deux Flows (aucun
  court-circuit spécifique RECHARGE copié) ; isolation propriétaire et
  isolation multi-documents pour les deux Flows ; même reproduction et
  correctif confirmés sur `DECHARGE` ; non-régression `CONFIRM_GENERATION`
  et `RECHARGE`/`CANCEL` (T3/T4) ; actions non-`CANCEL`
  (`VERIFY`/`EDIT_CLIENT`/`EDIT_CONTENT`/`EDIT_OPTIONS`,
  `PREPARE_PDF`/`SAVE_FOR_LATER`) toujours fonctionnelles et ne
  transmettant jamais `expectedState` ; champ inconnu toujours rejeté.
* `tests/kadiV1FlowCommandRuntime.test.js` : couverture unitaire dédiée —
  `expectedState` transmis exactement (`READY_FOR_REVIEW` pour
  `DOCUMENT_REVIEW` ; `VERIFIED` ou `PREVIEW_READY`, jamais une constante
  unique, pour `DOCUMENT_PREVIEW`) ; échec fermé pour tout autre état
  capturé, `cancelDocument` jamais appelé ; actions non-`CANCEL` ne
  portent jamais `expectedState` dans leur payload.
* Focused : 405/405 (fichiers concernés, dont T1/T2/T3/T4 déjà fusionnés).
  Suite complète : 1457/1457. `git diff --check` : propre.

### Sécurité re-vérifiée

`expectedState` reste toujours dérivé de la session serveur de
confiance, jamais du payload client. Aucune fuite vers `RECHARGE`/
`CANCEL` ou `GENERATION_CONFIRMATION`/`CANCEL` (branches indépendantes,
vérifiées en premier). Comportement générique non affaibli pour aucune
autre action de ces deux Flows. Contrats T3 (`RECHARGE`, R0–R3) et T4
(`GENERATION_CONFIRMATION`, R0–R1) confirmés inchangés par la suite
complète. Aucune migration ni mutation Supabase, Meta, Render ou
WhatsApp réelle ; aucune génération, capture ou livraison réelle
(fournisseurs synthétiques en mémoire uniquement).

### Autres constats d'autorité d'état (classification backlog)

Inspection des autres actions liées à un document et portant un
`document_state` de confiance : aucune autre action ne mute un état de
document de façon **terminale** et **sans validation de contenu propre**
comme le fait `CANCEL` — `VERIFY`/`beginEdit`/`saveForLater` opèrent
toutes sur le document dans son état courant réel (jamais un état
« attendu » implicite issu d'un écran différent), et leurs propres
règles métier (ex. `beginEdit` ne fait rien si le statut n'est pas
`VERIFIED`) fournissent déjà une protection fonctionnelle équivalente.
Aucun autre défaut de cette classe identifié dans le périmètre de cette
mission. Ce périmètre reste volontairement limité à `CANCEL` — toute
extension nécessiterait sa propre preuve dédiée.

### Suivi requis (hors périmètre de cette correction)

* T5 — prochaine mission de correction dédiée, non commencée.
* Validation téléphone réelle requise après un déploiement éventuel.
* `FLOW-PARITY-GATE` global — toujours un suivi de backlog distinct.

### Prévention

Cette mission établit la règle réutilisable pour tout futur audit
FLOW-PARITY/STATE-AUTHORITY : pour toute action de mutation dont
l'autorité dépend implicitement de l'écran Flow d'où elle provient,
tracer les états authentiquement légitimes depuis le **routage réel de
production** (jamais la seule connectivité de la machine d'état, qui
sur-approxime toujours ce qui est réellement atteignable), puis lier
cette autorité au même contrat de mutation atomique que la mutation
elle-même — jamais une vérification séparée à un niveau supérieur. Un
Flow qui n'a qu'un état légitime peut recevoir une constante serveur
fixe ; un Flow qui en a plusieurs doit transmettre la valeur exacte déjà
validée de la session, jamais une valeur générique qui rendrait les
états légitimes interchangeables entre eux.
