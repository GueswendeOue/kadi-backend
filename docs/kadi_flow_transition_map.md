# Kadi — Carte canonique des transitions V1

## Principe

La transition visible est une progression de la conversation, jamais un changement de logiciel. Chaque nouvelle surface reprend le contexte utile avec un texte humain. Les identifiants, états et frontières de Flows restent internes.

## Parcours nominal

```text
CONVERSATION
  -> CLIENT OU BÉNÉFICIAIRE
  -> CONTENU
  -> AUTRES DÉTAILS
  -> VÉRIFICATION
  -> APERÇU
  -> RENDU TEMPORAIRE
  -> COÛT
  -> CONFIRMATION
  -> GÉNÉRATION
  -> LIVRAISON
  -> HISTORIQUE
```

Le menu peut rejoindre CONVERSATION, HISTORIQUE, SOLDE ou AIDE. Il ne devient jamais un passage obligatoire après une intention déjà comprise.

## Premier accueil et reprise d'onboarding

```text
NOUVEL UTILISATEUR
  -> USER_PROFILE_CREATED
  -> WELCOME_CREDITS_GRANTED (5 crédits, clé welcome_credits:<wa_id>)
  -> WELCOME_TEXT_SENT
  -> WELCOME_VOICE_ATTEMPTED (non bloquant, clé welcome_voice:<wa_id>:v1)
  -> FLOW ONBOARDING
  -> MENU OU PREMIÈRE CRÉATION DE DOCUMENT

INTERRUPTION
  -> profil et bonus conservés
  -> ONBOARDING_RESUMED
  -> aucun nouveau bonus

RÉACTIVATION
  -> message de reprise
  -> aucun nouveau bonus
```

Le texte n'annonce les 5 crédits qu'après leur attribution confirmée par le backend. Un échec vocal n'annule ni le profil ni le bonus et n'empêche jamais l'ouverture de l'onboarding.

## Transitions principales

| De | Événement | Contrôles serveur | Vers | Texte visible de transition |
|---|---|---|---|---|
| Accueil | demande naturelle comprise | type supporté, profil minimal | Conversation document | « Commençons. Envoyez-moi les informations que vous avez déjà. » |
| Conversation | client absent | champs disponibles conservés | Client | « Ajoutons d'abord le client. » |
| Conversation | client déjà compris | valeur marquée confirmable | Client | « J'ai noté {client}. Regardez ses informations avant de continuer. » |
| Client | client enregistré | propriété, version, contrat du type | Contenu | « Client enregistré. Ajoutons maintenant les produits ou services. » |
| Contenu | contenu incomplet | aucune donnée incertaine confirmée | Contenu | question ciblée sur le seul manque prioritaire |
| Contenu | contenu terminé | sous-total recalculé | Détails | « Les éléments sont enregistrés. Ajoutons les derniers détails. » |
| Détails | options enregistrées | taxes, remise et total recalculés | Vérification | « Tout est réuni. Vérifiez les informations avant de continuer. » |
| Vérification | confirmé | version inchangée | Aperçu | « Tout est prêt. Regardez le document avant sa génération. » |
| Aperçu | Préparer le PDF | version vérifiée | Rendu temporaire | « Je prépare le calcul exact du document. » |
| Rendu temporaire | pages calculées | artefact non livré, coût central | Coût | « Votre document fera {pages} et coûtera {coût}. » |
| Coût | solde suffisant | solde relu, aucun débit | Confirmation | « Aucun crédit ne sera débité avant votre confirmation. » |
| Confirmation | confirmation explicite | version/coût valides, clé idempotente | Génération | « Je prépare votre document. » |
| Génération | fichier final persisté | débit unique, version immuable | Livraison | « Votre document est prêt. » |
| Livraison | envoi confirmé | aucune seconde facturation | Historique | « Le document a bien été envoyé et reste disponible dans votre historique. » |

## Corrections

| Origine | Action visible | Destination | Règle de retour |
|---|---|---|---|
| Vérification ou aperçu | Modifier le client | Informations du client | conserver contenu et détails, puis revenir à Vérification |
| Vérification ou aperçu | Modifier les articles | Contenu | cibler par identifiant serveur, recalculer, puis revenir à Vérification |
| Vérification ou aperçu | Modifier les détails | Autres détails | conserver client et contenu, recalculer, puis revenir à Vérification |
| Vérification ou aperçu de décharge | Modifier la remise | Détails de la décharge | conserver les parties non modifiées, puis revenir à Vérification |

Toute correction incrémente la version et invalide aperçu, rendu temporaire et coût précédents. Elle ne crée ni ligne supplémentaire ni nouveau brouillon sans demande explicite.

## Recharge et retour

```text
CONFIRMATION
  -> solde insuffisant
  -> RECHARGE
  -> paiement en attente
  -> webhook de paiement vérifié
  -> crédit idempotent
  -> relecture document + version + coût
       -> coût encore valide : CONFIRMATION
       -> données ou tarif changés : RENDU TEMPORAIRE -> COÛT -> CONFIRMATION
```

La recharge ne vaut jamais confirmation de génération. Le texte de retour est : « Votre solde est à jour. Revenons à votre document pour confirmer sa génération. »

## Interruption, expiration et reprise

| Situation | Persistance | Message | Reprise |
|---|---|---|---|
| utilisateur quitte un écran | conserver uniquement les données déjà validées | aucun message en double | recréer l'étape depuis la version serveur |
| session expirée | aucune nouvelle mutation | « Cette étape a expiré, mais vos informations sont conservées. Reprenons où vous vous êtes arrêté. » | même étape fonctionnelle, nouvelle session |
| vocal/photo en cours d'analyse interrompu | ne pas confirmer de candidat | « Je n'ai pas pu terminer la lecture. Vous pouvez réessayer ou m'écrire l'information. » | même question |
| rendu temporaire échoue | brouillon intact, aucun débit | « Je n'ai pas pu calculer le document maintenant. Vos informations sont conservées. » | Préparer le PDF |
| génération échoue après débit | opération et débit conservés par clé | « La préparation a été interrompue. Je vais reprendre sans vous débiter à nouveau. » | étape idempotente inachevée |
| livraison échoue | fichier final conservé | « Le document est prêt, mais son envoi a échoué. Vous pourrez le renvoyer sans nouveau débit. » | Livraison seulement |

## Annulation

Avant débit : « D'accord. Votre document est conservé pour plus tard. » Aucun crédit n'est débité.

Après génération : l'utilisateur peut arrêter la conversation, mais le document final n'est ni supprimé ni modifié implicitement. Les règles d'annulation comptable restent à arbitrer.

## Branches par type

### Facture

CLIENT → produits/services → paiement à recevoir et échéance éventuelle → vérification de la facture.

### Devis

CLIENT → produits/services → durée de validité et conditions → vérification de la proposition.

### Reçu

PAYEUR/BÉNÉFICIAIRE → paiement déjà reçu ou contenu → mode/référence éventuels → vérification du reçu.

### Décharge

REMMETTANT → RECEVEUR → somme/bien/document → quantité éventuelle, motif et observations → vérification de la décharge.

Les branches rejoignent ensuite APERÇU → COÛT → CONFIRMATION → GÉNÉRATION → LIVRAISON.

## Routes interdites

* Conversation directement vers débit, génération ou livraison.
* Information incertaine directement vers vérification confirmée.
* Recharge directement vers génération sans nouvelle confirmation.
* Correction directement vers un ancien coût non recalculé.
* Erreur ou expiration vers MENU si l'intention du document est connue.
* Livraison échouée vers un nouveau débit.
* Un document final livré vers une mutation de sa version immuable.

## Continuité visible

Chaque carte annonce le résultat acquis et une seule prochaine action. Les textes n'emploient jamais Flow, session, payload, écran technique, OCR, fournisseur IA ou endpoint. Le bouton nomme l'action humaine : « Voir le client », « Ajouter les articles », « Voir l'aperçu », « Générer le document ».
