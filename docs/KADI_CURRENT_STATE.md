# État courant de Kadi V1

**Mise à jour :** 2026-08-05
**Base vérifiée :** `main` au commit `f95be84b98d3d9ad6308a6aebbc3e11590717ae2`
(merge « correct Kadi V1 receipt and discharge journeys »).

Ce document reflète l'état réel observé dans le dépôt et ses tests à la date
ci-dessus. En cas de doute, le code et les tests font foi ; ce fichier doit
être corrigé s'il diverge de l'inspection réelle.

Statuts utilisés : `VALIDATED_CANARY`, `IMPLEMENTED_NOT_DEPLOYED`,
`PLANNED`, `BLOCKED`, `DEFERRED`.

## Rollout

* Mode de rollout : **CANARY** exclusivement. État du service Render
  `kadi-backend` : **READY**.
* Aucun passage en `FULL` n'est autorisé sans autorisation explicite du
  fondateur (voir [`../AGENTS.md`](../AGENTS.md)).
* Le ou les numéros WhatsApp autorisés en CANARY sont définis uniquement par
  la variable d'environnement `KADI_V1_CANARY_WA_IDS` (voir
  `kadiV1CanaryIngress.js`). Ce document ne les reproduit jamais en clair.

## État par lot

### P8.A1 — ARTICLE_FORM (saisie d'article indépendante)

* **Statut : `VALIDATED_CANARY`.**
* Le Flow `ARTICLE_FORM` a été séparé de `DOCUMENT_CONTENT` en deux Flows
  Meta indépendants mono-écran, après le rejet Meta #131009 (voir
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) fiche B et
  [`decisions/ADR-002-independent-meta-flows.md`](decisions/ADR-002-independent-meta-flows.md)).
* Migration Supabase appliquée :
  `supabase/migrations/20260805020000_add_kadi_v1_article_form_flow_key.sql`
  (ajoute `ARTICLE_FORM` à la contrainte
  `kadi_v1_conversation_sessions_expected_flow_key_check`).
* Registre `FLOW_KEYS` (`kadiV1FlowRouter.js`) et variable
  `KADI_V1_FLOW_ARTICLE_FORM_ID` en place.

### P8.A2 — INVOICE_TYPE (facture définitive / proforma)

* **Statut : `IMPLEMENTED_NOT_DEPLOYED` → publication Meta et configuration
  Render désormais confirmées (voir ci-dessous) ; validation en conditions
  réelles CANARY (nouveau parcours WhatsApp, fiche F de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md)) non encore
  confirmée, donc pas encore `VALIDATED_CANARY`.**
* Le code est fusionné dans `main` (commit de merge `1fb1329`), avec 862
  tests locaux au vert au moment du merge.
* Étape ajoutée : entre `DOCUMENT_TYPE` (choix FACTURE) et
  `DOCUMENT_CLIENT`, un nouvel écran `INVOICE_TYPE` impose le choix
  `invoice_kind = FINAL | PROFORMA`. `document_type` reste toujours
  `FACTURE`.
* Migration Supabase **écrite mais non confirmée appliquée en distant** :
  `supabase/migrations/20260805030000_add_kadi_v1_invoice_type_flow_key.sql`
  (ajoute `INVOICE_TYPE` à la même contrainte, 17 valeurs au total).
* Flow Meta : **`KADI_INVOICE_TYPE_V1`** — **`PUBLISHED`** (Flow ID
  `2500135057170722`, zéro erreur de validation, confirmé sur le Graph API
  Meta).
* Variable Render `KADI_V1_FLOW_INVOICE_TYPE_ID` : confirmée configurée.
* La migration Supabase distante reste le seul des trois prérequis non
  confirmé pour cet écran.

### Onboarding — blocage de navigation

* **Statut : `VALIDATED_CANARY`** (résolu).
* Un blocage de navigation empêchait l'affichage des questions de profil
  après « Commencer » dans le Flow de bienvenue, avec un message d'échec à
  04:00 suivi d'un message erroné « Votre profil est enregistré » à 04:28
  sans qu'aucun profil n'ait réellement été demandé.
* Corrigé par le lot « fix Kadi V1 onboarding navigation » (ancêtre de
  `404a3fa`). La garde empêchant qu'une réponse vide marque le profil comme
  terminé fait partie du correctif.

### RECU — parcours dédié RECEIPT_DETAILS

* **Statut : `IMPLEMENTED_NOT_DEPLOYED` → publication Meta, migration
  Supabase et configuration Render désormais confirmées (voir ci-dessous) ;
  validation en conditions réelles CANARY non encore confirmée, donc pas
  encore `VALIDATED_CANARY`.**
* Corrige un bug confirmé : le reçu passait auparavant par les écrans
  génériques `DOCUMENT_CLIENT` puis `ARTICLE_FORM`/`DOCUMENT_CONTENT`, qui
  collectaient des champs inadaptés (nom/téléphone/e-mail au lieu de
  payeur/bénéficiaire/montant/motif) et autorisaient des articles, alors que
  RECU les interdit explicitement. L'utilisateur recevait ensuite une erreur
  générique.
* Flow Meta indépendant mono-écran : **`KADI_RECEIPT_DETAILS_V1`** —
  **`PUBLISHED`** (Flow ID `1325710445984629`, zéro erreur de validation).
* Variable Render `KADI_V1_FLOW_RECEIPT_DETAILS_ID` : confirmée configurée.
* Champ nouveau `receipt_format` (`A4` ou `TICKET_80`), obligatoire avant
  `READY_FOR_REVIEW`, persisté dans `document.options.receipt_format`.
* Migration Supabase confirmée appliquée en distant :
  `supabase/migrations/20260805040000_add_kadi_v1_receipt_details_flow_key.sql`.
* Le format persistant est propagé jusqu'au rendu PDF réel
  (`A4` → moteur A4, `TICKET_80` → moteur compact), sans repli silencieux
  vers A4 en cas de valeur absente ou invalide.
* Le reçu compact (`TICKET_80`) peut désormais afficher le logo de
  l'émetteur lorsqu'un logo privé valide existe ; un logo manquant,
  illisible ou corrompu ne bloque jamais la génération du PDF.

### DECHARGE — écran initial corrigé

* **Statut : `IMPLEMENTED_NOT_DEPLOYED` → publication Meta et configuration
  Render désormais confirmées (voir ci-dessous) ; validation en conditions
  réelles CANARY non encore confirmée, donc pas encore `VALIDATED_CANARY`.**
* Corrige un bug confirmé : l'écran initial mélangeait la saisie des
  informations et un sélecteur d'action « Prochaine étape » (Enregistrer /
  C'est bon / Modifier / Annuler) alors que rien n'était encore renseigné,
  et les champs envoyés par le Flow (`purpose`, `notes`,
  `transferred_content`) ne correspondaient pas aux noms réellement lus par
  l'adaptateur (`reason`, `observations`, `description`/`amount`), ce qui
  produisait un message générique de repli.
* Le sélecteur d'action a été retiré du formulaire initial ; l'écran ne
  collecte plus que les informations métier (`giver`, `recipient`,
  `transferred_content_type`, `amount` ou `description`/`quantity` selon le
  type, `reason`, `observations`).
* Une fois complète, la décharge suit désormais le même chemin que les
  autres documents : `DISCHARGE_DETAILS` → `DOCUMENT_REVIEW` →
  `DOCUMENT_PREVIEW` → `GENERATION_CONFIRMATION`.
* Le Flow publié pour ce correctif est **`KADI_DISCHARGE_DETAILS_V2`**
  (Flow ID `1725047255448294`, **`PUBLISHED`**, zéro erreur de validation,
  déployé en CANARY) — un nouveau Flow, pas une mise à jour de
  `KADI_V1_DISCHARGE_DETAILS` (id historique
  `1995626954420510`), car Meta interdit la modification d'un Flow déjà
  publié. L'ancien Flow reste publié et intact, conservé pour rollback ; il
  ne doit pas être supprimé ou déprécié. Variable Render
  `KADI_V1_FLOW_DISCHARGE_DETAILS_ID` : confirmée configurée et pointant
  vers `1725047255448294`.

### Décharges et parcours document restants (hors ce correctif)

* **Statut : `PLANNED`** — les correctifs additionnels de décharge non
  couverts par la mission ci-dessus restent à traiter séparément.

### PDF final state, titre proforma, libellé reçu, taxe en pourcentage

* **Statut : `MERGED_DEPLOYED_HEALTHY_CANARY_PENDING`**
  — code implémenté, committé (`59f365e31737cf4f1b475ab0172322cdccac6932`),
  revu de façon adversariale, **[PR #12](https://github.com/GueswendeOue/kadi-backend/pull/12)
  fusionnée dans `main`** (commit de fusion
  `35358e5f301e821ac0ad8f6953c118146521878c`, 2026-08-06T12:48:49Z).
  Migration Supabase `20260806010000_add_kadi_v1_finalization_identity`
  appliquée et vérifiée en distant sur le projet `cmhargmwkyskbobmkrcj` le
  2026-08-06T12:11:31Z (une seule fois, historique distant par ailleurs
  cohérent, fonctions et permissions vérifiées en lecture seule, aucune
  ligne de donnée applicative modifiée). **Déployé sur Render par
  déclenchement manuel explicite** (`kadi-backend`,
  `srv-d5a93m1r0fns73879big`, déploiement `dep-d9q97g9t0dsc73cgisog`,
  déclenché 2026-08-06T14:01:37.902341Z, `live` à
  2026-08-06T14:02:47.395578Z, commit vérifié
  `35358e5f301e821ac0ad8f6953c118146521878c`) — build réussi, boot propre,
  `KADI_V1_WEBHOOK_READY` confirme `ready:true, active:true,
  state:"READY", rollout_mode:"CANARY", blocker:null`. **Correctif
  important (2026-08-06) : contrairement à ce que ce document affirmait
  auparavant, fusionner une PR dans `main` ne déploie pas automatiquement
  `kadi-backend` sur Render** — l'API Render confirme `autoDeploy:"no"` pour
  ce service ; un déploiement manuel explicite est systématiquement requis
  et doit être vérifié par les métadonnées Render (`live`, commit exact),
  jamais déduit du seul statut de fusion GitHub. Voir fiche P de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le récit
  complet, y compris la fenêtre de compatibilité migration-avant-déploiement
  que cette hypothèse erronée a laissée ouverte. Aucun Flow
  `DOCUMENT_OPTIONS` republié, aucune session WhatsApp CANARY fraîche
  encore exécutée sur ce déploiement — **ne pas présenter la fonctionnalité
  comme validée en CANARY tant que la matrice de l'étape 9 de
  [`KADI_RELEASE_CHECKLIST.md`](KADI_RELEASE_CHECKLIST.md) n'a pas été
  exécutée.**
* Corrige : PDF final affichant « BROUILLON »/date vide/pas de numéro
  (FACTURE, DEVIS, RECU, DECHARGE — même chemin de finalisation partagé) ;
  FACTURE proforma affichée comme « FACTURE » simple ; reçu affichant
  « CLIENT » au lieu de « Payeur » ; saisie de taxe en points de base bruts
  au lieu d'un pourcentage.
* **Statut de la navigation options/taxe : `UNRESOLVED_PRODUCTION_DIAGNOSIS_REQUIRED`,
  sans lien avec la reprise de génération ci-dessous.** Le blocage
  générique rapporté après « Terminer les articles » n'a révélé aucun bug
  dans le code de routage (entièrement tracé et déjà testé) — seule une
  lacune cosmétique réelle a été trouvée et corrigée (résumé d'options
  manquant). La cause du blocage rapporté reste à confirmer par les logs
  Render en conditions réelles ; aucune correction de code n'est proposée
  pour ce point tant que la cause n'est pas confirmée.
* Migration Supabase appliquée et vérifiée en distant :
  `supabase/migrations/20260806010000_add_kadi_v1_finalization_identity.sql`
  (projet `cmhargmwkyskbobmkrcj`, appliquée le 2026-08-06).
* Le Flow Meta `DOCUMENT_OPTIONS` publié n'a **pas** besoin d'être republié
  avant le déploiement backend : le backend accepte désormais son ancien
  champ (`tax_rate_basis_points`) en fenêtre de compatibilité — voir fiche
  P de [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md). Une
  nouvelle publication (champ `tax_rate_percent`) reste nécessaire pour que
  la saisie en pourcentage soit visible par un utilisateur réel, mais
  n'est plus un préalable bloquant au déploiement du backend.
* **Ordre de déploiement — voir
  [`KADI_RELEASE_CHECKLIST.md`](KADI_RELEASE_CHECKLIST.md) pour la
  procédure complète et le récit exact.** La migration a été appliquée en
  distant le 2026-08-06T12:11:31Z, avant la fusion (2026-08-06T12:48:49Z),
  elle-même avant le déploiement manuel effectif (`live` à
  2026-08-06T14:02:47.395578Z). **Une fenêtre de compatibilité réelle
  d'environ 1h51 s'est ouverte entre l'application de la migration et le
  déploiement effectif**, parce que la fusion de la PR ne déclenche pas de
  déploiement sur ce service (`autoDeploy` désactivé, découvert après coup
  — voir ci-dessus) : pendant cette fenêtre, l'ancien backend encore servi
  par Render recalculait un `issued_at` différent de celui déjà assigné par
  la RPC migrée à `START_GENERATION`, et se faisait rejeter par
  `KADI_V1_SERVER_FIELD_FORBIDDEN` à `MARK_GENERATED` pour tout document
  atteignant ce point. Cette fenêtre est refermée depuis
  2026-08-06T14:02:47.395578Z (déploiement manuel confirmé `live` sur le
  commit fusionné). **Leçon retenue : la compatibilité entre la base de
  données et le backend doit toujours être vérifiée dans les deux sens**
  (nouveau backend/ancienne base, **et** ancien backend/nouvelle base) —
  seule la première direction avait été anticipée avant cet incident.
* Un document dont le rendu échoue après l'assignation d'identité
  (`START_GENERATION` déjà passé) conserve un `issued_at`/`document_number`
  « réservés » sans jamais avoir produit d'artefact livré — ce n'est ni un
  débit, ni une entrée d'historique final ; une reprise réutilise cette
  même identité, jamais une nouvelle.
* Reprise après un échec au stade du rendu/stockage privé (avant capture
  des crédits) désormais implémentée **et accessible par l'utilisateur réel
  via l'action de confirmation existante** :
  `kadiV1GenerationLifecycleService.js`'s `retryFailedGeneration`, atteint
  par le nouveau `confirmOrRetryGeneration` que
  `createKadiV1GenerationRuntimeAdapter` appelle désormais à la place de
  `confirmGeneration` — c'est-à-dire la **même** action Flow
  `CONFIRM_GENERATION`, le **même** écran `GENERATION_CONFIRMATION`, sans
  aucune nouvelle action ni nouveau Flow Meta. Même identité réutilisée, un
  seul débit, une seule livraison, rejeu et tentatives concurrentes sans
  effet. Message utilisateur en cas d'échec récupérable à ce stade : « Le
  document n'a pas pu être généré. Vous pouvez réessayer sans perdre de
  crédit. » (aucun terme technique exposé). Voir fiche Q de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le
  détail complet — correctif écrit, testé localement (y compris à travers
  la composition de production réelle, `kadiV1ProductionBootstrap.js`),
  committé (`59f365e31737cf4f1b475ab0172322cdccac6932`), fusionné via la
  [PR #12](https://github.com/GueswendeOue/kadi-backend/pull/12) et
  **déployé sur Render** (voir statut en tête de section). Aucune
  correction de production ne peut encore être revendiquée comme validée
  avant l'exécution d'une matrice CANARY fraîche (étape 9 de
  [`KADI_RELEASE_CHECKLIST.md`](KADI_RELEASE_CHECKLIST.md)).

### Retenue de livraison WhatsApp après une génération réussie, et noms de fichiers finaux uniques

* **Statut : `IMPLEMENTED_REVIEWED_NOT_DEPLOYED`** — branche
  `fix/kadi-v1-delivery-retry-and-final-filenames-r0`, code implémenté et
  testé localement, **non encore fusionnée ni déployée**. Ne pas présenter
  comme une correction active en production tant qu'un déploiement et un
  vrai passage de reprise de livraison n'ont pas été validés en conditions
  réelles.
* **Contexte confirmé — première génération CANARY par le fondateur
  (2026-08-06) :** la navigation `DOCUMENT_OPTIONS` fonctionne intégralement
  (`NAVIGATION_CONFIRMED_WORKING`, confirmé par les logs de production —
  voir fiche P de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md)) ; le document a
  atteint `GENERATED` avec une identité complète et **un seul crédit
  capturé** ; **l'envoi WhatsApp du PDF a ensuite échoué**
  (`DELIVERY_DESTINATION_MISMATCH`, très probablement une erreur transitoire
  de la vérification de destination, pas une incohérence de données
  persistante — revérification indépendante concluante). Une fonction de
  reprise de livraison (`retryDelivery`) existait déjà dans
  `kadiV1GenerationLifecycleService.js`, mais **n'était atteignable par
  aucune action réelle** — ni bouton, ni Flow, ni commande — laissant le
  document payé et le PDF prêt sans aucun moyen pour l'utilisateur de le
  recevoir.
* **Correctif :** `retryDelivery` réécrit avec une éligibilité entièrement
  vérifiée côté serveur (propriétaire, état `RECOVERABLE_FAILURE` avec
  `resume_state=GENERATED`, identité complète, réservation capturée, tentative
  `PROMOTED`, fichier final correspondant à la version active), exposé par un
  **bouton WhatsApp interactif simple** (« Réenvoyer le PDF », aucun nouveau
  Flow Meta) déclenché depuis le même message d'échec de livraison. Protégé
  au-delà de la file en mémoire par une réclamation atomique en base
  (`PENDING`/`RECOVERABLE_FAILURE` → `IN_PROGRESS` avant tout appel du
  fournisseur) empêchant un double envoi en cas de requêtes concurrentes.
* **Distinction ajoutée dans le fournisseur de livraison :**
  `DELIVERY_DESTINATION_LOOKUP_FAILED` (la vérification elle-même a échoué
  ou n'a rien trouvé) est désormais séparé de `DELIVERY_DESTINATION_MISMATCH`
  (la vérification a réussi et les valeurs diffèrent réellement) — l'ambiguïté
  exacte qui a compliqué le diagnostic de l'incident CANARY ci-dessus.
* **Noms de fichiers finaux uniques :** les noms génériques
  (`facture.pdf`, `recu.pdf`, écrasés à chaque nouveau document du même
  propriétaire) sont remplacés, pour tout document généré après ce
  correctif, par un nom déterministe basé sur la référence officielle
  (`facture_<document_number>.pdf`, `facture-proforma_<document_number>.pdf`,
  `devis_<document_number>.pdf`, `recu_<document_number>.pdf`,
  `decharge_<document_number>.pdf`), calculé de façon identique et
  recalculée (jamais stockée redondante) partout où il est utilisé — envoi
  WhatsApp, reprise de livraison, projection historique/téléchargement.
  **Les documents déjà livrés avant ce correctif ne sont pas renommés.**
* **Preuve de validation :** `tests/kadiV1FinalFilename.test.js`,
  `tests/kadiV1DeliveryProvider.test.js`,
  `tests/kadiV1DeliveryRetryEligibility.test.js` (éligibilité complète,
  concurrence, chemin de production réel via le vrai runtime webhook),
  `tests/kadiV1DeliveryRetryRuntime.test.js`, plus les suites existantes
  mises à jour (`kadiV1GenerationLifecycle`, `kadiV1ReleaseRecoveryE2E`,
  `kadiV1WebhookRuntime`, `kadiV1ProductionPresenter`,
  `kadiV1ProductionComposition`, `kadiV1ProductionBootstrap`,
  `kadiV1RuntimeAdapters`, `kadiV1HistorySearch`). Suite complète : 1219/1219.
* **Non inclus dans cette correction, planifié séparément :**
  `GUIDED_ENTRY_BUTTON_NOT_IMPLEMENTED` — envoyer « Créer une facture »
  ouvre une demande de texte libre, sans bouton de parcours guidé ; ceci
  appartient à une future mission hybride guidé/conversationnel proposant
  les deux entrées.
* **Suite (2026-08-06), même branche, second commit, statut
  `IMPLEMENTED_REVIEWED_NOT_DEPLOYED` inchangé :** la revue adversariale
  indépendante de ce correctif a confirmé que la reprise n'était toujours
  pas atteignable pour un document déjà stocké (seule l'offre au moment
  même du premier échec l'était), qu'une capture pouvait rester bloquée
  `IN_PROGRESS` indéfiniment après un plantage, et qu'une expiration après
  un envoi WhatsApp potentiellement réussi pouvait mener à un renvoi
  externe incontrôlé. Voir la sous-section « Suite de revue finale » de la
  fiche R dans
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le détail
  complet, y compris les deux migrations forward-only écrites pour ces
  correctifs (élargissement de la contrainte `status` de
  `kadi_v1_delivery_attempts` pour `IN_PROGRESS`, exposition de
  `last_error_code` dans le paquet historique).
* **Migrations appliquées (2026-08-07), statut `IMPLEMENTED_REVIEWED_NOT_DEPLOYED`
  toujours inchangé — la migration de la base n'est pas un déploiement :**
  les deux migrations ci-dessus ont été **appliquées et vérifiées** à
  distance sur le projet Supabase `cmhargmwkyskbobmkrcj`
  (2026-08-07T00:04:03Z–2026-08-07T00:04:40Z), sous autorisation explicite
  et séparée du fondateur. Chacune apparaît exactement une fois dans
  l'historique distant ; aucune ligne d'aucune table applicative n'a
  changé (vérifié en lecture seule avant/après). L'ancien backend
  actuellement déployé (`ac01557b...`) reste pleinement compatible avec la
  base migrée — il n'écrit jamais `IN_PROGRESS` et ne lit jamais
  `last_error_code`, donc les deux changements sont additifs et sans effet
  pour lui. Le risque inverse (nouveau backend déployé avant migration de
  la base) est désormais écarté puisque la base est migrée en premier,
  dans le bon ordre. Une couverture de test bout en bout traversant la
  vraie `kadiV1ProductionComposition.js` (historique → ouverture de
  document → présentateur → bouton webhook réel → reprise de livraison,
  pour un échec confirmé et pour une issue inconnue) a également été
  ajoutée, fermant le dernier écart de test identifié par la revue
  précédente.
* **Mise à jour (2026-08-07) : PR #14 fusionnée et déployée.** Commit de
  fusion `aacf76211552800054983c726a1211f22ed29aeb`, déployé manuellement
  sur Render (`dep-d9qilviju40c73batvn0`), lecture de préparation confirmée
  (`KADI_V1_WEBHOOK_READY` : `ready:true`, `state:"READY"`,
  `rollout_mode:"CANARY"`, `deliveryRetryRuntime:true`). **Une vraie
  tentative de reprise par le fondateur a ensuite confirmé trois défauts de
  production distincts** — voir fiche S de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le détail
  complet : (1) la recherche de destination échouait avant tout appel Meta,
  y compris sur un document flambant neuf ; (2) « Historique » en texte
  brut et les résultats de recherche via Flow ne s'affichaient pas ; (3) la
  navigation d'édition depuis l'écran de revue rouvrait systématiquement le
  même écran au lieu du Flow d'édition attendu. Correctifs écrits sur la
  branche `fix/kadi-v1-destination-lookup-and-history-r0`, **non fusionnée,
  non déployée**. **Le document CANARY du fondateur
  (`FA-20260806190633-A0EAC605`) reste non récupéré**, ainsi que le
  document créé pendant l'incident (`FA-20260807010715-1961CBCC`) — aucun
  des deux n'a été retenté pendant le diagnostic ni la correction.
* **Mise à jour (2026-08-07) : audit exploratoire complet en lecture seule,
  toujours sur la même branche, PR #15 toujours `OPEN`/`DRAFT`/non fusionnée/
  non déployée.** Un audit produit/UX exploratoire complet
  (`KADI_V1_FULL_EXPLORATORY_PRODUCT_AUDIT_COMPLETE`) a confirmé, par lecture
  directe du code, que le défaut de navigation d'édition ci-dessus (point 3)
  est **entièrement corrigé** — pas seulement couvert par des tests
  incomplets — puis a découvert et corrigé trois défauts supplémentaires,
  distincts, tous sur la même branche : **REVIEW-001** (l'écran de revue
  n'affichait jamais le vrai contenu du document, seulement l'exemple
  statique du contrat Flow), **INV-001** (corriger le client depuis la revue
  forçait l'ajout d'un article obligatoire au lieu de revenir à la revue) et
  **INV-002** (corriger les articles depuis la revue ne pouvait jamais se
  terminer — l'écran n'avait ni données réelles ni action de fin). Voir
  fiche T de [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour
  le détail complet. **Statut de ce lot de correctifs :
  `IMPLEMENTED_NOT_DEPLOYED`.**
* **Mise à jour (2026-08-07) : CLIENT-001 corrigé, même branche, PR #15
  toujours `OPEN`/`DRAFT`/non fusionnée/non déployée.** `SAVE_CLIENT`
  échouait systématiquement (`DOCUMENT_CLIENT_FIELD_UNKNOWN`) dès qu'un
  champ `tax_id` était soumis, ce que font les deux Flows client réels
  (`kadi_document_client_v1.json` et `kadi_edit_client_v1.json`) à chaque
  soumission — `CLIENT_FIELDS` (`kadiV1SharedDocumentPolicies.js`) n'acceptait
  que `ifu`/`rccm`, jamais `tax_id`. **Contrat canonique déterminé avant
  correction :** `tax_id` (libellé Flow « Identifiant fiscal ») est un alias
  du Flow pour le champ domaine canonique `ifu` — confirmé par recherche
  exhaustive (`ifu` est le seul nom reconnu par `CLIENT_FIELDS` **et** par
  le contrat du cerveau conversationnel `kadiV1BrainContracts.js` ;
  `tax_id` n'existe nulle part ailleurs comme concept distinct). **Correctif
  :** normalisation `tax_id` → `ifu` une seule fois, à la frontière
  Flow→domaine (`kadiV1FlowReplyRuntime.js`), avec échec explicite en cas
  de valeurs contradictoires non vides (jamais un choix silencieux) ;
  aucune mutation de Flow Meta requise. **Statut : `IMPLEMENTED_NOT_DEPLOYED`.**
  Voir fiche U de [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md)
  pour le détail complet et la preuve (tests de parité Flow/backend inclus).
* **Mise à jour (2026-08-07) : revue finale de fusion de la PR #15, deux
  défauts confirmés et corrigés avant fusion, même branche, PR #15 toujours
  `OPEN`/`DRAFT`/non fusionnée/non déployée.** Un balayage borné de
  cohérence Flow/backend (même méthode que CLIENT-001) a révélé
  **EDIT-CONTENT-001** : le formulaire combiné `kadi_edit_content_v1.json`
  soumet toujours les mêmes six champs quelle que soit l'action choisie,
  mais trois des quatre actions réelles (`ADD_CONTENT`, `REMOVE_CONTENT`,
  `FINISH_CONTENT`) rejetaient cette vraie forme — rendu actif pour la
  première fois par le propre correctif INV-002 de cette PR, qui a rendu
  `EDIT_CONTENT` réellement atteignable. Une revue croisée de
  l'observabilité a révélé un second défaut, distinct : l'observateur de
  cycle de vie (fiche S/T) attendait deux arguments séparés alors que le
  vrai `emit()` en passe un seul fusionné — la liste blanche de filtrage
  ne s'exécutait donc jamais en conditions réelles (aucune fuite
  effective : chaque site d'appel réel ne passait déjà que des champs
  sûrs, mais la garantie elle-même était inopérante). Les deux corrigés
  sur la même branche. Voir fiche V de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md).
* **Mise à jour (2026-08-07) : PR #15 fusionnée et déployée
  (`0335d3758f3dc1d4841fd5137c8273d03ee68843`), puis une vraie tentative de
  reprise par le propriétaire a de nouveau échoué avec
  `DELIVERY_DESTINATION_LOOKUP_FAILED` — cause racine sous-jacente
  identifiée par reproduction directe (pas seulement lecture de code) :
  `PostgreSQL 42703`, `lookupDestinationOwner()` sélectionnait une colonne
  `options` qui n'existe pas physiquement sur `kadi_v1_documents`. Corrigé
  sur une nouvelle branche dédiée
  `fix/kadi-v1-delivery-destination-schema-r0`, PR distincte, brouillon, non
  fusionnée, non déployée. **Statut : `IMPLEMENTED_NOT_DEPLOYED`.**
  Correctif : requête de vérification propriétaire/destination réduite aux
  seules colonnes physiques réelles ; métadonnées de nom de fichier
  (`document_type`/`options.invoice_kind`/`document_number`) désormais
  résolues via le `documentRepository` déjà authentique, après
  vérification réussie ; `42703` classé comme erreur permanente (échec
  immédiat, plus de budget de retries gaspillé). Voir fiche W de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le détail
  complet et la preuve (composition de production utilisant pour la
  première fois le vrai fournisseur de livraison, pas une interface
  simulée).
* **BILL-001, rappel — toujours `PLAUSIBLE`, `NOT_REPRODUCED`, hors
  périmètre de ce lot :** le solde affiché (« Mon solde ») ne semble pas
  déduire les crédits retenus par une réservation restée `RESERVED` sans
  job de réconciliation équivalent à celui de la livraison — reconstruction
  plausible à partir du code, jamais reproduit sur un cas réel. Nécessite un
  audit dédié, en lecture seule, avant toute décision de correction ; aucun
  code de portefeuille, de prix ou de crédit n'a été touché par ce lot.
* **Mise à jour (2026-08-07) : audit final « FINAL ROADMAP GAP AUDIT R0 »
  puis correction T1/OPTIONS-001, nouvelle branche dédiée
  `fix/kadi-v1-options-contract-r0`, PR distincte, brouillon, non fusionnée,
  non déployée.** L'audit final (backlog T1–T16) a confirmé Kadi V1 **non
  prêt** pour un audit de mise en release candidate, trois parcours cœur
  étant totalement cassés par le même défaut de classe déjà vu deux fois
  (`CLIENT-001`, `EDIT-CONTENT-001`) : `OPTIONS-001`/T1,
  `HISTORY-CONTRACT-001`/T2, `RECHARGE-CONTRACT-001`/T3. **T1/OPTIONS-001
  corrigé, T2/T3 volontairement laissés hors périmètre de cette mission** —
  le vrai Flow combiné `kadi_document_options_v1.json` (et son pendant
  d'édition) soumet toujours ses sept champs ensemble
  (`tax_rate_percent`/`tax_rate_basis_points`, `discount_amount`, `notes`,
  `payment_terms`, `validity_days`, `payment_method`, `reference`), mais
  `normalizeOptions` (`kadiV1SharedDocumentPolicies.js`) ne reconnaissait
  ni la forme plate de `validity_days` ni `payment_method`/`reference` pour
  FACTURE/DEVIS — **aucune FACTURE ni aucun DEVIS ne pouvait jamais quitter
  l'écran DOCUMENT_OPTIONS via le vrai Flow Meta.** Un second défaut de la
  même fonction (`discount_amount` blanc rejeté, masqué jusque-là par le
  premier) corrigé dans le même correctif. **Contrat déterminé avant
  correction :** `validity_days` persiste à sa place canonique déjà établie
  `document.options.validity_days` (même convention qu'`invoice_kind`),
  désormais acceptée sous forme plate avec détection de conflit si la forme
  imbriquée est aussi soumise ; `payment_method`/`reference` n'ont aucune
  signification FACTURE/DEVIS confirmée nulle part dans le domaine (leur
  seule signification réelle est celle du reçu) et sont donc acceptés puis
  explicitement abandonnés pour ces deux types, jamais persistés. `DECHARGE`
  confirmé hors d'atteinte de ce défaut (parcours initial `SAVE_DETAILS`,
  politique d'options dédiée et séparée) — non-régression testée. **Statut :
  `IMPLEMENTED_NOT_DEPLOYED`.** Voir fiche X de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le détail
  complet, la preuve et le suivi requis (`FLOW-PARITY-GATE` global, T2/T3
  encore à corriger).
* **Mise à jour (2026-08-07) : EDIT_OPTIONS-001 corrigé avant fusion, même
  branche, PR #17 toujours `OPEN`/`DRAFT`/non fusionnée/non déployée.** Une
  revue adversariale indépendante de la PR #17 a signalé un défaut
  MEDIUM/bloquant de fusion : contrairement à `EDIT_CLIENT`/`EDIT_CONTENT`,
  le vrai formulaire `EDIT_OPTIONS` ne pré-remplit jamais
  `notes`/`payment_terms` avec les valeurs actuelles du document — une
  correction ne portant que sur la taxe pouvait donc silencieusement
  effacer une note ou une condition de paiement réelle déjà enregistrée.
  **Corrigé :** vide traité comme « non fourni » pour `notes`/
  `payment_terms`, même principe déjà appliqué à
  `discount_amount`/`validity_days` par le correctif X — une seule règle
  canonique couvre `DOCUMENT_OPTIONS` et `EDIT_OPTIONS`. Effacer
  explicitement une note existante reste structurellement impossible via ce
  Flow ; consigné comme question produit/UX séparée, non traitée ici.
  **Statut : `IMPLEMENTED_NOT_DEPLOYED`.** Voir fiche X.1 de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le détail
  complet, la preuve et les deux suivis produit non bloquants consignés.
* **Mise à jour (2026-08-07) : PR #17 (T1/OPTIONS-001 + EDIT_OPTIONS-001)
  fusionnée dans `main`** (commit de fusion
  `7f09f624b60b58d2de56eedae086be69883f4dad`) — les deux entrées
  ci-dessus restent le compte rendu du contenu du correctif ; seul son
  statut de fusion a changé. Non encore déployée sur Render à la date de
  cette mise à jour.
* **Mise à jour (2026-08-07) : T2/HISTORY-CONTRACT-001 corrigé, nouvelle
  branche dédiée `fix/kadi-v1-history-contract-r0` créée depuis
  `main@7f09f624b60b58d2de56eedae086be69883f4dad`, PR distincte, brouillon,
  non fusionnée, non déployée.** Même défaut de classe que `CLIENT-001`/
  `EDIT-CONTENT-001`/`OPTIONS-001` : le vrai Flow combiné
  `kadi_history_search_v1.json` soumet toujours `query`/`document_type`/
  `date_from`/`date_to`/`document_id` ensemble, quelle que soit l'action
  choisie (`SEARCH`/`OPEN_DOCUMENT`) — **aucune recherche ni ouverture de
  document depuis l'historique ne pouvait jamais réussir via le vrai Flow
  Meta.** Deux défauts supplémentaires, jusque-là masqués par le premier,
  ont été découverts et corrigés dans le même correctif : le texte de
  recherche réel (`query`) n'était jamais transmis au filtre (mauvais
  chemin vérifié dans l'adaptateur — le texte tapé par l'utilisateur était
  silencieusement ignoré) ; `date_from`/`date_to` (noms du Flow) ne
  correspondaient à aucun filtre reconnu côté service (`from`/`to`
  attendus), rejetés avec `HISTORY_FILTER_UNKNOWN`. **Corrigé :**
  `ACTION_FIELDS.SEARCH`/`OPEN_DOCUMENT` élargis pour accepter la vraie
  forme combinée ; `kadiV1RuntimeAdapters.js`'s adaptateur d'historique
  mappe désormais `query`→`text` et `date_from`/`date_to`→`from`/`to` (la
  seule frontière de traduction Flow↔service), avec vide traité comme
  « non fourni » pour tous les champs optionnels, et `document_id` jamais
  transmis au filtre de recherche. Le constat terrain du fondateur
  (recherche réussie, puis échec générique à l'ouverture) est expliqué de
  bout en bout et reproduit avant correctif. **Statut :
  `IMPLEMENTED_NOT_DEPLOYED`.** Voir fiche Y de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le détail
  complet, la preuve et le suivi requis (T3 encore à corriger,
  `FLOW-PARITY-GATE` global toujours un suivi de backlog distinct).
* **Mise à jour (2026-08-07) : HISTORY-CONTRACT-001 suite (`date_to`)
  corrigée avant fusion, même branche, PR #18 toujours
  `OPEN`/`DRAFT`/non fusionnée/non déployée.** Une revue adversariale
  indépendante de la PR #18 a signalé un défaut MEDIUM/bloquant de fusion :
  le vrai champ `date_to` du Flow soumet une date calendaire brute
  (`"2026-04-01"`), analysée par les deux dépôts d'historique (mémoire et
  RPC Supabase `kadi_v1_search_owned_documents`, vérifiée en lecture seule)
  comme un horodatage exact à minuit — une recherche « Au : 1er avril »
  excluait donc silencieusement tout document mis à jour plus tard dans la
  même journée. **Corrigé :** `kadiV1HistoryService.js`'s `normalizeFilters`
  étend désormais une valeur `to` au format `YYYY-MM-DD` jusqu'à la toute
  fin de cette journée calendaire (`23:59:59.999Z`) avant de la transmettre
  au dépôt — le fuseau horaire Burkina Faso (UTC+0 fixe, déjà la convention
  documentée ailleurs dans le dépôt) est réutilisé, aucune nouvelle
  politique inventée. Un horodatage ISO complet explicite reste
  intégralement préservé, jamais réinterprété. **Aucune mutation ni
  migration Supabase.** **Statut : `IMPLEMENTED_NOT_DEPLOYED`.** Voir fiche
  Y.1 de [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le
  détail complet et la preuve.
* **Mise à jour (2026-08-07) : PR #18 (T2/HISTORY-CONTRACT-001 +
  `date_to`) fusionnée dans `main`** (commit de fusion
  `07ea815ce016ac4a034498e436db391486b420ff`) — **T1 et T2 sont donc tous
  deux `CLOSED`/`MERGED`.** Les entrées ci-dessus restent le compte rendu
  du contenu du correctif ; seul son statut de fusion a changé. Non
  encore déployée sur Render à la date de cette mise à jour.
* **Mise à jour (2026-08-07) : T3/RECHARGE-CONTRACT-001 corrigé, nouvelle
  branche dédiée `fix/kadi-v1-recharge-contract-r0` créée depuis
  `main@07ea815ce016ac4a034498e436db391486b420ff`, PR distincte,
  brouillon, non fusionnée, non déployée.** Même défaut de classe que
  `CLIENT-001`/`EDIT-CONTENT-001`/`OPTIONS-001`/`HISTORY-CONTRACT-001` : le
  vrai Flow combiné `kadi_recharge_v1.json` soumet toujours `pack_id`/
  `payment_reference` ensemble, quelle que soit l'action choisie
  (`SELECT_PACK`/`CHECK_PAYMENT`/`CANCEL`) — **aucune sélection de pack,
  aucune vérification de paiement et aucune annulation de recharge ne
  pouvait jamais réussir via le vrai Flow Meta.** Contrainte
  architecturale respectée : `CANCEL` est une action partagée
  globalement par `DOCUMENT_REVIEW`/`DOCUMENT_PREVIEW`/
  `GENERATION_CONFIRMATION`/`RECHARGE` — une nouvelle table flow-aware
  (`FLOW_ACTION_FIELD_OVERRIDES`, consultée avant la liste blanche
  globale) accepte `pack_id`/`payment_reference` uniquement pour
  `RECHARGE`/`CANCEL`, sans jamais faire fuiter ce contrat vers les
  autres Flows (testé explicitement). Traçage complet de la chaîne :
  **aucun défaut de second niveau trouvé** — le reste de la chaîne
  (résolution du pack depuis le catalogue serveur, isolation
  propriétaire de `CHECK_PAYMENT`/`CANCEL`, rejet des champs financiers
  fournis par le client) était déjà correct. Un défaut de la même classe,
  confirmé pour `GENERATION_CONFIRMATION`/`CANCEL`, est délibérément
  **non corrigé** et consigné pour un futur T4. **Statut :
  `IMPLEMENTED_NOT_DEPLOYED`.** Voir fiche Z de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le
  détail complet, la preuve et le suivi requis.
* **Mise à jour (2026-08-07) : RECHARGE-CONTRACT-001 suite (annulation
  inter-session, HIGH/P0) corrigée avant fusion, même branche, PR #19
  toujours `OPEN`/`DRAFT`/non fusionnée/non déployée.** Une revue
  adversariale indépendante de la PR #19 a signalé un défaut HIGH/P0,
  bloquant de fusion : `kadiV1FlowReplyRuntime.js`'s `handle()` exécute
  toujours la commande métier même quand la couche session a déjà
  identifié un rejeu exact comme doublon, et `RECHARGE`/`CANCEL`
  (contrairement à `SELECT_PACK`/`CHECK_PAYMENT`) n'avait aucune clé
  d'idempotence propre — il résolvait toujours « la recharge active la
  plus récente du propriétaire », sans aucune borne. **Deux scénarios
  concrets prouvés dans la composition de production avant correctif :**
  un rejeu différé d'un message `CANCEL` déjà consommé pouvait annuler une
  recharge plus récente et totalement différente ; un Flow `RECHARGE`
  obsolète, jamais encore soumis, pouvait annuler une recharge créée après
  son ouverture — ni l'un ni l'autre n'est un rejeu classique. **Corrigé :**
  `sessionOpenedAt` (l'instant serveur de confiance auquel la session Flow
  exacte a été ouverte, jamais fourni par le client) borne désormais quelle
  session de recharge `cancel()` peut cibler — seule une session créée à
  ou avant cet instant est éligible. **Aucune nouvelle colonne Supabase** :
  `opened_at` et `created_at` existent déjà toutes les deux sur leurs
  tables respectives. Un raccourci générique de doublon dans `handle()` a
  été envisagé mais délibérément écarté, faute de preuve exhaustive de son
  innocuité pour tous les Flows existants — solution la plus petite et
  spécifique à `RECHARGE` retenue à la place. Incohérence signalée, non
  tranchée : le libellé « Revenir plus tard » du bouton `CANCEL` suggère
  une pause reprenable, alors que le comportement réel place la recharge
  dans un état terminal `CANCELLED` définitivement non créditable — décision
  produit à prendre séparément. **Statut : `IMPLEMENTED_NOT_DEPLOYED`.**
  Voir fiche Z.1 de [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md)
  pour le détail complet et la preuve.
* **Mise à jour (2026-08-07) : RECHARGE-CONTRACT-001 suite 2 (rejeu exact
  avec plusieurs recharges actives préexistantes, HIGH/P0) corrigée avant
  fusion, même branche, PR #19 toujours `OPEN`/`DRAFT`/non fusionnée/non
  déployée.** Une nouvelle revue adversariale indépendante a signalé que
  `sessionOpenedAt` (correctif précédent) empêche bien un `CANCEL`
  obsolète d'affecter une recharge créée après l'ouverture de la session
  Flow, mais ne rend pas `cancel()` idempotent quand **plusieurs**
  recharges actives existaient déjà avant cette ouverture (aucune
  contrainte n'impose une seule recharge active par propriétaire) : un
  rejeu exact d'un `CANCEL` déjà consommé, après un premier `CANCEL`
  ayant annulé la plus récente des deux, pouvait annuler à tort la
  seconde, plus ancienne. **Prouvé concrètement dans la composition de
  production avant correctif.** **Corrigé :** un court-circuit strictement
  limité à la paire `(RECHARGE, CANCEL)` dans
  `kadiV1FlowReplyRuntime.js`'s `handle()` — quand la couche session
  signale un doublon exact pour cette paire précise, la commande métier
  n'est plus jamais réexécutée du tout. Le signal utilisé est le même état
  de session persisté déjà authentifié ailleurs (jamais un indicateur en
  mémoire), donc valide après un redémarrage de processus — prouvé
  explicitement en reconstruisant toute la pile runtime autour des mêmes
  dépôts persistés. Compromis assumé et documenté : un `CANCEL` réellement
  échoué (erreur transitoire) ne peut plus être repris automatiquement par
  un simple rejeu de webhook — l'utilisateur doit rouvrir une nouvelle
  session Flow. Aucune autre action ni aucun autre Flow affecté (prouvé
  explicitement pour `DOCUMENT_REVIEW`/`DOCUMENT_PREVIEW`/
  `GENERATION_CONFIRMATION`). **Statut : `IMPLEMENTED_NOT_DEPLOYED`.** Voir
  fiche Z.2 de [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md)
  pour le détail complet et la preuve.
* **Mise à jour (2026-08-07) : RECHARGE-CONTRACT-001 suite 3 (glissement
  de cible d'annulation, HIGH/P0) corrigée avant fusion, même branche, PR
  #19 toujours `OPEN`/`DRAFT`/non fusionnée/non déployée.** Une troisième
  revue adversariale indépendante a signalé que la requête de ciblage de
  R1 filtrait le statut (`CREATED`/`PAYMENT_PENDING`) **avant** de choisir
  la recharge contextuellement la plus récente : si la recharge réellement
  la plus récente au moment de l'ouverture du Flow changeait ensuite
  d'état (créditée, annulée ailleurs) avant que `CANCEL` ne soit soumis,
  la requête glissait silencieusement vers une recharge plus ancienne
  encore éligible au filtre de statut — annulant une recharge dont ce
  contexte Flow n'a jamais parlé, même sur une soumission réellement
  première. **Prouvé concrètement dans la composition de production avant
  correctif**, avec une recharge B créditée via un vrai `CHECK_PAYMENT`
  puis une recharge A plus ancienne annulée à tort. **Corrigé :** la
  session contextuelle la plus récente est désormais résolue d'abord
  (bornée par `sessionOpenedAt`, sans filtre de statut), puis son
  éligibilité est vérifiée séparément — en cas d'inéligibilité, échec
  fermé immédiat, sans jamais rechercher une autre recharge plus
  ancienne. L'ensemble de statuts annulables reste intentionnellement
  inchangé (`CREATED`/`PAYMENT_PENDING`), sans extension à `FAILED` sans
  autorisation produit explicite. **Statut : `IMPLEMENTED_NOT_DEPLOYED`.**
  Voir fiche Z.3 de [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md)
  pour le détail complet et la preuve.
* **Validation téléphone requise après déploiement éventuel :** comme pour
  tout correctif de cette branche, la validation manuelle sur téléphone
  reste requise après un déploiement réel avant de considérer un parcours
  comme confirmé en production — un test de composition, même complet,
  n'observe jamais le rendu visuel réel d'un écran WhatsApp Flow.
* **Mise à jour (2026-08-07) : PR #19 fusionnée dans `main`.**
  `main@71362c71a5524d1c24192f584ca3cb7f3fe20785`.
  **T1/OPTIONS-001, T2/HISTORY-CONTRACT-001 et T3/RECHARGE-CONTRACT-001 sont
  désormais tous `CLOSED/MERGED`.** Le déploiement Render de ce commit
  n'est pas vérifiable depuis cet environnement — ne pas déduire qu'il a
  été déployé, ni qu'il ne l'a pas été ; la validation téléphone réelle du
  parcours `RECHARGE` reste en attente.
* **Mise à jour (2026-08-07) : T4/GENERATION_CONFIRMATION-001 (annulation
  de confirmation de génération) corrigée, branche isolée
  `fix/kadi-v1-generation-confirmation-cancel-t4` créée depuis
  `main@71362c71a5524d1c24192f584ca3cb7f3fe20785`, PR brouillon ouverte,
  **non fusionnée, non déployée.** Le vrai Flow combiné
  `kadi_generation_confirmation_v1.json` soumet toujours `quote_id`, quelle
  que soit l'action (`CONFIRM_GENERATION`/`CANCEL`) — une vraie annulation
  depuis `AWAITING_GENERATION_CONFIRMATION` ne pouvait jamais réussir via
  le vrai Flow Meta (`KADI_V1_FLOW_REPLY_FIELD_FORBIDDEN`), même défaut de
  classe que RECHARGE-CONTRACT-001 (T3). **Corrigé** par le même mécanisme
  flow-aware (`FLOW_ACTION_FIELD_OVERRIDES`) : `quote_id` accepté
  uniquement pour `GENERATION_CONFIRMATION`/`CANCEL`, sans fuite vers
  `DOCUMENT_REVIEW`/`DOCUMENT_PREVIEW`/`RECHARGE` (prouvé explicitement).
  `quote_id` n'est jamais devenu une autorité de ciblage : le routage
  générique existant vers `documentRuntime.cancel(documentBase)` (jamais
  `command.data`) était déjà correct et n'a pas été modifié — seul le
  contexte document de session serveur décide du document affecté.
  Traçage complet de la chaîne : aucun défaut de second niveau masqué —
  l'annulation était déjà idempotente via le pipeline document partagé
  existant (aucun court-circuit spécifique RECHARGE copié). Constat
  confirmé : les transitions d'état pures (`CANCEL` inclus) ne font jamais
  avancer `document.version` — seules les mutations de contenu le font —
  donc le risque réel pour un Flow obsolète est une course d'état, pas une
  course de version ; le même mécanisme serveur (`fromState` + table
  `TRANSITIONS`) échoue fermé de façon identique, sans champ contrôlé par
  le client. Un seul fichier de production modifié
  (`kadiV1FlowReplyRuntime.js`, ajout additif). Tests ciblés (287/287) puis
  suite complète (1418/1418), `git diff --check` propre, revue
  adversariale du diff complet sans défaut HIGH/MEDIUM. **Statut :
  `IMPLEMENTED_NOT_DEPLOYED`, en attente de revue adversariale
  indépendante et de fusion.** Voir fiche AA de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le détail
  complet et la preuve.
* **Mise à jour (2026-08-07) : GENERATION_CONFIRMATION-001 suite (autorité
  d'état d'une session obsolète, HIGH/P0) corrigée avant fusion, même
  branche, PR #20 toujours `OPEN`/`DRAFT`/non fusionnée/non déployée.**
  Une revue adversariale indépendante a signalé que
  `documentBase.documentState` (déjà porté par `FlowCommandRuntime`)
  n'était jamais lu par `createKadiV1DocumentRuntimeAdapter.cancel()` —
  comme les transitions d'état pures ne font jamais avancer
  `document.version`, une session `GENERATION_CONFIRMATION` obsolète
  pouvait encore annuler à tort un document ayant légitimement basculé
  vers `RECHARGE_REQUIRED` ou `GENERATION_IN_PROGRESS` depuis l'ouverture
  de sa session. **Prouvé concrètement dans la composition de production
  avant correctif**, avec la pile réelle de génération (réservation,
  rendu réel, capture, livraison) — y compris pendant une génération
  réellement en vol, via une barrière déterministe injectée dans le
  renderer réel (jamais un `sleep`) — et sur la pipeline `DECHARGE`
  également. **Corrigé :** un `expectedState` optionnel, réservé à
  `GENERATION_CONFIRMATION`/`CANCEL`, participe désormais au même contrat
  de mutation durable que l'annulation (vérifié contre le statut déjà lu,
  jamais une lecture séparée), avec le contrôle atomique déjà existant de
  `storage.persistTransition` comme filet final contre toute course
  réelle — aucune fonctionnalité générique de `CANCEL` affaiblie pour les
  autres Flows. **Statut : `IMPLEMENTED_NOT_DEPLOYED`.** Tests ciblés
  (378/378) puis suite complète (1430/1430), `git diff --check` propre.
  Voir fiche AA.1 de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le
  détail complet et la preuve.
* **Mise à jour (2026-08-07) : PR #20 fusionnée dans `main`.**
  `main@a2c2ead17e109c2de5c46905c291f5133cc817ab`.
  **T4/GENERATION_CONFIRMATION-001 est désormais `CLOSED/MERGED`** (avec
  T1/T2/T3 déjà fusionnés). Le déploiement Render de ce commit n'est pas
  vérifiable depuis cet environnement — ne pas déduire qu'il a été
  déployé, ni qu'il ne l'a pas été.
* **Mise à jour (2026-08-07) : T4.5/DOCUMENT_CANCEL_STATE_AUTHORITY_GATE
  corrigée, branche isolée
  `fix/kadi-v1-document-cancel-state-authority-t4-5` créée depuis
  `main@a2c2ead17e109c2de5c46905c291f5133cc817ab`, PR brouillon ouverte,
  **non fusionnée, non déployée.** Une revue adversariale indépendante de
  la PR #20/T4 a signalé que le même défaut d'autorité d'état de session
  obsolète fermé pour `GENERATION_CONFIRMATION`/`CANCEL` (fiche AA.1)
  existait aussi, non corrigé, pour `DOCUMENT_REVIEW`/`CANCEL` et
  `DOCUMENT_PREVIEW`/`CANCEL`, qui routaient tous deux par la branche
  générique de document sans jamais transmettre `expectedState`. Preuve
  d'architecture établie d'abord : ouvrir une nouvelle session Flow ne
  révoque jamais les sessions `OPEN` précédentes
  (`kadiV1ConversationSession.js`'s `revoke()` n'a aucun appelant en
  production) — une soumission obsolète est un scénario toujours
  possible. États légitimes tracés depuis le routage réel de production
  (`kadiV1ProductionPresenter.js`'s `routeDocument`) :
  `DOCUMENT_REVIEW` ⟺ `READY_FOR_REVIEW` uniquement ;
  `DOCUMENT_PREVIEW` ⟺ `VERIFIED` ou `PREVIEW_READY` (un second état de
  repos réel et durable, confirmé par inspection de
  `kadiV1PreviewService.js`). **Prouvé concrètement dans la composition
  de production avant correctif**, avec la pile réelle de génération —
  huit reproductions distinctes, y compris une annulation obsolète
  acceptée à tort pendant une génération réellement en vol
  (`GENERATION_IN_PROGRESS`, barrière déterministe sur le renderer réel).
  **Corrigé** en réutilisant sans aucune modification le primitif
  `expectedState` déjà introduit en T4 — un seul fichier de production
  modifié (`kadiV1FlowCommandRuntime.js`). **Statut :
  `IMPLEMENTED_NOT_DEPLOYED`.** Tests ciblés (405/405) puis suite complète
  (1457/1457), `git diff --check` propre. Voir fiche AA.2 de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le
  détail complet et la preuve.
* **Mise à jour (2026-08-07) : PR #21 fusionnée dans `main`.**
  `main@1b605ebd34e0fe259f221a60f8b697038f13e9ef`.
  **T4.5/DOCUMENT_CANCEL_STATE_AUTHORITY_GATE est désormais
  `CLOSED/MERGED`** (avec T1/T2/T3/T4 déjà fusionnés). Le déploiement
  Render de ce commit n'est pas vérifiable depuis cet environnement — ne
  pas déduire qu'il a été déployé, ni qu'il ne l'a pas été.
* **Mise à jour (2026-08-07) : T6/BALANCE-001 corrigée, branche isolée
  `fix/kadi-v1-available-balance-t6` créée depuis
  `main@1b605ebd34e0fe259f221a60f8b697038f13e9ef`, PR brouillon ouverte,
  **non fusionnée, non déployée. Aucune migration appliquée à Supabase de
  production.** Deux défauts confirmés : (A) `ProductionPresenter`
  retombait systématiquement sur le texte statique « Votre solde a été
  consulté. » au lieu du solde numérique réel — **prouvé concrètement
  avant correctif** (`git stash` du correctif puis restauration, 11/17
  scénarios E2E échouant comme prévu) ; (B) **BILL-001 confirmé** —
  `kadi_v1_get_wallet_balance` retournait le solde brut du portefeuille,
  ignorant les retenues de crédit vivantes (`kadi_v1_wallet_reservations`
  `status = 'RESERVED'`) que `kadi_v1_reserve_generation_credits` utilise
  déjà pour déterminer la solvabilité réelle — un solde brut de 10 avec 3
  crédits retenus aurait pu afficher « 10 crédits » alors que seuls 7
  sont réellement engageables. **Corrigé** : nouvelle migration
  forward-only remplaçant en place le corps de la fonction existante
  (même nom/signature, `balance` préservé pour compatibilité ascendante,
  `kadiV1RechargeService.js`'s `resumePendingGeneration` — l'unique
  appelant existant du nombre brut — confirmé inchangé) ; nouvelle
  méthode additive `getAvailableBalance()` tracée de bout en bout jusqu'au
  port `walletRuntime` partagé par `FlowCommandRuntime` **et**
  `ConversationOrchestrator`, garantissant que « Mon solde » et « Quel
  est mon solde ? » rapportent toujours le même nombre. Échec fermé à
  chaque couche sur tout état financier impossible. **Statut :
  `IMPLEMENTED_NOT_DEPLOYED`.** Tests ciblés (317/317) puis suite complète
  (1498/1498), `git diff --check` propre. Voir fiche AA.3 de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le
  détail complet et la preuve.
* **Mise à jour (2026-08-07) : T6 R1 (documentation uniquement) — revue
  adversariale indépendante de la PR #22.** Code R0 confirmé correct,
  aucun changement de code. Un défaut MEDIUM corrigé dans
  `docs/KADI_RELEASE_CHECKLIST.md` : l'ordre de déploiement décrit devait
  appliquer **la migration Supabase en premier** (elle préserve `balance`,
  rétrocompatible avec le code Render actuellement déployé), la vérifier
  en lecture seule, puis seulement ensuite déployer le nouveau code
  Render — jamais l'inverse, sous peine de casser `BALANCE` en
  production si la migration n'était pas encore appliquée ou échouait
  après le déploiement. Toujours **`IMPLEMENTED_NOT_DEPLOYED`, aucune
  migration appliquée à Supabase de production.** Constat backlog séparé
  enregistré, non corrigé ici : `RECHARGE_RESUME_AVAILABLE_BALANCE_001`
  (MEDIUM/P1 avant RC — `kadiV1RechargeService.js`'s
  `resumePendingGeneration` reste basé sur le solde brut, préexistant,
  hors périmètre T6). Voir fiche AA.3 de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le
  détail complet.
* **Mise à jour (2026-08-07) : T5/RECHARGE_PRESENTER_001 corrigé,
  branche isolée `fix/kadi-v1-recharge-presenter-t5` créée depuis
  `main@87b95bfa41ec40d6e0da5a7a53b25f9ecc2563f2`, PR brouillon ouverte,
  **non fusionnée, non déployée. Aucune migration touchée par T5.**
  Défaut confirmé : le Flow RECHARGE réel affichait toujours les valeurs
  `__example__` du JSON (« Solde actuel : 0 crédit. », packs
  PACK_1000/2000/5000 d'exemple) au lieu du solde disponible réel (T6) et
  du catalogue de packs actif réel — **prouvé concrètement avant
  correctif** (`git stash` puis restauration : solde réel de 7 crédits
  affichant « Solde actuel : 0 crédit. »). **Corrigé** : le presenter
  reçoit désormais deux dépendances optionnelles étroites,
  `balanceReader`/`packCatalog`, **les mêmes instances** déjà câblées
  dans `walletRuntime`/`RechargeService` — jamais un second calcul
  financier ni une seconde liste de packs. Échec fermé systématique :
  échec de lecture du solde → « Solde indisponible pour le moment. »,
  jamais un zéro fabriqué ; zéro pack actif → liste vide, jamais les
  exemples du JSON présentés comme réels. Libellé CANCEL corrigé
  (« Annuler cette recharge » au lieu de « Revenir plus tard », qui
  décrivait à tort une annulation terminale réelle comme un simple
  ajournement), avec une copie de confirmation dédiée à RECHARGE,
  déterminée par le `flow_key` vérifié côté serveur — les autres CANCEL
  (`DOCUMENT_REVIEW`, `DOCUMENT_PREVIEW`, `GENERATION_CONFIRMATION`)
  inchangés. R1/R2/R3 de T3 (intégrité d'annulation), le contrat combiné
  `pack_id`/`payment_reference`, et le comportement `SELECT_PACK`/
  `CHECK_PAYMENT` existants tous confirmés inchangés. **Nouveau constat
  non corrigé** : au moment précis où `CONFIRM_GENERATION` échoue avec
  `INSUFFICIENT_CREDITS`, l'utilisateur ne voit qu'un texte générique de
  récupération, sans Flow RECHARGE ni invitation à recharger — celui-ci
  n'apparaît qu'en rouvrant plus tard le document bloqué depuis
  l'historique. Délibérément hors périmètre de T5. **Statut :
  `IMPLEMENTED_NOT_MERGED`.** Tests ciblés (242/242) puis suite complète
  (1520/1520), `git diff --check` propre. Voir fiche AB de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le
  détail complet et la preuve.
* **Mise à jour (2026-08-08) : T5 R1 (revue adversariale indépendante de
  la PR #23) — deux défauts confirmés et corrigés, un LOW corrigé.**
  Même branche, même PR #23, toujours **`IMPLEMENTED_NOT_MERGED`, aucune
  migration touchée.** **HIGH/P0 :** `recharge_actions` offrait toujours
  CANCEL dès que RECHARGE s'ouvrait, y compris pour un document
  fraîchement `RECHARGE_REQUIRED` n'ayant jamais appelé SELECT_PACK —
  `cancel()` résout sa cible par propriétaire + `sessionOpenedAt` seuls
  (jamais par document), donc un CANCEL soumis depuis ce contexte non lié
  pouvait annuler une recharge plus ancienne et complètement étrangère du
  même propriétaire. **Corrigé**, deux couches : CANCEL n'est offert que
  lorsqu'une vraie session de recharge vient d'être créée pour cet écran
  précis (après SELECT_PACK/CHECK_PAYMENT) ; défense en profondeur
  côté serveur (`kadiV1FlowCommandRuntime.js`) rejetant tout CANCEL dont
  le contexte de session fiable montre un document `RECHARGE_REQUIRED`,
  avant même d'appeler `cancel()`. R1/R2/R3 de T3 confirmés inchangés.
  **MEDIUM/P1 :** confirmé — `INSUFFICIENT_CREDITS` n'ouvrait jamais le
  Flow RECHARGE, seulement un texte générique de récupération. **Corrigé**
  à la frontière Flow/runtime (`kadiV1RuntimeAdapters.js`'s adaptateur de
  génération, jamais le service de génération lui-même) : relit le
  document après l'échec et, uniquement si son statut actuel est
  authentiquement `RECHARGE_REQUIRED`, route immédiatement vers RECHARGE
  avec une copie truthful — plus de détour par l'historique. Rejeu exact
  confirmé sûr (zéro deuxième mutation, marqué duplicate). **LOW :**
  l'étiquette de pack codait en dur « FCFA » quelle que soit
  `pack.currency` — corrigé, aucune valeur de pack actuelle modifiée.
  **Statut : `IMPLEMENTED_NOT_MERGED`.** Tests ciblés (379/379) puis
  suite complète (1526/1526), `git diff --check` propre. Reproduction
  avant correctif prouvée concrètement (`git stash` des 4 fichiers de
  production R1 puis restauration). Voir fiche AB.1 de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le
  détail complet et la preuve.
* **Mise à jour (2026-08-08) : T5 R2 (revue adversariale indépendante de
  la PR #23) — un HIGH et un MEDIUM confirmés et corrigés.** Même
  branche, même PR #23, toujours **`IMPLEMENTED_NOT_MERGED`, aucune
  migration touchée.** **HIGH/P0 (trou restant après R1) :** l'ouverture
  RECHARGE conversationnelle directe ne touche jamais de document, donc
  la défense R1 (basée sur `documentContext`) n'avait aucun signal sur
  lequel agir — un CANCEL forgé depuis cette session pouvait toujours
  annuler une recharge étrangère plus ancienne du même propriétaire
  (**prouvé concrètement avant correctif**, `git stash`/restauration
  contre le code réel R1). **Corrigé** : le CANCEL terminal est retiré du
  Flow RECHARGE dans **tous** les contextes (y compris après
  SELECT_PACK/CHECK_PAYMENT, qui n'offraient CANCEL qu'en R1) — une
  liaison fiable exigerait un `recharge_session_id` persistant dans le
  modèle de session, une migration explicitement hors périmètre.
  `kadiV1FlowCommandRuntime.js` rejette désormais RECHARGE/CANCEL de
  façon inconditionnelle, côté serveur. La primitive de plus bas niveau
  (`rechargeRuntime.cancel()`) reste inchangée et continue d'être testée
  directement. **MEDIUM/P1 :** le correctif R1 classait à tort
  `DOCUMENT_VERSION_CONFLICT` comme un rejeu sûr dès que le document
  relu était `RECHARGE_REQUIRED`, sans vérifier que sa version/son type
  correspondaient encore à la commande d'origine — une commande obsolète
  pour une version N aurait pu être classée comme rejeu sûr d'une
  confirmation postérieure et indépendante ayant atteint la version N+1.
  **Corrigé** : `DOCUMENT_VERSION_CONFLICT` n'est plus jamais classé
  comme rejeu ; `GENERATION_CONFIRMATION_STATE_INVALID` ne l'est que si
  un nouveau signal fiable `exactReplay` (propagé depuis le signal de
  rejeu exact authentique de `kadiV1FlowReplyRuntime.js`, jamais fourni
  par le client) est vrai **et** que la version/le type relus
  correspondent exactement à la commande d'origine. **Statut :
  `IMPLEMENTED_NOT_MERGED`.** Tests ciblés (483/483) puis suite complète
  (1527/1527), `git diff --check` propre. Voir fiche AB.2 de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le
  détail complet et la preuve.
* **Mise à jour (2026-08-09) : PR #23 fusionnée dans `main`.**
  `main@6d4ac32d8cbe069a05425394f9eddf3385283c8d`. **T5/RECHARGE_PRESENTER_001
  (R0+R1+R2) est désormais `CLOSED/MERGED`** — solde et catalogue de
  packs authoritative dans RECHARGE, routage immédiat
  `INSUFFICIENT_CREDITS` → RECHARGE, CANCEL terminal retiré du Flow
  RECHARGE dans tous les contextes, modèle d'autorité de rejeu resserré.
  Le déploiement Render de ce commit n'est pas vérifiable depuis cet
  environnement — ne pas déduire qu'il a été déployé, ni qu'il ne l'a pas
  été.
* **Mise à jour (2026-08-09) : T7 confirmé `CLOSED BY T1 / PR #17`.**
  Aucun nouveau code de production requis. Preuve déjà présente :
  `kadiV1SharedDocumentPolicies.js` mappe le champ plat `validity_days`
  (soumis par le vrai Flow `DOCUMENT_OPTIONS`) vers
  `document.options.validity_days` ; le test
  `tests/kadiV1SharedDocumentPipeline.test.js`'s « OPTIONS-001: DEVIS
  validity_days submitted as the real flat field genuinely persists and
  is retrievable afterward » (fiche X de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md), T1/PR #17)
  prouve la persistance et la relecture sur un dépôt frais.
* **Mise à jour (2026-08-09) : T10/ORANGE-MONEY-TEST-001 — couverture de
  composition de production du VRAI fournisseur Orange Money, branche
  isolée `fix/kadi-v1-orange-money-real-provider-t10` créée depuis
  `main@6d4ac32d8cbe069a05425394f9eddf3385283c8d`, PR #24 brouillon
  ouverte, **non fusionnée, non déployée. Aucune migration appliquée à
  distance, aucune mutation Supabase/Meta/Render/WhatsApp réelle.**
  R0 : mission de preuve pure, `createManualOrangeMoneyPaymentProvider()`
  (`kadiV1ProductionInfrastructure.js`) existait déjà et n'avait pas été
  modifié ; nouveau fichier `tests/kadiV1OrangeMoneyRealProviderE2E.test.js`
  (15 scénarios) exerçant ce vrai fournisseur —
  `createPaymentRequest`/`getPaymentStatus`/`verifyPaymentEvent` jamais
  mockés — à travers `kadiV1RechargeService.js`/`createKadiV1RechargeRuntime`
  réels, avec un seul point de simulation externe : un client Supabase
  factice minimal implémentant exactement les deux tables que le vrai
  fournisseur interroge (`kadi_v1_recharge_sessions`, une vraie table V1
  migrée, et `kadi_topups`, une table historique pré-V1 sans fichier de
  migration dans ce dépôt).
  **R1 (revue indépendante) : ORANGE_TOPUP_REFERENCE_CONCURRENCY_001
  (MEDIUM/P1), corrigé.** Une inspection en lecture seule autorisée du
  projet Supabase réel a confirmé le contrat de colonnes de `kadi_topups`
  (`id`, `wa_id`, `reference`, `amount_fcfa`, `credits`, `includes_stamp`,
  `status`, `proof_text`, `proof_image_url`, `payment_method`,
  `created_at`, `updated_at`, `approved_at`, `rejection_reason`, RLS
  activé) — l'ancienne caractérisation `UNKNOWN_REQUIRES_RUNTIME_CHECK`
  de `docs/kadi_v1_legacy_data_migration_policy.md` est donc obsolète
  pour l'existence des colonnes. Fait clé : **`reference` n'a aucune
  contrainte d'unicité** (seule la clé primaire `id` est unique), et il
  existe exactement un groupe de références dupliquées préexistant (2
  lignes, toutes deux legacy/non-V1, toutes deux `pending` ; valeur
  jamais consignée nulle part dans ce dépôt) ; zéro doublon dans
  l'espace de noms `recharge:%` de Kadi V1 au moment de l'inspection.
  Défaut : deux appels `createPaymentRequest()` concurrents pour la même
  `merchant_reference` pouvaient tous deux lire « aucune ligne
  existante » puis tous deux insérer, créant deux lignes physiques
  partageant une référence, après quoi `getPaymentStatus()` ne pouvait
  plus résoudre une ligne unique. Correction : nouvelle migration
  forward-only `migrations/20260809_add_kadi_v1_topups_recharge_reference_unique.sql`
  (index unique **partiel**, `WHERE reference LIKE 'recharge:%'` —
  jamais `UNIQUE(reference)` global, ce qui casserait immédiatement sur
  le doublon legacy existant) protégeant uniquement l'espace de noms V1 ;
  `createPaymentRequest()` récupère désormais une violation Postgres
  `23505` sur cette référence, relit la ligne existante et vérifie sa
  compatibilité (`wa_id`, `amount_fcfa`, `credits`, `payment_method`)
  avant de l'adopter — sinon `PAYMENT_REQUEST_EXISTING_MISMATCH`, jamais
  d'adoption silencieuse d'une ligne non liée. **La migration n'est PAS
  appliquée à distance par cette mission** — ordre de déploiement
  obligatoire : migration d'abord, vérifiée en lecture seule, puis
  seulement le backend portant ce correctif (voir
  [`KADI_RELEASE_CHECKLIST.md`](KADI_RELEASE_CHECKLIST.md)). 9 nouveaux
  scénarios R1 (reproduction pré-correctif, exactement-une-fois
  post-correctif sous course concurrente, idempotence séquentielle,
  non-régression sur le doublon legacy, quatre cas de ligne existante
  incompatible) portent le fichier de test à 24 scénarios.
  Preuve du crédit exactement une fois : rejeu du même webhook WhatsApp,
  rejeu d'un événement de paiement frais pour un paiement déjà crédité,
  reconstruction complète du runtime (redémarrage simulé — preuve limitée
  à la persistance en mémoire du processus, ne prouve pas l'atomicité
  inter-processus du dépôt Supabase réel, garantie en production par
  `kadi_v1_confirm_recharge_credit()`'s propre verrou
  `pg_advisory_xact_lock` + `for update`), et désormais une course
  concurrente réelle sur `createPaymentRequest()` — aucun ne produit de
  second crédit. Solde erroné, devise non-XOF, référence inconnue,
  isolation propriétaire et recharges multiples en attente tous échouent
  fermé, crédit zéro. Continuité T5 (packs/solde authoritative, CANCEL
  toujours non exposé) et parité T6 (solde disponible canonique)
  confirmées à travers le vrai chemin fournisseur. **Statut :
  `IMPLEMENTED_NOT_MERGED`.** Tests ciblés puis suite complète
  (1558/1558), `git diff --check` propre. Voir fiche AC de
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) pour le
  détail complet et la preuve.

## Blocages connus

* **Meta 141006** — les conversations initiées par l'entreprise (proactives)
  restent bloquées par un problème de moyen de paiement côté compte Meta
  Business. **Statut : `BLOCKED`.** Les interactions initiées par
  l'utilisateur (l'utilisateur écrit en premier) ne sont pas concernées par
  ce blocage. Voir
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) fiche A.

## Séquence prévue pour la suite d'INVOICE_TYPE

1. documentation (cette mission) ; **fait** ;
2. publication du Flow `KADI_INVOICE_TYPE_V1` sur Meta ; **fait** — Flow ID
   `2500135057170722`, `PUBLISHED` ;
3. configuration de `KADI_V1_FLOW_INVOICE_TYPE_ID` sur Render ; **fait** ;
4. application de la migration
   `20260805030000_add_kadi_v1_invoice_type_flow_key.sql` sur Supabase
   distant ; **non confirmée** — seule étape restante pour cet écran ;
5. déploiement Render du service `kadi-backend` ; **fait** (service
   `READY`) ;
6. nouveau parcours de test en CANARY (jamais de reprise d'un ancien Flow
   ouvert avant publication — voir
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) fiche F).
   **Non encore confirmé** — c'est ce qui manque encore pour passer
   `INVOICE_TYPE`, `RECEIPT_DETAILS` et `DISCHARGE_DETAILS` à
   `VALIDATED_CANARY`.

La même séquence s'applique à `RECEIPT_DETAILS` (Flow `KADI_RECEIPT_DETAILS_V1`,
Flow ID `1325710445984629`, `PUBLISHED` ; variable
`KADI_V1_FLOW_RECEIPT_DETAILS_ID` configurée ; migration
`20260805040000_add_kadi_v1_receipt_details_flow_key.sql` confirmée
appliquée) et à `DISCHARGE_DETAILS` (Flow `KADI_DISCHARGE_DETAILS_V2`, Flow
ID `1725047255448294`, `PUBLISHED`, déployé en CANARY ; ancien Flow
`KADI_V1_DISCHARGE_DETAILS` conservé intact pour rollback) : les étapes 1 à
5 sont faites pour les trois écrans. La seule étape encore ouverte pour les
trois est l'étape 6 — **un nouveau parcours WhatsApp démarré après la
publication**, jamais la reprise d'une session déjà ouverte avant la
publication du Flow, qui continuerait de représenter l'ancienne version et
ne doit jamais servir à valider ces correctifs.

## Prochaine étape produit après validation d'INVOICE_TYPE

* **Statut : `PLANNED`.** Reçu au format A4 et reçu au format ticket 80 mm
  (`receipt_format = A4 | TICKET_80`, voir
  [`KADI_PRODUCT_RULES.md`](KADI_PRODUCT_RULES.md)).

## FUSIONNÉ, CÂBLÉ, DÉSACTIVÉ — `KADI_CONVERSATIONAL_MULTIMODAL_V1`

**Ceci n'est pas un comportement utilisateur actif.** Section séparée à
dessein — voir
[`KADI_CONVERSATIONAL_MULTIMODAL_V1.md`](KADI_CONVERSATIONAL_MULTIMODAL_V1.md)
pour le détail complet.

* **Statut : `MERGED_DEPLOYMENT_UNVERIFIED_DISABLED_NOT_ACTIVATED`.** Les
  deux livraisons (fondation et intégration orchestrateur/bootstrap) sont
  désormais fusionnées dans `main` :
  [PR #8](https://github.com/GueswendeOue/kadi-backend/pull/8) (commit de
  merge `c3030c909fdb526c5341622afe5a8b5389f0a77d`) et
  [PR #10](https://github.com/GueswendeOue/kadi-backend/pull/10) (commit de
  merge `c23ea3bfa58ddc95baff799e617da581279d8c1f`, après revue
  adversariale indépendante et corrections). Le déploiement Render de ces
  commits n'est pas vérifiable depuis cet environnement (aucun accès
  Render) — ne pas déduire qu'ils ont été déployés, ni qu'ils ne l'ont pas
  été.
* **Aucun impact utilisateur, déployé ou non** : les deux flags restent
  `false` par défaut (`KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED`,
  `KADI_GEMINI_AUDIO_V1_ENABLED`), et
  `KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS` n'est configuré nulle
  part sur Render. Le code **est** désormais câblé dans
  `kadiV1ConversationOrchestrator.js` et `kadiV1ProductionBootstrap.js`,
  mais chaque point d'entrée conversationnel reste conditionné à ce flag et
  à cette allowlist, tous deux inertes par défaut — même si Render a
  déployé ces commits, aucun trafic, CANARY ou autre, ne peut activer ce
  chemin sans une configuration Render explicite et distincte.
* Fichiers de la fondation (sur `main`) :
  `kadiV1ConversationalMultimodalContracts.js`,
  `kadiV1ConversationalMultimodalPolicy.js`, `kadiV1GeminiAudioProvider.js`.
* **Intégration orchestrateur/bootstrap : implémentée, testée, revue de
  façon adversariale (corrections appliquées), fusionnée dans `main`**
  (nouveaux fichiers `kadiV1ConversationalMultimodalRuntimeAdapter.js`,
  `kadiV1ConversationalMultimodalBrainAdapter.js`,
  `kadiV1ConversationalMultimodalItemLookup.js`,
  `kadiV1ConversationalMultimodalObservability.js`, plus des ajouts
  additifs à `kadiV1ConversationOrchestrator.js` (branches `RECHARGE`,
  `REMOVE_ITEM`, `CHANGE_DOCUMENT_TYPE`, un court-circuit déterministe
  `PREPARE_DOCUMENT` désormais conditionnel à un nouveau paramètre optionnel
  `conversationalEligibilityGate`, et un nouveau paramètre optionnel
  `conversationalObservabilityEmit` — seul et unique endroit qui émet
  `conversational_draft_applied`, et seulement après succès backend
  confirmé), `kadiV1ProductionOrchestratorComposition.js`,
  `kadiV1ProductionBootstrap.js`, `kadiV1CanaryIngress.js`. Trois fichiers
  déjà utilisés par le parcours Flow Meta CANARY reçoivent une nouvelle
  méthode additive `changeDocumentType` (`kadiV1DocumentDomain.js`,
  `kadiV1SharedDocumentPipeline.js`, `kadiV1RuntimeAdapters.js`) ; ce
  dernier reçoit aussi une correction minimale et additive d'une fonction
  déjà existante, `apply(...)`, pour qu'elle ne perde plus son indicateur
  `duplicate` en aval de `advanceIfComplete(...)` (aucun autre appelant de
  `apply(...)` n'est affecté, puisque ce champ était simplement absent du
  résultat auparavant). L'intégration introduit une allowlist indépendante
  `KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS` (jamais héritée de
  `KADI_V1_CANARY_WA_IDS`) qui reste vide/non configurée partout, et un
  logger d'observabilité privacy-safe optionnel — voir
  [`KADI_CONVERSATIONAL_MULTIMODAL_V1.md`](KADI_CONVERSATIONAL_MULTIMODAL_V1.md) §5/§5bis
  pour le détail complet du câblage et des garanties de non-régression.
* Gemini Audio reste expérimental et désactivé — aucun appel Gemini
  d'aucune sorte n'est câblé pour l'audio en production.
* La release CANARY actuelle (voir section « Rollout » en tête de ce
  document) reste **entièrement inchangée** par cette fusion.
* Ne pas confondre avec l'infrastructure `kadiV1Brain*.js`
  (`KADI_V1_BRAIN_ENABLED`) déjà présente sur `main` avant cette fusion :
  cette dernière est un fait de production existant plus ancien (désactivé
  par défaut), que `KADI_CONVERSATIONAL_MULTIMODAL_V1` réutilise sans le
  remplacer.
* **Prochaine étape (hors périmètre de ce commit) :** activation d'un
  premier propriétaire de test via une mission CANARY explicite et
  distincte (configuration Render de `KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED`
  et de `KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS`), revue et
  autorisée séparément — non réalisée à ce jour.
