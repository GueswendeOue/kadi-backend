# Kadi — Machine d'états persistante des documents

## Statut de cette spécification

Les noms ci-dessous sont les noms définitifs recommandés pour la future implémentation. Ils restent une proposition documentaire tant qu'un schéma et un plan de migration n'ont pas été approuvés.

## États recommandés

| État | Sens persistant | Entrée autorisée | Sortie normale |
|---|---|---|---|
| `COLLECTING` | collecte commencée et cohérente à ce stade | création ou reprise | `INCOMPLETE` ou `READY_FOR_REVIEW` |
| `INCOMPLETE` | au moins une information nécessaire manque | validation de collecte | `COLLECTING` ou `READY_FOR_REVIEW` |
| `READY_FOR_REVIEW` | données minimales cohérentes | collecte terminée | `VERIFIED` ou correction |
| `VERIFIED` | utilisateur a confirmé la version courante | confirmation de revue | `PREVIEW_READY` |
| `PREVIEW_READY` | aperçu structuré calculé pour une version | construction d'aperçu | `COST_CALCULATED` ou correction |
| `COST_CALCULATED` | rendu temporaire, pages et coût exact existent | préparation PDF | `AWAITING_GENERATION_CONFIRMATION` |
| `AWAITING_GENERATION_CONFIRMATION` | coût affichable, aucun débit | devis de génération valide | `GENERATION_IN_PROGRESS`, `RECHARGE_REQUIRED` ou sauvegarde |
| `RECHARGE_REQUIRED` | solde insuffisant, brouillon et devis conservés | contrôle du solde | retour à confirmation ou nouvel état de coût |
| `GENERATION_IN_PROGRESS` | confirmation reçue, opération sensible verrouillée | débit idempotent réussi | `GENERATED` ou `RECOVERABLE_FAILURE` |
| `GENERATED` | fichier final immuable persisté | génération réussie | `DELIVERED` ou `RECOVERABLE_FAILURE` |
| `DELIVERED` | livraison confirmée | canal de livraison réussi | état terminal fonctionnel |
| `RECOVERABLE_FAILURE` | échec technique reprenable avec contexte sûr | toute étape reprenable | dernier état sûr ou étape suivante idempotente |
| `CANCELLED` | parcours annulé sans suppression des preuves nécessaires | annulation autorisée | terminal, sauf reprise explicitement approuvée |

`SAVED` n'est pas recommandé comme état principal : « enregistré pour plus tard » est mieux représenté par un attribut de pause (`paused_at`) conservant l'état métier réel. Alternative : garder un état `SAVED` si le produit exige une catégorie d'historique explicite.

## Invariants d'état

* Un seul état courant fait autorité par document.
* Toute transition vérifie propriétaire et version attendue.
* Une modification métier incrémente `version` et invalide aperçu, rendu et coût dérivés.
* Aucun état antérieur à `GENERATION_IN_PROGRESS` ne peut porter un débit confirmé pour cette génération.
* `GENERATED` référence une version figée et un fichier immuable.
* `DELIVERED` n'autorise pas la mutation du fichier final.
* `CANCELLED` conserve les traces nécessaires et ne signifie pas suppression.

## Transitions

| De → vers | Événement | Préconditions | Données modifiées | Idempotence et reprise | Interdit |
|---|---|---|---|---|---|
| création → `COLLECTING` | intention document confirmée | propriétaire autorisé, type supporté | identifiant, type, version initiale | clé de création retourne le même brouillon | créer plusieurs brouillons pour le même événement |
| `COLLECTING` → `INCOMPLETE` | validation détecte un manque | contrat du type connu | liste des manques | même validation, même résultat | effacer les champs déjà valides |
| `INCOMPLETE` → `COLLECTING` | information reçue | session et version valides | champ confirmé, version | clé de complétion absorbe le retry | accepter un champ d'un autre propriétaire |
| collecte → `READY_FOR_REVIEW` | minimum métier satisfait | calculs serveur cohérents | totaux, manques vides, version | recalcul déterministe | contourner une obligation conditionnelle |
| `READY_FOR_REVIEW` → collecte | correction demandée | cible de correction autorisée | état et contexte de reprise | aucun append lors d'une correction | cibler une ligne par index client |
| `READY_FOR_REVIEW` → `VERIFIED` | confirmation utilisateur | version affichée inchangée | preuve de confirmation | clé de confirmation unique | confirmer une version obsolète |
| `VERIFIED` → `PREVIEW_READY` | aperçu construit | version vérifiée, propriété valide | projection et empreinte de version | reconstruction déterministe | utiliser des données non sauvegardées |
| `PREVIEW_READY` → collecte | modification demandée | document modifiable | invalidation aperçu/rendu/coût, version | correction idempotente | conserver un ancien coût actif |
| `PREVIEW_READY` → `COST_CALCULATED` | préparer le PDF | aperçu courant | rendu temporaire, pages, règle et coût | clé de rendu par version | livrer ou débiter |
| `COST_CALCULATED` → `AWAITING_GENERATION_CONFIRMATION` | coût présenté | rendu et coût valides | horodatage/expiration du devis | présentation rejouable sans débit | confirmer silencieusement |
| confirmation → `RECHARGE_REQUIRED` | solde insuffisant | coût valide, solde relu | référence de reprise, aucun débit | contrôle répété sans écriture wallet | débit partiel ou génération |
| `RECHARGE_REQUIRED` → confirmation | paiement confirmé | webhook authentique, crédit idempotent, version inchangée | crédit unique et statut paiement | clé fournisseur empêche double crédit | faire confiance au retour client seul |
| confirmation → `GENERATION_IN_PROGRESS` | confirmation explicite | version et coût valides, solde suffisant | verrou, débit unique, instantané immuable | même clé reprend l'opération | nouveau débit sur retry |
| `GENERATION_IN_PROGRESS` → `GENERATED` | fichier final produit | débit confirmé ou politique transactionnelle approuvée | fichier, empreinte, numéro, `issued_at` | reprendre avec la même clé | changer l'instantané source |
| `GENERATED` → `DELIVERED` | livraison confirmée | fichier autorisé et canal valide | état et preuve de livraison | relivrer sans redébiter | recréer le document à chaque tentative |
| étape active → `RECOVERABLE_FAILURE` | erreur technique reprenable | contexte de reprise assaini | étape échouée, code sûr, tentative | retour au dernier état sûr | perdre le brouillon ou exposer le détail interne |
| `RECOVERABLE_FAILURE` → étape sûre | retry autorisé | cause résolue, clés intactes | compteur de tentative et état | réutiliser les clés existantes | recommencer débit/crédit aveuglément |
| état non final → `CANCELLED` | annulation explicite | droits et règle du type | motif éventuel, date serveur | événement unique | supprimer les preuves ou annuler un débit sans procédure |

## Transitions interdites globales

* `COLLECTING`, `INCOMPLETE` ou `READY_FOR_REVIEW` directement vers génération ou livraison.
* Débit depuis `DRAFT`, `PREVIEW_READY` ou avant confirmation explicite.
* `DELIVERED` vers un état éditable en modifiant le même fichier final.
* Réutilisation d'un devis de génération après changement de version.
* Passage à `GENERATED` sans rattachement à une version immuable.
* Crédit sur simple retour du Flow Recharge sans webhook de paiement vérifié.

## Brouillon, vérification, aperçu et fichiers

| Concept | Nature | Livrable | Débit | Invalidation |
|---|---|---|---|---|
| Brouillon | agrégat métier mutable et versionné | non | non | évolue par nouvelle version |
| Vérification | confirmation humaine de la version | non | non | toute modification |
| Aperçu structuré | projection lisible des données vérifiées | visible dans l'interface, pas fichier final | non | toute modification |
| Rendu temporaire | artefact technique non livré pour compter les pages | jamais livré | non | modification, expiration ou règle tarifaire changée |
| PDF final | artefact persistant d'une version figée | oui | seulement après confirmation et débit réussi | immuable ; correction par nouvelle version/document |

## Recharge et reprise

1. Relire le solde avant débit.
2. Si insuffisant, conserver brouillon, version, rendu et devis valides, puis passer à `RECHARGE_REQUIRED`.
3. Créer une tentative de paiement avec une clé idempotente et une référence de reprise.
4. Ne créditer qu'après webhook authentique et vérifié.
5. Dédupliquer le crédit par identifiant fournisseur et clé métier.
6. Relire document, version, coût et solde.
7. Si la version a changé ou le devis a expiré, invalider rendu/coût et recalculer.
8. Sinon revenir à `AWAITING_GENERATION_CONFIRMATION` ; la recharge ne vaut jamais confirmation de génération.
9. La confirmation suivante utilise une clé de débit distincte de la clé de recharge.

Cette séparation empêche doubles crédits, doubles débits et doubles générations.

## Échecs récupérables

Un échec conserve : dernier état sûr, version, étape, clé idempotente applicable, nombre de tentatives et code assaini. Il ne conserve pas de secret ni de payload complet. La reprise réexécute uniquement l'étape inachevée : un débit réussi n'est jamais rejoué, un fichier généré n'est pas recréé pour une simple relivraison.

## Décisions à arbitrer

| Question | Recommandation | Alternatives |
|---|---|---|
| Pause utilisateur | attribut `paused_at` sans changer l'état métier | état `SAVED` dédié |
| Numéro du document | attribuer lors de la finalisation, avant fichier final | réserver à l'aperçu ; numéro provisoire distinct |
| Date d'un devis | `issued_at` serveur et validité séparée | date de création comme début de validité |
| Annulation après génération | nouvel événement/état avec document final immuable | document correctif ou remplacement explicite |
| Durée d'un devis de coût | expiration courte configurable | valable tant que version et tarifs inchangés |
| Conservation du rendu | durée courte configurable puis purge | conservation jusqu'à génération ; archive d'audit |
| Atomicité débit/génération | saga idempotente avec compensation définie | réservation de crédits puis capture |
| Livraison multiple | même document, tentatives séparées | limiter les relivraisons selon politique |
| Historique | conserver tous les statuts utiles avec pagination | profondeur fixe ou archivage séparé |
| Édition post-génération | nouvelle version ou document correctif | duplication comme nouveau document |

Ces recommandations exigent validation produit, financière et technique avant implémentation.
