# Règles produit verrouillées — Kadi V1

Ces règles sont normatives : toute implémentation qui les contredit est un
bug, pas une variante acceptable. Statuts :
`VALIDATED_CANARY`, `IMPLEMENTED_NOT_DEPLOYED`, `PLANNED`, `BLOCKED`,
`DEFERRED`.

## Facture

* `document_type = FACTURE` en toute circonstance.
* `invoice_kind = FINAL | PROFORMA` distingue la facture définitive de la
  facture proforma. **Statut : `IMPLEMENTED_NOT_DEPLOYED`** (voir
  [`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md)).
* Aucune autre valeur n'est acceptée pour `invoice_kind` ; toute valeur
  invalide, vide ou en minuscules est rejetée de façon fermée.

## Reçu — formats prévus

* `receipt_format = A4 | TICKET_80`. **Statut : `PLANNED`**, prochaine étape
  produit après la validation d'INVOICE_TYPE (voir
  [`KADI_ROADMAP.md`](KADI_ROADMAP.md)). Ne pas présenter ce champ comme
  disponible tant qu'il n'apparaît pas dans le code et les tests.

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

* **tampon numérique désactivé** : aucune génération, stockage, application
  ni coût lié à un tampon, en aucune circonstance ;
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
* reçu A4 / reçu ticket 80 mm ;
* support utilisateur automatisé, vocal sortant en production, OCR photo.

Tous ces éléments sont `PLANNED` ou `DEFERRED` — voir
[`KADI_ROADMAP.md`](KADI_ROADMAP.md).
