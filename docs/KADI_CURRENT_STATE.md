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
