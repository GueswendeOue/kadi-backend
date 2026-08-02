# Kadi — Modèle métier canonique des documents

## Statut de cette spécification

Ce document décrit le contrat métier cible. Il ne constitue ni un schéma SQL ni une migration. Les types et cardinalités indiquent l'intention produit ; toute décision encore ouverte est signalée explicitement.

## Agrégat commun : facture, devis et reçu

`FACTURE`, `DEVIS` et `RECU` partagent un agrégat `Document`. Le serveur en reste la source de vérité et contrôle propriété, versions, calculs, identifiants et opérations sensibles.

| Champ | Contrat commun | Autorité | Obligatoire |
|---|---|---|---|
| `document_id` | identifiant stable et opaque | serveur | toujours après création du brouillon |
| `document_type` | `FACTURE`, `DEVIS` ou `RECU` | intention validée puis serveur | toujours |
| `status` | état persistant défini par la machine d'états | serveur | toujours |
| `issuer_profile_id` | référence au profil émetteur autorisé | serveur | toujours pour générer |
| `client` | partie destinataire structurée | utilisateur, extraction et validation serveur | selon le type et la règle validée |
| `items` | lignes identifiées par `item_id` serveur | utilisateur, extraction et serveur | cardinalité selon le type |
| `options` | options normalisées propres au type | utilisateur et configuration | facultatif ou conditionnel |
| `subtotal` | somme recalculée des lignes sauvegardées | serveur | pour les documents à lignes |
| `taxes` | détail et total des taxes applicables | serveur depuis options et configuration | conditionnel |
| `discount` | remise structurée, avec mode et valeur | serveur depuis l'entrée validée | facultatif |
| `total` | total final calculé, jamais accepté tel quel du client | serveur | avant vérification finale |
| `notes` | texte libre borné et assaini | utilisateur | facultatif |
| `payment_terms` | conditions ou statut de paiement | utilisateur et règles du type | conditionnel |
| `issued_at` | horodatage serveur avec secondes | serveur uniquement | uniquement quand l'étape métier l'exige |
| `document_number` | numéro attribué selon une politique approuvée | serveur uniquement | avant ou pendant finalisation selon arbitrage |
| `currency` | devise ISO ou valeur métier configurée | configuration et serveur | toujours pour les montants |
| `preview` | projection structurée de la version courante | serveur | à partir de `PREVIEW_READY` |
| `generation_cost` | pages, règle tarifaire, coût, devise et version | serveur | après rendu temporaire |
| `generated_file` | métadonnées et référence du fichier final immuable | serveur | après génération réussie |
| `version` | entier monotone modifié à chaque changement métier | serveur | toujours |
| clés d'idempotence | clés distinctes par complétion, rendu, débit, génération, recharge et livraison | serveur | pour toute opération rejouable ou sensible |

Les données calculées portent la version du document dont elles dérivent. Modifier le document invalide `preview`, rendu temporaire et `generation_cost` antérieurs sans effacer l'historique d'audit nécessaire.

## Structures communes recommandées

### Client

Le client contient uniquement les attributs nécessaires au type de document : nom ou raison sociale, contacts utiles, adresse si requise et identifiants légaux si applicables. Les règles d'obligation restent spécifiques au type et au contexte réglementaire.

### Ligne

Une ligne comprend au minimum un `item_id` serveur, une désignation, une quantité, une unité éventuelle, un prix unitaire et un montant calculé. Taxes, remise ou métadonnées de service peuvent être portées par ligne si une spécification ultérieure le valide.

`items.length` est la seule source du nombre d'articles. Le sous-total est toujours recalculé depuis les lignes sauvegardées. Une correction cible le `item_id`, jamais un index présenté par le client.

### Aperçu, coût et fichier

* `preview` représente les données structurées prêtes à afficher, pas un PDF.
* `generation_cost` référence la version, le rendu temporaire, les pages réelles et la règle tarifaire.
* `generated_file` référence un artefact final immuable, sa version source, son empreinte, son format et son état de livraison.

## Différences métier

| Dimension | FACTURE | DEVIS | RECU |
|---|---|---|---|
| Finalité | demander ou constater une créance selon le contexte | proposer une offre non encore facturée | attester un paiement reçu |
| Client | généralement requis | généralement requis | payeur ou bénéficiaire requis selon usage |
| Lignes | attendues dans le modèle standard | attendues dans le modèle standard | peuvent être remplacées par un objet et un montant si validé |
| Conditions | conditions de paiement possibles | durée de validité et conditions d'acceptation possibles | moyen, date et référence du paiement potentiellement requis |
| `issued_at` | date d'émission du document final | date d'émission de l'offre | date d'attestation serveur ; la date réelle du paiement peut être distincte |
| Total | somme à payer ou due | montant proposé | montant effectivement reçu |
| Cycle ultérieur | paiement, avoir ou suivi à spécifier | acceptation, expiration ou conversion à spécifier | correction ou annulation strictement contrôlée |

Ces différences sont des orientations, pas une décision implicite sur les champs légalement obligatoires. Les règles de numérotation, validité, conversion, fiscalité et annulation restent à approuver.

## Modèle distinct : décharge

La décharge utilise un agrégat `DischargeDocument`, car elle atteste une remise et ne doit pas être forcée dans un panier d'articles.

| Champ | Contrat |
|---|---|
| `document_id`, `status`, `issuer_profile_id`, `version` | mêmes garanties serveur que l'agrégat commun |
| `giver` | personne ou organisation qui remet |
| `receiver` | personne ou organisation qui reçoit |
| `subject` | union explicite : montant, bien ou document remis |
| `quantity` | quantité facultative, cohérente avec le type de sujet |
| `reason` | motif de la remise |
| `conditions` | conditions ou observations facultatives |
| `issued_at` | horodatage serveur avec secondes |
| `attestations` | emplacements futurs pour signatures ou attestations, sans fonctionnalité présumée |
| `preview`, `generation_cost`, `generated_file` | mêmes étapes techniques, avec présentation propre à la décharge |
| clés d'idempotence | mêmes protections pour complétion, débit, génération et livraison |

### Composants partageables

Propriété, version, historique, aperçu, rendu temporaire, comptage des pages, coût, confirmation, débit idempotent, génération finale, livraison et recharge peuvent partager les mêmes services contractuels.

### Composants spécifiques

Les parties remettante et destinataire, la nature de ce qui est remis, le motif, les conditions, les attestations et le gabarit final restent propres à la décharge. Ils ne doivent pas être traduits artificiellement en `client`, `items` ou `payment_terms`.

## Invariants transverses

* Aucun tampon généré, stocké, appliqué ou facturé.
* Aucun débit ni PDF final en mode `DRAFT`.
* Aucun débit avant pages réelles, coût affiché et confirmation explicite.
* `issued_at`, `document_id`, `document_number`, totaux et versions sont sous autorité serveur.
* Un document final référence une version immuable du document.
* Les données d'un propriétaire ne sont jamais accessibles à un autre.
* Les opérations sensibles sont idempotentes et auditables sans exposer de secret ni donnée personnelle.

## Décisions produit à arbitrer

| Sujet | Recommandation | Alternatives à évaluer |
|---|---|---|
| Numérotation | séquence distincte par type, émetteur et période, attribuée à la finalisation | numéro dès brouillon ; séquence commune |
| Validité du devis | durée configurable avec défaut central | date explicite obligatoire ; aucune expiration automatique |
| Reçu minimal | payeur, montant, motif, moyen et référence si disponible | modèle à lignes obligatoire ; montant seul |
| Décharge minimale | remettant, receveur, sujet et motif | motif facultatif ; quantité toujours exigée |
| Coût | prix basé sur pages réelles, règles centrales | suppléments approuvés pour options précises |
| Rendus temporaires | conservation courte avec expiration et empreinte | suppression immédiate ; conservation d'audit prolongée |
| Versions | entier monotone avec instantané final immuable | journal événementiel complet ; copies de versions |
| Annulation | état conservé, non destructif, avec motif | suppression logique ; archivage séparé |
| Historique | profondeur configurable et recherche paginée | fenêtre fixe ; archivage payant à définir |
| Modification après génération | nouvelle version ou document correctif, jamais mutation du fichier final | duplication contrôlée ; annulation puis recréation |

Aucune recommandation de ce tableau ne devient une règle métier sans validation produit explicite.
