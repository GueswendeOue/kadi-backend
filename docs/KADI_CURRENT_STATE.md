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

## DÉVELOPPEMENT / NON FUSIONNÉ / NON DÉPLOYÉ — `KADI_CONVERSATIONAL_MULTIMODAL_V1`

**Ceci n'est pas de la production actuelle.** Section séparée à dessein —
voir [`KADI_CONVERSATIONAL_MULTIMODAL_V1.md`](KADI_CONVERSATIONAL_MULTIMODAL_V1.md)
pour le détail complet.

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`**, et plus précisément **non
  fusionné** : le code existe uniquement sur la branche
  `feat/kadi-conversational-multimodal-v1`, jamais sur `main`.
* Nouveaux fichiers : `kadiV1ConversationalMultimodalContracts.js`,
  `kadiV1ConversationalMultimodalPolicy.js`, `kadiV1GeminiAudioProvider.js`.
* Nouveaux flags, tous `false` par défaut et indépendants :
  `KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED`, `KADI_GEMINI_AUDIO_V1_ENABLED`.
* **Non câblé** dans `kadiV1ConversationOrchestrator.js` ni dans
  `kadiV1ProductionBootstrap.js` — aucun trafic, CANARY ou autre, ne passe
  par ce code.
* La release CANARY actuelle (voir section « Rollout » en tête de ce
  document) est donc **entièrement indépendante** de cette branche.
* Ne pas confondre avec l'infrastructure `kadiV1Brain*.js`
  (`KADI_V1_BRAIN_ENABLED`) déjà présente sur `main` avant cette branche :
  cette dernière est un fait de production existante (désactivée par
  défaut), tandis que `KADI_CONVERSATIONAL_MULTIMODAL_V1` est une couche
  additive qui la réutilise, elle, pas encore fusionnée.
