# État courant de Kadi V1

**Mise à jour :** 2026-08-05
**Base vérifiée :** `main` au commit `caf876e` (merge « add Kadi permanent
agent context »).

Ce document reflète l'état réel observé dans le dépôt et ses tests à la date
ci-dessus. En cas de doute, le code et les tests font foi ; ce fichier doit
être corrigé s'il diverge de l'inspection réelle.

Statuts utilisés : `VALIDATED_CANARY`, `IMPLEMENTED_NOT_DEPLOYED`,
`PLANNED`, `BLOCKED`, `DEFERRED`.

## Rollout

* Mode de rollout : **CANARY** exclusivement.
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

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`.**
* Le code est fusionné dans `main` (commit de merge `1fb1329`), avec 862
  tests locaux au vert au moment du merge.
* Étape ajoutée : entre `DOCUMENT_TYPE` (choix FACTURE) et
  `DOCUMENT_CLIENT`, un nouvel écran `INVOICE_TYPE` impose le choix
  `invoice_kind = FINAL | PROFORMA`. `document_type` reste toujours
  `FACTURE`.
* Migration Supabase **écrite mais non confirmée appliquée en distant** :
  `supabase/migrations/20260805030000_add_kadi_v1_invoice_type_flow_key.sql`
  (ajoute `INVOICE_TYPE` à la même contrainte, 17 valeurs au total).
* Flow Meta prévu : **`KADI_INVOICE_TYPE_V1`** — **non publié**.
* Variable Render prévue : **`KADI_V1_FLOW_INVOICE_TYPE_ID`** — **non
  confirmée configurée en production**.
* Tant que ces trois étapes (migration distante, publication Meta, variable
  Render) ne sont pas confirmées, `INVOICE_TYPE` ne doit pas être présenté
  comme actif pour un utilisateur CANARY réel.

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

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`.**
* Corrige un bug confirmé : le reçu passait auparavant par les écrans
  génériques `DOCUMENT_CLIENT` puis `ARTICLE_FORM`/`DOCUMENT_CONTENT`, qui
  collectaient des champs inadaptés (nom/téléphone/e-mail au lieu de
  payeur/bénéficiaire/montant/motif) et autorisaient des articles, alors que
  RECU les interdit explicitement. L'utilisateur recevait ensuite une erreur
  générique.
* Nouveau Flow Meta indépendant mono-écran prévu : **`KADI_RECEIPT_DETAILS_V1`**
  — **non publié**.
* Variable Render prévue : **`KADI_V1_FLOW_RECEIPT_DETAILS_ID`** — **non
  confirmée configurée en production**.
* Champ nouveau `receipt_format` (`A4` ou `TICKET_80`), obligatoire avant
  `READY_FOR_REVIEW`, persisté dans `document.options.receipt_format`.
* Migration Supabase écrite mais non confirmée appliquée en distant :
  `supabase/migrations/20260805040000_add_kadi_v1_receipt_details_flow_key.sql`.
* Le format persistant est propagé jusqu'au rendu PDF réel
  (`A4` → moteur A4, `TICKET_80` → moteur compact), sans repli silencieux
  vers A4 en cas de valeur absente ou invalide.
* Le reçu compact (`TICKET_80`) peut désormais afficher le logo de
  l'émetteur lorsqu'un logo privé valide existe ; un logo manquant,
  illisible ou corrompu ne bloque jamais la génération du PDF.

### DECHARGE — écran initial corrigé

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`.**
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

1. documentation (cette mission) ;
2. publication du Flow `KADI_INVOICE_TYPE_V1` sur Meta ;
3. configuration de `KADI_V1_FLOW_INVOICE_TYPE_ID` sur Render ;
4. application de la migration
   `20260805030000_add_kadi_v1_invoice_type_flow_key.sql` sur Supabase
   distant ;
5. déploiement Render du service `kadi-backend` ;
6. nouveau parcours de test en CANARY (jamais de reprise d'un ancien Flow
   ouvert avant publication — voir
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md) fiche F).

La même séquence, et la même mise en garde, s'appliquent à `RECEIPT_DETAILS`
avant toute validation CANARY : publication du Flow
`KADI_RECEIPT_DETAILS_V1`, variable `KADI_V1_FLOW_RECEIPT_DETAILS_ID`,
application de la migration `20260805040000_add_kadi_v1_receipt_details_flow_key.sql`,
déploiement, puis **un nouveau parcours WhatsApp démarré après la
publication** — une session déjà ouverte avant la publication du Flow
continue de représenter l'ancienne version et ne doit jamais servir à
valider ce correctif.

## Prochaine étape produit après validation d'INVOICE_TYPE

* **Statut : `PLANNED`.** Reçu au format A4 et reçu au format ticket 80 mm
  (`receipt_format = A4 | TICKET_80`, voir
  [`KADI_PRODUCT_RULES.md`](KADI_PRODUCT_RULES.md)).
