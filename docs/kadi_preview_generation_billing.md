# Kadi — Aperçu, génération et facturation

## Portée

Ce document définit la chaîne canonique entre un brouillon vérifié et la livraison d'un document final. Il s'applique aux documents partageant ce pipeline ; les différences métier restent portées par `document_type`.

## 1. Brouillon

Le brouillon est la source de vérité serveur pendant la collecte et les corrections. Il conserve propriétaire, type de document, parties, articles ou objet, options et état. Il ne déclenche ni débit ni PDF final.

Invariants :

* `issued_at` n'est pas choisi par l'utilisateur ; il est créé côté serveur avec les secondes ;
* le sous-total est recalculé depuis les articles sauvegardés ;
* le compteur est `items.length` ;
* les corrections d'article utilisent le `item_id` serveur ;
* toute complétion et opération sensible est idempotente ;
* aucune fonctionnalité de tampon n'existe.

## 2. Aperçu structuré

Après vérification, l'aperçu présente :

* type du document et numéro prévu ;
* émetteur ;
* client ou bénéficiaire ;
* articles ou objet, quantités et prix ;
* taxes, remise et notes ;
* sous-total et total ;
* date automatique.

Actions autorisées : « Modifier les informations », « Préparer le PDF » et « Enregistrer pour plus tard ». L'ouverture et la validation de l'aperçu ne débitent rien.

## 3. Rendu temporaire

« Préparer le PDF » crée un rendu temporaire non livré. Ce rendu doit utiliser le même moteur de mise en page que la génération finale afin que le nombre de pages soit fiable. Il ne devient pas un document final et ne doit pas être envoyé à l'utilisateur comme tel.

Le service enregistre une empreinte de la version du brouillon utilisée. Toute correction ultérieure invalide le devis de génération précédent.

## 4. Pages et coût exact

Le coût dépend du nombre réel de pages du rendu temporaire, jamais d'une estimation basée sur le nombre d'articles. La configuration centrale fournit les règles tarifaires et les packs ; aucun tarif ne doit être dupliqué dans les Flows.

Le résultat de calcul comprend au minimum : nombre de pages, coût exact, solde actuel, identifiant idempotent et version du brouillon.

## 5. Confirmation

Kadi affiche clairement le nombre de pages, le coût et le solde, puis demande une confirmation explicite. Aucun débit n'a lieu avant cette réponse.

Si l'utilisateur refuse ou enregistre pour plus tard, le brouillon reste disponible et aucun document final n'est créé.

## 6. Débit et génération finale

Après confirmation seulement :

1. verrouiller l'opération avec une clé idempotente stable ;
2. vérifier que le brouillon et le devis n'ont pas changé ;
3. vérifier une dernière fois le solde ;
4. débiter exactement une fois ;
5. persister le document final avec son `issued_at` serveur ;
6. produire ou promouvoir le PDF final ;
7. livrer le document ;
8. marquer l'opération terminée.

Un retry avec la même clé retourne le résultat existant sans second débit ni second document.

## 7. Solde insuffisant et recharge

Si le solde est insuffisant :

* ne rien débiter ;
* conserver le brouillon et le devis ;
* ouvrir la recharge avec les packs issus de la configuration centrale ;
* créditer uniquement après confirmation vérifiée du paiement ;
* revenir à la confirmation avec le coût inchangé si le brouillon n'a pas changé.

Une recharge en attente ou refusée ne modifie ni le brouillon ni le wallet.

## 8. Échecs et reprise

| Échec | Comportement sûr | Reprise |
|---|---|---|
| rendu temporaire impossible | aucun débit, brouillon conservé | réessayer la préparation |
| calcul des pages impossible | aucun coût annoncé, aucun débit | recalculer depuis un nouveau rendu |
| brouillon modifié après devis | invalider coût et confirmation | refaire rendu, pages et coût |
| solde insuffisant | aucun débit | recharge puis nouvelle confirmation |
| paiement non confirmé | aucun crédit ajouté | attendre ou relancer la vérification autorisée |
| débit réussi, génération interrompue | ne pas redébiter | reprendre avec la même clé idempotente |
| livraison échouée | conserver le document final | relivrer sans nouveau débit |
| requête dupliquée | retourner l'état existant | aucune opération supplémentaire |

Les messages restent humains et indiquent une seule prochaine action sans exposer de statut interne.

## 9. Traçabilité et sécurité

Journaliser uniquement des identifiants masqués, étapes, résultats et codes non sensibles. Ne jamais journaliser clés, tokens, données personnelles, payloads complets ou configuration HTTP. Les contrôles de propriété s'appliquent à chaque lecture, correction, rendu, débit, génération et livraison.

## 10. Critères de validation

Avant mise en production :

* aperçu exact sur plusieurs tailles d'écran ;
* pages identiques entre rendu temporaire et final ;
* coût conforme à la configuration ;
* zéro débit avant confirmation ;
* débit unique sous retries et concurrence ;
* reprise après chaque échec ;
* recharge vérifiée ;
* absence de PDF final et de débit en `DRAFT` ;
* historique accessible uniquement au propriétaire.
