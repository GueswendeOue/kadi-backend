# Kadi — Contrats fonctionnels des Flows partagés

## Portée et conventions

Ces contrats sont indépendants des IDs Meta, du nombre de Flows physiques et de leur découpage en écrans. Les frontières restent invisibles pour l'utilisateur. Le backend conserve l'état, résout les références pseudonymes et vérifie propriété, activité, expiration et révocation.

Chaque contrat reçoit un contexte minimal : référence de session, `document_id` si créé, `document_type`, `version`, destination fonctionnelle et données d'affichage strictement nécessaires. Il retourne une intention structurée, jamais une valeur calculée faisant autorité côté client.

Annuler conserve le brouillon sauf règle métier approuvée contraire. Une session expirée ne modifie rien et propose humainement de reprendre ; le serveur recrée une session depuis l'état persistant autorisé.

## Pipeline commun

| Étape | Entrées | Sorties et validations | Erreurs récupérables | Action suivante | Persistance |
|---|---|---|---|---|---|
| CONVERSATION | texte, vocal ou photo | intention et données candidates | intention ambiguë | une question précise | message et contexte minimal selon politique |
| EXTRACTION | contenu reçu | valeurs typées avec niveau de confiance | contenu illisible ou contradictoire | demander la valeur incertaine | candidats et provenance autorisée |
| INFORMATIONS MANQUANTES | candidats et contrat du type | liste priorisée des manques | réponse partielle | prochaine question unique | champs validés et manques |
| CLIENT OU BÉNÉFICIAIRE | partie extraite ou saisie | partie normalisée conforme au type | champ requis absent | `DOCUMENT_CLIENT` | brouillon et version |
| CONTENU DU DOCUMENT | lignes ou sujet | contenu cohérent, totaux recalculés | ligne incomplète ou sujet ambigu | `DOCUMENT_CONTENT` ou `DISCHARGE_DETAILS` | lignes par `item_id` ou détails de décharge |
| AUTRES DÉTAILS | options candidates | options valides pour le type | combinaison invalide | `DOCUMENT_OPTIONS` | options normalisées |
| VÉRIFICATION | brouillon cohérent | confirmation ou cible de correction | incohérence détectée | REVIEW ou EDIT | statut et corrections versionnées |
| APERÇU | version vérifiée | projection structurée | données devenues obsolètes | corriger ou préparer | aperçu lié à la version |
| RENDU TEMPORAIRE | aperçu et version | artefact non livré et empreinte | rendu impossible | réessayer sans débit | référence temporaire |
| CALCUL DU COÛT | rendu temporaire | pages réelles et coût configuré | règle tarifaire indisponible | attendre ou réessayer | devis de génération versionné |
| CONFIRMATION | coût, pages et solde | accord explicite ou refus | coût expiré ou version changée | recalculer, enregistrer ou continuer | décision idempotente |
| DÉBIT IDÉMPOTENT | accord et clé stable | débit unique ou solde insuffisant | conflit, timeout, solde insuffisant | génération ou recharge | écriture wallet atomique |
| GÉNÉRATION | débit confirmé et version figée | fichier final immuable | interruption technique | reprendre avec même clé | document final et opération |
| LIVRAISON | fichier final autorisé | livraison confirmée | canal temporairement indisponible | relivrer sans redébiter | état et tentatives de livraison |
| HISTORIQUE | propriétaire et critères | résultats autorisés et paginés | aucun résultat | affiner ou revenir | aucune mutation par défaut |

## Contrats par Flow

### ONBOARDING

| Élément | Contrat |
|---|---|
| Objectif | accueillir, créer le profil minimal et permettre une découverte immédiate de Kadi |
| Écrans | bienvenue, profil minimal, préférence vocale et confirmation facultative |
| Reçoit | `wa_id` résolu côté serveur, état utilisateur, profil existant, `welcome_credits_granted`, préférence vocale et champs réellement manquants |
| Affiche | texte canonique de bienvenue, annonce des 5 crédits, texte/vocal/photo et une seule action « Commencer » |
| Retourne | données de profil confirmées, préférence vocale ou décision de continuer plus tard |
| Validations | identité `wa_id`, statut d'onboarding, formats, consentement et unicité selon règles approuvées |
| Action serveur | exécuter `USER_PROFILE_CREATED` puis attribuer atomiquement une seule fois 5 crédits via le ledger `WELCOME_CREDITS` et `welcome_credits_granted` |
| Confirmation bonus | confirmer le bonus uniquement après succès serveur ; le Flow ne crédite jamais le portefeuille |
| Accueil | après `WELCOME_CREDITS_GRANTED`, envoyer le texte, tenter le vocal de façon non bloquante, puis démarrer l'onboarding |
| Échec vocal | conserver profil, bonus et texte ; enregistrer un échec récupérable et permettre un retry audio dédupliqué |
| Destination | conversation initiale, MENU ou première création de document |
| Annulation | conserver profil, bonus déjà accordé et données valides ; ne pas réattribuer |
| Session expirée | reprendre au prochain champ manquant sans rejouer le bonus ni le vocal automatique |

L'attribution utilise une clé conceptuelle unique `welcome_credits:<wa_id>`. Le vocal utilise une clé indépendante telle que `welcome_voice:<wa_id>:v1`, qui n'influence jamais l'éligibilité. Webhook répété, double clic, reprise, ré-onboarding ou réactivation retournent le résultat existant. Profil minimal créé, crédits accordés et onboarding complété restent trois faits persistants distincts.

Ordre de référence : `USER_PROFILE_CREATED` → `WELCOME_CREDITS_GRANTED` → `WELCOME_TEXT_SENT` → `WELCOME_VOICE_ATTEMPTED` → `ONBOARDING_STARTED` → `ONBOARDING_COMPLETED`. Les champs facultatifs ne bloquent ni le profil minimal ni le bonus.

### MENU

| Élément | Contrat |
|---|---|
| Objectif | fournir un raccourci, sans remplacer le langage naturel |
| Écrans | actions principales |
| Reçoit | capacités disponibles et contexte utilisateur |
| Affiche | Préparer un document, Retrouver un document, Mon solde, Aide |
| Retourne | intention choisie |
| Validations | action dans la liste autorisée |
| Action serveur | router vers la capacité autorisée |
| Destination | collecte, historique, solde ou aide |
| Annulation | retour à la conversation |
| Session expirée | proposer une reprise simple |

### DOCUMENT_CLIENT

| Élément | Contrat |
|---|---|
| Objectif | vérifier le client ou bénéficiaire requis par le type |
| Écrans | identité, contacts et adresse seulement si nécessaires |
| Reçoit | `document_type`, partie candidate et champs manquants |
| Affiche | valeurs connues et champs pertinents |
| Retourne | partie corrigée et décision de continuer |
| Validations | obligations conditionnelles du type, formats et longueurs |
| Action serveur | fusionner les champs autorisés, incrémenter `version` |
| Destination | contenu ou vérification |
| Annulation | brouillon conservé |
| Session expirée | recharger la version courante avant reprise |

### DOCUMENT_CONTENT

| Élément | Contrat |
|---|---|
| Objectif | vérifier les lignes d'une facture, d'un devis ou d'un reçu à lignes |
| Écrans | ajout, résumé et décision de continuer |
| Reçoit | type, compteur, sous-total et valeurs candidates |
| Affiche | champs frais pour une nouvelle ligne et résumé serveur |
| Retourne | ligne proposée et intention ajouter/terminer |
| Validations | désignation, quantité, unité et prix selon contrat du type |
| Action serveur | créer une ligne avec `item_id`, recalculer sous-total et total |
| Destination | nouvelle ligne, options ou vérification |
| Annulation | lignes validées conservées, ligne incomplète ignorée |
| Session expirée | ne jamais rejouer une soumission déjà traitée |

### DOCUMENT_OPTIONS

| Élément | Contrat |
|---|---|
| Objectif | vérifier taxes, remise, paiement et notes pertinentes |
| Écrans | options conditionnelles au `document_type` |
| Reçoit | options actuelles et capacités configurées |
| Affiche | uniquement les choix autorisés |
| Retourne | options proposées |
| Validations | combinaison, bornes et règles du type |
| Action serveur | normaliser, recalculer taxes et total, versionner |
| Destination | vérification |
| Annulation | options précédentes conservées |
| Session expirée | recharger les options courantes |

### DOCUMENT_REVIEW

| Élément | Contrat |
|---|---|
| Objectif | faire vérifier toutes les données avant aperçu |
| Écrans | synthèse et choix de correction |
| Reçoit | projection complète de la version courante |
| Affiche | parties, contenu, options et totaux dans un langage humain |
| Retourne | confirmation, sauvegarde ou catégorie à corriger |
| Validations | version inchangée et brouillon cohérent |
| Action serveur | marquer vérifié ou ouvrir la correction choisie |
| Destination | EDIT, DOCUMENT_PREVIEW ou sauvegarde |
| Annulation | brouillon sauvegardé sans génération |
| Session expirée | reconstruire la synthèse depuis la dernière version |

### EDIT_CLIENT

| Élément | Contrat |
|---|---|
| Objectif | corriger seulement la partie destinataire |
| Écrans | champs client ou bénéficiaire pertinents |
| Reçoit | partie actuelle et version |
| Affiche | valeurs existantes modifiables |
| Retourne | champs modifiés |
| Validations | mêmes règles que DOCUMENT_CLIENT |
| Action serveur | appliquer un patch autorisé, conserver contenu et options |
| Destination | DOCUMENT_REVIEW |
| Annulation | aucune mutation |
| Session expirée | détecter conflit de version avant reprise |

### EDIT_CONTENT

| Élément | Contrat |
|---|---|
| Objectif | corriger le contenu sans ajout involontaire |
| Écrans | sélection serveur puis édition de la ligne, ou détails propres à la décharge |
| Reçoit | références stables et valeurs actuelles |
| Affiche | choix humain sans exposer l'identifiant interne |
| Retourne | référence sélectionnée et patch |
| Validations | `item_id` serveur, propriété, version et règles du contenu |
| Action serveur | mettre à jour la cible, recalculer les totaux, ne pas faire d'append |
| Destination | DOCUMENT_REVIEW |
| Annulation | aucune mutation |
| Session expirée | ne pas appliquer un patch sur une version obsolète |

### EDIT_OPTIONS

| Élément | Contrat |
|---|---|
| Objectif | corriger uniquement les options |
| Écrans | options applicables au type |
| Reçoit | options actuelles et version |
| Affiche | valeurs existantes et choix autorisés |
| Retourne | patch d'options |
| Validations | mêmes règles que DOCUMENT_OPTIONS |
| Action serveur | appliquer, recalculer, conserver parties et contenu |
| Destination | DOCUMENT_REVIEW |
| Annulation | aucune mutation |
| Session expirée | recharger la version courante |

### DOCUMENT_PREVIEW

| Élément | Contrat |
|---|---|
| Objectif | afficher l'aperçu structuré complet avant tout rendu facturable |
| Écrans | aperçu et trois actions |
| Reçoit | projection vérifiée liée à une version |
| Affiche | type, parties, contenu, montants, date automatique et numéro selon règle |
| Retourne | modifier, préparer le PDF ou enregistrer |
| Validations | version et propriété, cohérence des calculs |
| Action serveur | enregistrer l'intention ; aucun débit |
| Destination | EDIT/REVIEW, rendu temporaire ou sauvegarde |
| Annulation | sauvegarder sans PDF final |
| Session expirée | recréer l'aperçu si la version a changé |

### GENERATION_COST_CONFIRMATION

| Élément | Contrat |
|---|---|
| Objectif | présenter pages, coût et solde puis recueillir un accord explicite |
| Écrans | détail du coût et confirmation |
| Reçoit | devis de génération lié au rendu et à la version |
| Affiche | pages réelles, coût exact et solde |
| Retourne | confirmer, refuser ou recharger |
| Validations | coût non expiré, version inchangée, solde relu avant débit |
| Action serveur | débit idempotent après confirmation seulement |
| Destination | génération, RECHARGE ou brouillon sauvegardé |
| Annulation | aucun débit, brouillon conservé |
| Session expirée | recalculer si le devis n'est plus valide |

### RECHARGE

| Élément | Contrat |
|---|---|
| Objectif | permettre une recharge vérifiée sans perdre le document |
| Écrans | solde, packs configurés et état du paiement |
| Reçoit | solde, coût requis, packs et référence de reprise |
| Affiche | prix issus de la configuration centrale |
| Retourne | pack choisi ou annulation |
| Validations | pack actif, paiement authentique et montant attendu |
| Action serveur | créer paiement ; créditer une fois après webhook vérifié |
| Destination | confirmation de génération au même document ou solde |
| Annulation | paiement non confirmé non crédité, brouillon conservé |
| Session expirée | statut paiement relu côté serveur avant reprise |

### HISTORY_SEARCH

| Élément | Contrat |
|---|---|
| Objectif | retrouver un document autorisé par critères humains |
| Écrans | critères, résultats paginés et actions permises |
| Reçoit | propriétaire, filtres normalisés et curseur |
| Affiche | métadonnées minimales, jamais celles d'un tiers |
| Retourne | filtre, document choisi ou action autorisée |
| Validations | propriété, pagination et droits selon statut |
| Action serveur | rechercher sans mutation par défaut |
| Destination | aperçu, reprise ou conversation |
| Annulation | aucune mutation |
| Session expirée | relancer la recherche sans réutiliser un résultat non autorisé |

### DISCHARGE_DETAILS

| Élément | Contrat |
|---|---|
| Objectif | vérifier les données propres à une décharge |
| Écrans | remettant, receveur, sujet, quantité, motif et conditions |
| Reçoit | candidats extraits et champs manquants du modèle décharge |
| Affiche | uniquement les composants pertinents au sujet remis |
| Retourne | détails structurés et décision de vérifier |
| Validations | parties, union montant/bien/document, cohérence de quantité |
| Action serveur | mettre à jour `DischargeDocument` et versionner |
| Destination | vérification puis aperçu |
| Annulation | brouillon conservé |
| Session expirée | reprendre depuis les détails persistés |

## Invariants de sécurité et d'orchestration

* Aucune donnée client sensible n'est requise dans le message initial d'ouverture.
* Une complétion reconnue est traitée avant anciens boutons, MENU et OpenAI, puis retourne immédiatement.
* Les soumissions sont idempotentes ; aucun retry ne duplique ligne, débit, crédit, génération ou livraison.
* Les données affichées proviennent de la version serveur autorisée.
* Aucun Flow en `DRAFT` ne débite ni ne génère un PDF final.
* Les erreurs sont humaines, courtes et dépourvues de jargon ou d'identifiant interne.
