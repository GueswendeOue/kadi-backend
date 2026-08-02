# Kadi — Architecture canonique des Meta Flows

## Principe d'ensemble

Les Meta Flows sont des surfaces de vérification au sein d'une conversation continue. L'utilisateur ne doit jamais percevoir un changement de système entre deux Flows. Le backend conserve l'état métier, la propriété, l'idempotence et l'orchestration ; chaque Flow présente seulement l'étape utile.

Les sept Flows facture mono-écran actuels constituent la base technique fonctionnelle. Ils ne doivent pas être remplacés avant l'approbation d'une spécification de refonte.

## Carte cible

```text
Conversation naturelle (texte, vocal, photo)
  -> ONBOARDING si nécessaire
  -> intention comprise ou MENU raccourci
  -> collecte partagée du document
       DOCUMENT CLIENT
       DOCUMENT ITEMS
       DOCUMENT OPTIONS
       DOCUMENT REVIEW
       EDIT CLIENT / EDIT ITEMS / EDIT OPTIONS
  -> DOCUMENT PREVIEW
       -> Enregistrer pour plus tard
       -> Modifier les informations
       -> Préparer le PDF
            -> rendu temporaire + pages + coût
            -> GENERATION CONFIRMATION
                 -> solde suffisant : débit idempotent + document final
                 -> solde insuffisant : RECHARGE -> retour à la confirmation
  -> HISTORY / SEARCH pour retrouver ou reprendre

Décharge
  -> collecte et vérification propres au modèle de décharge
  -> DOCUMENT PREVIEW
  -> même gate de génération et de facturation lorsque applicable
```

## Flows partagés

Facture, devis et reçu utilisent autant que possible les mêmes familles, pilotées par `document_type` :

| Famille | Entrée | Responsabilité | Sorties |
|---|---|---|---|
| ONBOARDING | nouvel utilisateur ou profil incomplet | demander progressivement le minimum nécessaire | conversation, MENU ou document |
| MENU | demande explicite de raccourci | proposer document, historique, solde ou aide | famille choisie |
| DOCUMENT CLIENT | document et données extraites | vérifier émetteur, client ou bénéficiaire | ITEMS ou REVIEW |
| DOCUMENT ITEMS | client validé | vérifier les lignes, quantités et prix | ITEMS, OPTIONS ou REVIEW |
| DOCUMENT OPTIONS | données principales | vérifier taxes, remise, paiement et notes | REVIEW |
| DOCUMENT REVIEW | brouillon cohérent | synthétiser et orienter les corrections | EDIT, PREVIEW ou sauvegarde |
| EDIT CLIENT | demande de correction | modifier uniquement les parties concernées | REVIEW |
| EDIT ITEMS | demande de correction | corriger par `item_id` serveur | REVIEW |
| EDIT OPTIONS | demande de correction | modifier les options sans perdre le reste | REVIEW |
| DOCUMENT PREVIEW | brouillon vérifié | afficher la représentation structurée complète | EDIT, sauvegarde ou préparation PDF |
| GENERATION CONFIRMATION | pages et coût connus | afficher coût, solde et demander confirmation | génération finale ou RECHARGE |
| RECHARGE | solde insuffisant ou demande de solde | proposer les packs configurés et vérifier le paiement | confirmation précédente ou solde |
| HISTORY / SEARCH | recherche naturelle ou menu | retrouver, consulter ou reprendre un document autorisé | aperçu, reprise ou conversation |

## Flows spécifiques à la décharge

La décharge ne doit pas être forcée dans un modèle d'articles. Ses Flows propres gèrent notamment les parties, l'objet ou montant, la déclaration, les conditions et les signatures nécessaires. Elle rejoint l'aperçu et la génération communs uniquement lorsque leurs contrats correspondent réellement.

## États métier

États conceptuels recommandés :

* `COLLECTING` : informations en cours de collecte ;
* `NEEDS_INPUT` : une donnée précise manque ;
* `REVIEW_READY` : données cohérentes à vérifier ;
* `PREVIEW_READY` : aperçu complet disponible ;
* `RENDER_QUOTED` : rendu temporaire, pages et coût calculés ;
* `AWAITING_CONFIRMATION` : coût présenté, aucun débit ;
* `PAYMENT_REQUIRED` : solde insuffisant, brouillon conservé ;
* `FINALIZING` : opération idempotente en cours ;
* `COMPLETED` : document final persisté et livré ;
* `SAVED` : brouillon conservé pour plus tard.

Les noms d'états sont internes et ne doivent jamais apparaître dans les messages utilisateur.

## Transitions et invariants

* Toute transition transporte un identifiant pseudonyme et résout les données côté serveur.
* Le backend vérifie propriété, activité, expiration et révocation avant de charger un brouillon.
* Une correction modifie le brouillon existant puis ouvre une nouvelle vérification.
* `items.length` est la seule source du compteur ; le sous-total est recalculé depuis les lignes sauvegardées.
* Les écrans d'article suivants s'ouvrent avec des champs frais.
* Une complétion reconnue est absorbée avant MENU et OpenAI et produit au plus une réponse.
* Aucun débit ni PDF final n'est produit par un Flow en mode `DRAFT`.

## Frontières invisibles

Les titres, cartes et boutons utilisent le vocabulaire du document, jamais celui de l'infrastructure. Entre deux Flows, le message d'accompagnement doit exprimer une progression humaine : « Vérifions les articles » ou « Voici votre aperçu », jamais « nouvelle session » ou « écran suivant ».

## Release gate

Avant publication, valider ensemble : conversation d'entrée, cartes, titres, boutons, transitions, texte/vocal/photo, questions manquantes, corrections, aperçu, calcul des pages et du coût, recharge, génération, historique, absence de débit en `DRAFT` et rendu mobile sur plusieurs tailles d'écran.
