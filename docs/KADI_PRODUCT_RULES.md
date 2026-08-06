# Règles produit verrouillées — Kadi V1

Ces règles sont normatives : toute implémentation qui les contredit est un
bug, pas une variante acceptable. Statuts :
`VALIDATED_CANARY`, `IMPLEMENTED_NOT_DEPLOYED`, `PLANNED`, `BLOCKED`,
`DEFERRED`.

## Facture

* `document_type = FACTURE` en toute circonstance dans le parcours Flow Meta
  historique (formulaires WhatsApp structurés) — `document_type` y reste
  immuable pour un brouillon donné.
* **Exception scopée, non déployée :** sur la branche
  `feat/kadi-conversational-orchestrator-integration-v1` (voir
  [`KADI_CONVERSATIONAL_MULTIMODAL_V1.md`](KADI_CONVERSATIONAL_MULTIMODAL_V1.md)
  §5), un utilisateur éligible au parcours conversationnel peut demander de
  convertir un brouillon actif entre `FACTURE` et `DEVIS` uniquement
  (`kadiV1DocumentDomain.js`'s `changeDocumentType`, via le port dédié
  `documents.changeDocumentType(...)`) — préserve client, articles,
  quantités et prix ; aucun débit, génération, numéro de document,
  `issued_at` ni transition vers un état final ; RECU et DECHARGE restent
  strictement exclus, sans capacité de conversion, faute de forme de
  données compatible. Cette exception n'existe nulle part dans le parcours
  Flow Meta historique et n'est ni fusionnée ni active en production.
* `invoice_kind = FINAL | PROFORMA` distingue la facture définitive de la
  facture proforma. **Statut : `IMPLEMENTED_NOT_DEPLOYED`** (voir
  [`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md)).
* Aucune autre valeur n'est acceptée pour `invoice_kind` ; toute valeur
  invalide, vide ou en minuscules est rejetée de façon fermée.

## Reçu — format et parcours dédié

* `receipt_format = A4 | TICKET_80`. **Statut : `IMPLEMENTED_NOT_DEPLOYED`**
  (voir [`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md)). Aucune autre
  valeur n'est acceptée ; le choix n'est jamais déduit ou choisi
  silencieusement par défaut, l'utilisateur le choisit explicitement.
* `receipt_format` est obligatoire avant que le reçu puisse passer à
  `READY_FOR_REVIEW` ; persisté dans `document.options.receipt_format`.
* Le reçu utilise son propre Flow Meta indépendant (`RECEIPT_DETAILS`),
  jamais les écrans génériques client/article (`DOCUMENT_CLIENT`,
  `ARTICLE_FORM`, `DOCUMENT_CONTENT`) : un reçu n'a ni client au sens
  facture/devis, ni article/ligne.
* Pour le reçu au format `TICKET_80` uniquement, le logo de l'émetteur est
  affiché lorsqu'un logo privé valide existe ; un logo absent, illisible ou
  corrompu ne bloque jamais la génération du PDF et n'expose jamais de
  chemin de stockage, d'URL signée ou de clé de service.

## Décharge — champs structurés

* **Statut : `IMPLEMENTED_NOT_DEPLOYED`** pour l'écran initial corrigé (voir
  [`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md)).
* Le type de contenu remis utilise les valeurs canoniques internes
  `MONEY | GOODS | DOCUMENT | OTHER` ; les libellés visibles peuvent rester
  en français (« Argent », « Bien », « Document », « Autre »).
* Le formulaire utilise des champs structurés distincts (type, montant,
  description, quantité), jamais un champ unique ambigu du type « Montant,
  bien ou document ».
* `MONEY` exige un montant entier positif et interdit toute quantité ;
  `GOODS`/`DOCUMENT`/`OTHER` exigent une description et interdisent tout
  montant.
* L'écran initial ne collecte que les informations métier ; les actions
  (confirmer, modifier, annuler) ne sont proposées qu'une fois les
  informations enregistrées, via l'écran de vérification partagé
  (`DOCUMENT_REVIEW`), jamais avant.

## Crédits

* une page de PDF **final** livrée = un crédit ;
* l'aperçu et toute modification avant génération finale = zéro crédit ;
* une génération qui échoue = zéro crédit débité ;
* retélécharger le même PDF déjà généré = zéro crédit ;
* une nouvelle version régénérée après correction est facturée selon son
  propre nombre de pages réel, calculé après génération.

Aucun débit n'a lieu avant : génération réelle du rendu, calcul du nombre de
pages réel, présentation du coût et du solde, confirmation explicite de
l'utilisateur (voir [`../AGENTS.md`](../AGENTS.md) §3 et §16).

## Bonus de bienvenue

* exactement cinq crédits, une seule fois, uniquement pour un utilisateur
  réellement nouveau ;
* attribution atomique et idempotente (`WELCOME_CREDITS`,
  `welcome_credits_granted`, clé `welcome_credits:<wa_id>`) ;
* **aucun recalcul ni remise à zéro** des portefeuilles déjà existants ;
* l'absence du bonus ne se déduit jamais du solde courant — voir
  [`../AGENTS.md`](../AGENTS.md) §20.

## Autres règles verrouillées

* **tampon numérique abandonné définitivement pour l'ensemble du produit
  Kadi** (pas seulement Kadi V1) : aucune génération, stockage,
  application, exposition, commercialisation, tarification ni extension
  d'un tampon, en aucune circonstance, sauf demande future explicite du
  fondateur qui reviendrait sur cette décision. Le fait qu'une
  implémentation legacy pré-V1 du tampon existe encore dans le dépôt
  (`kadiStamp*.js` et fichiers associés, voir
  [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md)) ne signifie
  pas que la fonctionnalité reste supportée : c'est de la dette technique
  en attente d'une mission de nettoyage distincte et explicitement
  autorisée, jamais une justification pour la restaurer, l'étendre ou la
  documenter comme active ;
* le PDF final porte une date d'émission (`issued_at`, avec les secondes) et
  un numéro de document produits **uniquement côté serveur** ; l'utilisateur
  ne choisit jamais la date ;
* aucun brouillon (`DRAFT`) ne peut être exposé ou livré comme document
  final ;
* un QR code / page de vérification est prévu pour l'authentification du
  document final. **Statut : `PLANNED`**, non implémenté ;
* le propriétaire (`owner_wa_id` → profil émetteur) est obligatoire pour
  créer un document ; le nom commercial est facultatif ;
* toute donnée métier confirmée est persistée dans le document réel
  (`kadi_v1_documents` / structure équivalente), jamais seulement conservée
  dans la session WhatsApp temporaire (voir
  [`KADI_ARCHITECTURE.md`](KADI_ARCHITECTURE.md)).

## Ce qui n'est pas implémenté et ne doit pas être présenté comme tel

* conversion proforma → facture définitive ;
* nouvelle numérotation liée à cette conversion ;
* date de finalisation distincte de `issued_at` ;
* QR / page de vérification ;
* débit de crédit lié spécifiquement au choix `invoice_kind` (le choix
  lui-même ne débite jamais) ;
* facturation électronique certifiée ;
* support utilisateur automatisé, vocal sortant en production, OCR photo.

Tous ces éléments sont `PLANNED` ou `DEFERRED` — voir
[`KADI_ROADMAP.md`](KADI_ROADMAP.md).
