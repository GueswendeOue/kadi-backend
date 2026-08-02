# Kadi — Onboarding vocal et crédits de bienvenue

## Objet

Ce document est la référence canonique du premier accueil et du bonus historique Kadi. Chaque nouvel utilisateur reçoit exactement 5 crédits, une seule fois, sous autorité exclusive du backend. En cas de divergence avec un texte d'onboarding plus ancien dans un catalogue général, le texte de premier accueil défini ici prévaut.

## Expérience du premier accueil

### Texte canonique

> Bienvenue chez Kadi
>
> Je vous aide à préparer vos factures, devis, reçus et décharges directement sur WhatsApp.
>
> Vous pouvez m'écrire, m'envoyer un vocal ou une photo.
>
> 5 crédits viennent de vous être offerts pour commencer.

Action unique : « Commencer ».

Ce message présente une assistante unique et les trois modalités d'entrée. Il ne demande pas immédiatement toutes les informations facultatives du profil.

### Vocal de bienvenue

Le premier accueil ajoute un court vocal qui reprend fidèlement le texte canonique. Il est féminin, naturel, chaleureux, professionnel, clair et non caricatural. Il annonce exactement les 5 crédits après confirmation serveur de leur attribution, n'ajoute aucune promesse et ne lit aucune donnée sensible.

Le texte est envoyé dans tous les cas. Le vocal automatique est réservé au premier accueil ; reprise, ré-onboarding et réactivation ne le rejouent pas. Une demande vocale explicite ultérieure suit la politique vocale normale.

L'échec du vocal ne retire pas les crédits, n'annule pas le profil, ne bloque pas l'onboarding et ne provoque aucune seconde attribution. Le texte est envoyé, l'échec devient récupérable et un nouvel essai audio autorisé réutilise une clé stable distincte :

```text
welcome_voice:<wa_id>:v1
```

Cette clé ne participe jamais à la décision d'éligibilité au bonus.

Une version courte en mooré peut être étudiée après benchmark avec des utilisateurs locaux. Ni sa disponibilité ni sa qualité ne sont promises avant validation.

## Autorité et identité

L'identité opérationnelle de l'utilisateur est son `wa_id` WhatsApp résolu et validé par le backend. Ni le Flow, ni le client, ni un solde affiché ne décide de l'éligibilité.

Le profil utilisateur porte un marqueur persistant `welcome_credits_granted`. Le ledger reçoit un mouvement de type `WELCOME_CREDITS`. L'opération utilise une clé stable unique :

```text
welcome_credits:<wa_id>
```

Le `wa_id` complet est une donnée sensible : il ne doit pas apparaître en clair dans les logs ou rapports.

## Contrat des 5 crédits

* Montant : exactement 5 crédits.
* Population : nouvel utilisateur après création réussie du profil minimal.
* Fréquence : une seule fois durant la vie de l'identité.
* Renouvellement : jamais après consommation, interruption, reprise, double webhook, double clic, ré-onboarding, réactivation ou changement de préférence vocale.
* Solde : indépendant du solde courant.
* Autorité : backend Kadi uniquement.
* Preuve : écriture ledger et marqueur persistant cohérents.
* Déclenchement client : insuffisant à lui seul.

## Ordre des opérations

```text
USER_PROFILE_CREATED
  -> WELCOME_CREDITS_GRANTED
  -> WELCOME_TEXT_SENT
  -> WELCOME_VOICE_ATTEMPTED
  -> ONBOARDING_STARTED
  -> ONBOARDING_COMPLETED
```

Le profil minimal et les crédits ne dépendent jamais de la complétion des champs facultatifs. L'annonce des 5 crédits dépend obligatoirement du succès de `WELCOME_CREDITS_GRANTED`.

### Frontière transactionnelle du bonus

1. Résoudre et valider le `wa_id`.
2. Rechercher ou créer le profil minimal de manière idempotente.
3. Lire `welcome_credits_granted` et le ledger historique dans la même frontière de cohérence.
4. Si le bonus existe, retourner le résultat antérieur sans écriture supplémentaire.
5. Sinon, inscrire `WELCOME_CREDITS` pour 5 crédits et passer `welcome_credits_granted=true` atomiquement.
6. Confirmer le bonus dans le texte uniquement après succès.
7. Tenter le vocal fidèle sans bloquer la suite.
8. Continuer l'onboarding facultatif ou la première demande de document.

Une transaction de base de données ou une garantie atomique équivalente est obligatoire. Il est interdit d'inscrire le ledger sans le marqueur, de positionner le marqueur sans le ledger ou de calculer l'éligibilité depuis le seul solde.

## Faits persistants distincts

| Fait | Signification | Dépendance |
|---|---|---|
| Profil minimal créé | l'identité peut utiliser le backend | préalable au bonus |
| Crédits accordés | ledger et marqueur atomiquement établis | n'attend pas les champs facultatifs |
| Onboarding complété | parcours d'accompagnement courant terminé | indépendant du maintien du bonus |

Une interruption après le bonus mais avant la fin de l'onboarding reprend les informations manquantes sans réattribuer de crédits.

## États utilisateur

| État | Expérience | Bonus |
|---|---|---|
| `NEW_USER` | premier accueil et création du profil minimal | attribuable si aucune preuve historique |
| `ONBOARDING_IN_PROGRESS` | poursuivre les informations utiles | ne pas rejouer s'il est déjà accordé |
| `ONBOARDING_COMPLETED` | accéder directement à l'usage normal | jamais renouvelé |
| `REONBOARDING_ELIGIBLE` | revoir l'accompagnement ou compléter le profil | jamais renouvelé si marqueur vrai |
| `REACTIVATION_ELIGIBLE` | reprendre après inactivité | jamais renouvelé |

Un ancien utilisateur sans document peut bénéficier d'un accompagnement de reprise. L'absence de document ou un solde nul ne crée aucune éligibilité au bonus.

## Contrat du Flow Onboarding

### Données reçues

* référence pseudonyme de session ;
* statut utilisateur calculé côté serveur ;
* champs de profil minimal manquants ;
* préférence `voice_response_mode` actuelle ;
* confirmation serveur du bonus, sans donnée de ledger modifiable côté client.

Le `wa_id` complet et les données sensibles ne sont pas nécessaires dans les données visibles du Flow.

### Données affichées

* texte canonique de bienvenue ;
* annonce des 5 crédits après confirmation serveur ;
* explication simple de texte, vocal et photo ;
* champs strictement nécessaires ;
* préférence vocale si le produit décide de la demander à cette étape ;
* action unique « Commencer » au premier accueil.

### Données retournées

Le Flow peut retourner les champs de profil autorisés, la préférence vocale et l'intention de continuer ou reprendre plus tard. Il ne retourne jamais une instruction faisant autorité pour créditer le portefeuille.

### Action serveur

Le backend valide la session et le propriétaire, crée ou complète le profil minimal, applique l'opération idempotente de bonus si elle est éligible, puis choisit la transition vers menu ou première création de document.

### Interruption et expiration

Les données déjà validées, le ledger et le marqueur restent intacts. Une nouvelle session reprend le prochain manque. Elle n'attribue pas un second bonus et ne renvoie pas automatiquement le vocal de premier accueil.

## Événements et idempotence

| Événement | Peut être rejoué techniquement | Effet métier répété |
|---|---:|---:|
| `USER_PROFILE_CREATED` | oui | non |
| `WELCOME_CREDITS_GRANTED` | oui, avec même clé | jamais |
| `WELCOME_TEXT_SENT` | retry contrôlé seulement | pas de double message visible |
| `WELCOME_VOICE_ATTEMPTED` | oui, avec clé audio dédiée | aucun bonus ; pas de double vocal visible |
| `ONBOARDING_STARTED` | oui | reprise seulement |
| `ONBOARDING_COMPLETED` | oui | non |
| `ONBOARDING_RESUMED` | oui | reprise seulement |
| `USER_REACTIVATED` | oui | aucun bonus |

Webhook répété, double clic et course concurrente convergent vers un seul profil, une seule écriture `WELCOME_CREDITS`, un marqueur vrai et un seul premier accueil visible.

## Utilisateurs existants

Ne pas attribuer automatiquement 5 crédits à tous les utilisateurs existants. Une éventuelle migration ou régularisation future doit rapprocher :

* le ledger historique ;
* `welcome_credits_granted` ;
* les anciens bonus et opérations équivalentes ;
* la date de création du profil ;
* les écritures de crédit existantes ;
* la provenance des comptes ;
* les cas incomplets ou contradictoires à examiner.

Le solde actuel ne permet pas de savoir si un bonus a été reçu puis consommé. Tout cas ambigu doit être placé en revue, jamais crédité silencieusement.

## Critères d'acceptation

* Un nouveau `wa_id` éligible reçoit exactement 5 crédits.
* Deux requêtes concurrentes produisent une seule écriture ledger.
* Un retry retourne le même résultat sans nouveau crédit.
* Une interruption avant fin d'onboarding ne change pas le bonus.
* Ré-onboarding et réactivation n'ajoutent aucun crédit.
* Le Flow seul ne peut pas créditer le wallet.
* Texte et vocal annoncent la même valeur.
* Le vocal n'est envoyé automatiquement qu'au premier accueil.
* Le texte reste disponible si la synthèse vocale échoue.
* Le message n'annonce le bonus qu'après `WELCOME_CREDITS_GRANTED`.
* Un retry vocal ne recrédite jamais le portefeuille.
* Aucun `wa_id` complet ou détail financier sensible n'est exposé dans les logs.

## Questions à arbitrer

| Sujet | Recommandation | Alternatives |
|---|---|---|
| Préférence vocale | demander plus tard, après valeur démontrée | proposer pendant onboarding |
| Échec TTS | continuer en texte seul, sans retry visible automatique | retry interne borné et dédupliqué |
| Profil minimal | limiter aux champs requis par le backend | ajouter nom/activité si bénéfice validé |
| Historique incomplet | revue explicite avant régularisation | migration par règle approuvée et auditée |
| Mooré | prototype puis benchmark local | rester en français pour la V1 |

Ces décisions ne modifient jamais le montant, l'unicité ni l'autorité backend du bonus.
