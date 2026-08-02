# Kadi — Catalogue canonique des textes V1

## Mode d'emploi

Ce catalogue définit les textes français visibles de la V1. Les variables entre accolades sont remplacées par des valeurs validées côté serveur. Une valeur absente entraîne une variante dédiée, jamais l'affichage brut de l'accolade.

Les cartes et écrans ne doivent jamais afficher : Créer guidé, Vérifier le client, Flow, payload, session, OCR, OpenAI, Gemini, endpoint, brouillon technique ou commande non reconnue.

La photo et le vocal sont des manières d'envoyer des informations. Ils ne figurent pas comme services autonomes du menu.

## A. Onboarding

**Message canonique de premier accueil**

> Bienvenue chez Kadi
>
> Je vous aide à préparer vos factures, devis, reçus et décharges directement sur WhatsApp.
>
> Vous pouvez m'écrire, m'envoyer un vocal ou une photo.
>
> 5 crédits viennent de vous être offerts pour commencer.

| Élément | Texte canonique |
|---|---|
| Message de premier accueil | texte canonique ci-dessus |
| Titre de carte | « Bienvenue chez Kadi » |
| Corps | le message canonique ci-dessus, envoyé seulement après confirmation serveur des 5 crédits |
| Pied de page | aucun au premier accueil |
| Bouton d'ouverture | « Commencer » |
| Titre d'écran | « Faisons connaissance » |
| Aide | « Indiquez seulement les informations nécessaires pour commencer. » |
| Champs | « Votre nom ou activité » ; « Nom de l'entreprise » si utile |
| Options | aucune option technique ; choix de préférence vocale seulement si validé |
| Action du premier accueil | « Commencer » uniquement |
| Boutons dans l'onboarding progressif | « Continuer » ; « Plus tard » |
| Confirmation | « Merci. Que voulez-vous préparer aujourd'hui ? » |
| Erreur récupérable | « Je n'ai pas pu enregistrer cette information. Vérifiez-la et réessayez. » |
| Reprise après expiration | « Vos informations déjà enregistrées sont conservées. Reprenons la dernière étape. » |

Le message est envoyé uniquement après confirmation serveur de l'attribution. Le court vocal reprend exactement le message de premier accueil. Son échec ne bloque ni le texte ni l'onboarding et ne modifie jamais les crédits. Un nouvel essai audio ne réannonce pas le bonus comme une nouvelle attribution.

## B. Accueil

| Élément | Texte canonique |
|---|---|
| Message | « Bonjour {prénom}. Que voulez-vous préparer aujourd'hui ? Vous pouvez écrire, envoyer un vocal ou une photo. » |
| Carte | aucune carte obligatoire |
| Bouton éventuel | « Voir les raccourcis » |
| Écran | aucun écran obligatoire |
| Confirmation | la réponse suivante confirme l'intention comprise |
| Erreur récupérable | « Je n'ai pas bien compris le document souhaité. Voulez-vous préparer une facture, un devis, un reçu ou une décharge ? » |
| Reprise | « Nous pouvons reprendre votre document ou commencer autre chose. Que préférez-vous ? » |

## C. Menu

| Élément | Texte canonique |
|---|---|
| Message avant ouverture | « Voici les raccourcis disponibles. Vous pouvez aussi me dire directement ce dont vous avez besoin. » |
| Titre de carte | « Que souhaitez-vous faire ? » |
| Corps | « Choisissez un raccourci ou continuez à écrire naturellement. » |
| Pied de page | aucun |
| Bouton d'ouverture | « Voir les raccourcis » |
| Titre d'écran | « Raccourcis » |
| Aide | « Choisissez une seule action. » |
| Options | « Préparer un document » ; « Retrouver un document » ; « Mon solde » ; « Aide » |
| Bouton | « Continuer » |
| Confirmation | adaptée au choix, sans répéter le menu |
| Erreur récupérable | « Ce choix n'est plus disponible. Choisissez une autre action. » |
| Reprise | « Les raccourcis ont été actualisés. Que souhaitez-vous faire ? » |

## D. Choix ou compréhension du document

| Élément | Texte canonique |
|---|---|
| Intention comprise | « Bien sûr. Préparons votre {type_document}. Envoyez-moi les informations que vous avez déjà. » |
| Intention ambiguë | « Voulez-vous préparer une facture, un devis, un reçu ou une décharge ? » |
| Titre de carte | « Choisir le document » |
| Corps | « Sélectionnez le document qui correspond à votre besoin. » |
| Pied de page | « Vous pourrez vérifier toutes les informations avant la génération. » |
| Bouton d'ouverture | « Choisir » |
| Titre d'écran | « Type de document » |
| Aide | « Facture : paiement à recevoir. Devis : proposition. Reçu : paiement reçu. Décharge : remise attestée. » |
| Options | « Facture » ; « Devis » ; « Reçu » ; « Décharge » |
| Bouton | « Continuer » |
| Confirmation | « D'accord, préparons {article_type} {type_document}. » |
| Erreur récupérable | « Je n'ai pas pu confirmer le type de document. Choisissez-le à nouveau. » |
| Reprise | « Le type de document n'a pas été enregistré. Reprenons ce choix. » |

## E. Client ou bénéficiaire

### Vocabulaire contextuel

| Situation | Formulation |
|---|---|
| Client absent | « Ajouter le client » |
| Client déjà compris | « Voir le client » |
| Correction demandée | « Modifier le client » |
| Titre d'écran | « Informations du client » |
| Texte d'aide | « Modifiez seulement ce qui doit être corrigé. » |
| Action de sortie | « Continuer » |

Ne jamais employer « Vérifier le client », qui peut évoquer un contrôle d'identité.

### Contrat de copie

| Élément | Texte canonique |
|---|---|
| Message si absent | « Ajoutons le client. Indiquez son nom et les coordonnées utiles. » |
| Message si compris | « J'ai noté {client} comme client. Regardez ses informations avant de continuer. » |
| Titre de carte | « Kadi » |
| Corps | reprendre le message contextuel ci-dessus |
| Pied de page | « Vous pourrez modifier ces informations plus tard. » |
| Bouton d'ouverture | « Ajouter le client » ou « Voir le client » |
| Titre d'écran | « Informations du client » |
| Aide | « Modifiez seulement ce qui doit être corrigé. » |
| Labels | « Nom ou raison sociale » ; « Téléphone » ; « Adresse » ; autres champs seulement si nécessaires |
| Options | aucune par défaut |
| Bouton | « Continuer » |
| Confirmation | « Client enregistré. Ajoutons maintenant les produits ou services. » |
| Erreur récupérable | « Une information du client doit être corrigée avant de continuer. » |
| Reprise | « Les informations du client sont conservées. Reprenons leur vérification. » |

Pour un reçu, « client » peut devenir « payeur » ou « bénéficiaire ». Pour une décharge, utiliser « Personne qui remet » et « Personne qui reçoit ».

## F. Articles ou contenu

| Élément | Texte canonique |
|---|---|
| Message avant ouverture | « Ajoutons les produits ou services de votre {type_document}. » |
| Titre de carte | « Produits ou services » |
| Corps | « Ajoutez un élément à la fois. Je calculerai les montants à partir des informations enregistrées. » |
| Pied de page | « Vous pourrez corriger chaque élément avant la génération. » |
| Bouton d'ouverture | « Ajouter les articles » |
| Titre d'écran | « Ajouter un article » |
| Aide | « Indiquez la désignation, la quantité et le prix unitaire. » |
| Labels | « Désignation » ; « Quantité » ; « Unité » ; « Prix unitaire » |
| Options | unités configurées ; « Ajouter un autre article » ; « Terminer les articles » |
| Bouton | « Enregistrer » |
| Confirmation intermédiaire | « {désignation} est enregistré. Voulez-vous ajouter autre chose ? » |
| Confirmation finale | « Les produits ou services sont enregistrés. Ajoutons les derniers détails. » |
| Erreur récupérable | « Vérifiez la désignation, la quantité et le prix avant de continuer. » |
| Reprise | « Les articles déjà enregistrés sont conservés. Reprenons le prochain élément. » |

Pour un reçu sans lignes, utiliser « Détails du paiement » avec « Montant versé » et « Motif du paiement ». Pour une décharge, utiliser le contrat spécifique ci-dessous.

## G. Autres détails

| Élément | Texte canonique |
|---|---|
| Message avant ouverture | « Ajoutons les derniers détails utiles. » |
| Titre de carte | « Autres détails » |
| Corps | « Précisez seulement ce qui s'applique à votre document. » |
| Pied de page | aucun |
| Bouton d'ouverture | « Ajouter les détails » |
| Titre d'écran | « Autres détails » |
| Aide | « Vous pouvez laisser vide ce qui n'est pas nécessaire. » |
| Labels communs | « Taxes » ; « Remise » ; « Notes » |
| Facture | « Conditions de paiement » ; « Échéance » si la règle est validée |
| Devis | « Durée de validité » ; « Conditions » |
| Reçu | « Mode de paiement » ; « Référence du paiement » |
| Bouton | « Continuer » |
| Confirmation | « Les détails sont enregistrés. Vérifions maintenant l'ensemble du document. » |
| Erreur récupérable | « Un détail doit être corrigé avant de continuer. » |
| Reprise | « Vos choix sont conservés. Reprenons les derniers détails. » |

## H. Vérification

| Élément | Texte canonique |
|---|---|
| Message avant ouverture | « Tout est réuni. Vérifiez les informations avant de continuer. » |
| Titre de carte | « Vérifier le document » |
| Corps | « Regardez le client, le contenu, les détails et le total calculé. » |
| Pied de page | « Aucun crédit ne sera débité à cette étape. » |
| Bouton d'ouverture | « Voir le document » |
| Titre d'écran | « Vérification du document » |
| Aide | « Modifiez uniquement ce qui doit être corrigé. » |
| Champs affichés | lecture seule : client/bénéficiaire, contenu, options, sous-total, taxes, remise, total |
| Options | « Modifier le client » ; « Modifier les articles » ; « Modifier les détails » |
| Boutons | « Voir l'aperçu » ; « Enregistrer pour plus tard » |
| Confirmation | « Les informations sont confirmées. Préparons l'aperçu. » |
| Erreur récupérable | « Je n'ai pas pu confirmer cette version. Ouvrez à nouveau le document actualisé. » |
| Reprise | « Le document a été actualisé. Vérifiez la dernière version. » |

## I. Corrections

| Élément | Texte canonique |
|---|---|
| Message avant ouverture | « D'accord. Modifiez seulement ce qui doit être corrigé. » |
| Titre de carte | « Corriger le document » |
| Corps | varie selon la cible : client, articles ou détails |
| Pied de page | « Les autres informations seront conservées. » |
| Boutons d'ouverture | « Modifier le client » ; « Modifier les articles » ; « Modifier les détails » |
| Titres d'écran | « Informations du client » ; « Modifier un article » ; « Modifier les détails » |
| Aide client | « Modifiez seulement ce qui doit être corrigé. » |
| Aide article | « Choisissez un article, puis corrigez ses informations. » |
| Labels | mêmes labels que la collecte, avec valeurs serveur actuelles |
| Bouton | « Enregistrer » |
| Confirmation | « Modification enregistrée. Vérifiez maintenant le document actualisé. » |
| Erreur récupérable | « La modification n'a pas été enregistrée. Vérifiez les informations et réessayez. » |
| Reprise | « Vos données précédentes sont intactes. Reprenons la correction. » |

## J. Aperçu

| Élément | Texte canonique |
|---|---|
| Message avant ouverture | « Tout est prêt. Regardez le document avant sa génération. » |
| Titre de carte | « Aperçu du document » |
| Corps | « Vérifiez une dernière fois les informations affichées. » |
| Pied de page | « Cet aperçu ne débite aucun crédit. » |
| Bouton d'ouverture | « Voir l'aperçu » |
| Titre d'écran | « Aperçu du document » |
| Aide | « Le PDF final sera préparé seulement après le calcul du coût et votre confirmation. » |
| Affichage | type, émetteur, client/bénéficiaire, articles/objet, quantités, prix, taxes, remise, sous-total, total, notes, date automatique, numéro si disponible |
| Options | aucune option technique |
| Boutons | « Modifier » ; « Préparer le PDF » ; « Enregistrer pour plus tard » |
| Confirmation préparer | « Je vais calculer le nombre réel de pages et le coût exact. » |
| Confirmation sauvegarder | « Votre document est conservé. Vous pourrez reprendre ici plus tard. » |
| Erreur récupérable | « L'aperçu n'a pas pu être actualisé. Vos informations sont conservées. » |
| Reprise | « Voici l'aperçu actualisé de votre document. » |

Ne jamais employer « Vérifier l'aperçu ».

## K. Coût

| Élément | Texte canonique |
|---|---|
| Message avant ouverture | « Votre document fera {pages} et coûtera {coût}. » |
| Titre de carte | « Coût de génération » |
| Corps suffisant | « Votre solde est de {solde}. Aucun crédit ne sera débité avant votre confirmation. » |
| Corps insuffisant | « Votre brouillon est conservé. Il vous manque {crédits_manquants} pour générer ce document. » |
| Pied de page | « Le coût est calculé à partir du nombre réel de pages. » |
| Bouton d'ouverture | « Continuer » |
| Titre d'écran | « Coût du document » |
| Aide | « Vérifiez le coût et votre solde avant de choisir. » |
| Affichage | pages, coût, solde, manque éventuel |
| Boutons suffisants | « Générer le document » ; « Revenir à l'aperçu » |
| Boutons insuffisants | « Recharger mon compte » ; « Revenir à l'aperçu » |
| Confirmation | aucune avant le choix explicite |
| Erreur récupérable | « Je n'ai pas pu calculer le coût maintenant. Aucun crédit n'a été débité. » |
| Reprise | « Le coût a été recalculé. Vérifiez-le avant de continuer. » |

## L. Confirmation

| Élément | Texte canonique |
|---|---|
| Message | « Confirmez-vous la génération de ce document pour {coût} ? » |
| Titre de carte | « Confirmer la génération » |
| Corps | « Votre solde après génération sera de {solde_après}. » |
| Pied de page | « Une seule confirmation suffit. » |
| Bouton d'ouverture | « Continuer » |
| Titre d'écran | « Dernière confirmation » |
| Aide | « Le débit et la génération commenceront seulement après votre confirmation. » |
| Boutons | « Générer le document » ; « Revenir à l'aperçu » |
| Confirmation positive | « Confirmation reçue. Je prépare votre document. » |
| Confirmation négative | « D'accord. Aucun crédit n'a été débité. Votre document est conservé. » |
| Erreur récupérable | « Je n'ai pas pu enregistrer votre confirmation. Aucun crédit n'a été débité. » |
| Reprise | « Vérifiez à nouveau le coût avant de confirmer. » |

## M. Recharge

| Élément | Texte canonique |
|---|---|
| Message avant ouverture | « Votre brouillon est conservé. Il vous manque {crédits_manquants} pour générer ce document. » |
| Titre de carte | « Recharger mon compte » |
| Corps | « Choisissez un pack. Les crédits seront ajoutés après confirmation du paiement. » |
| Pied de page | « Aucun crédit n'est ajouté pour un paiement non confirmé. » |
| Bouton d'ouverture | « Voir les packs » |
| Titre d'écran | « Recharger mon compte » |
| Aide | « Choisissez le pack qui vous convient. » |
| Options | noms et prix lus depuis la configuration centrale |
| Boutons | « Continuer au paiement » ; « Plus tard » |
| Paiement en attente | « Votre paiement est en cours de vérification. Votre document reste conservé. » |
| Confirmation | « Votre solde est à jour. Revenons à votre document pour confirmer sa génération. » |
| Erreur récupérable | « Le paiement n'a pas été confirmé. Aucun crédit n'a été ajouté. » |
| Reprise | « Votre document est toujours conservé. Vous pouvez reprendre la recharge ou revenir plus tard. » |

## N. Génération

| Élément | Texte canonique |
|---|---|
| Message de début | « Je prépare votre document. » |
| Carte/écran | aucun nouvel écran obligatoire |
| Aide | aucune |
| Confirmation | « Votre document est prêt. » |
| Erreur avant débit | « La préparation n'a pas pu commencer. Aucun crédit n'a été débité. » |
| Erreur après débit | « La préparation a été interrompue. Je vais reprendre sans vous débiter à nouveau. » |
| Reprise | « Je reprends la préparation de votre document. » |

## O. Livraison

| Élément | Texte canonique |
|---|---|
| Message avant fichier | « Voici votre {type_document}. » |
| Légende du fichier | « {type_document} {numéro_document} » |
| Confirmation | « Le document a bien été envoyé et reste disponible dans votre historique. » |
| Bouton éventuel | « Voir l'historique » |
| Erreur récupérable | « Le document est prêt, mais son envoi a échoué. Vous pourrez le renvoyer sans nouveau débit. » |
| Reprise | « Je renvoie le même document. Aucun nouveau crédit ne sera débité. » |

## P. Historique

| Élément | Texte canonique |
|---|---|
| Message avant ouverture | « Retrouvez vos brouillons et documents récents. » |
| Titre de carte | « Mes documents » |
| Corps | « Consultez un document ou lancez une recherche. » |
| Pied de page | aucun |
| Bouton d'ouverture | « Voir mes documents » |
| Titre d'écran | « Mes documents » |
| Aide | « Seuls vos documents sont affichés. » |
| Options | résultats autorisés, libellés courts par type et date |
| Boutons | « Ouvrir » ; « Rechercher » |
| Confirmation | adaptée au document choisi |
| Erreur récupérable | « Je n'ai pas pu charger l'historique. Réessayez dans un moment. » |
| Reprise | « Reprenons la consultation de vos documents. » |

## Q. Recherche

| Élément | Texte canonique |
|---|---|
| Message avant ouverture | « Dites-moi ce que vous recherchez : un nom, un type de document, un numéro ou une période. » |
| Titre de carte | « Rechercher un document » |
| Corps | « Utilisez les informations dont vous vous souvenez. » |
| Pied de page | aucun |
| Bouton d'ouverture | « Rechercher » |
| Titre d'écran | « Rechercher » |
| Aide | « Vous pouvez combiner plusieurs critères. » |
| Labels | « Type de document » ; « Client ou bénéficiaire » ; « Numéro » ; « Période » |
| Options | types de documents autorisés |
| Bouton | « Rechercher » |
| Aucun résultat | « Je n'ai trouvé aucun document correspondant. Modifiez un critère ou essayez un autre terme. » |
| Confirmation | « J'ai trouvé {nombre} document(s). » |
| Erreur récupérable | « La recherche n'a pas pu être terminée. Réessayez dans un moment. » |
| Reprise | « Vos critères sont conservés. Relançons la recherche. » |

## R. Aide

| Élément | Texte canonique |
|---|---|
| Message | « Dites-moi simplement ce que vous voulez faire. Vous pouvez écrire, envoyer un vocal ou une photo. » |
| Exemples | « Je veux préparer un devis. » ; « Retrouve la facture de Moussa. » ; « Quel est mon solde ? » |
| Carte | aucune obligatoire |
| Bouton éventuel | « Voir les raccourcis » |
| Erreur récupérable | « Je n'ai pas compris cette demande. Dites-moi le résultat que vous souhaitez obtenir. » |
| Reprise | « Reprenons. Que souhaitez-vous faire ? » |

## S. Annulation

| Élément | Texte canonique |
|---|---|
| Avant confirmation | « Voulez-vous arrêter maintenant et conserver ce document pour plus tard ? » |
| Options | « Conserver pour plus tard » ; « Continuer » |
| Confirmation | « D'accord. Votre document est conservé pour plus tard. » |
| Après génération | « Le document déjà généré reste disponible dans votre historique. » |
| Erreur récupérable | « Je n'ai pas pu enregistrer votre choix. Votre document reste inchangé. » |
| Reprise | « Votre document est toujours disponible. Voulez-vous reprendre ? » |

## T. Session expirée

| Élément | Texte canonique |
|---|---|
| Message | « Cette étape a expiré, mais vos informations sont conservées. Reprenons où vous vous êtes arrêté. » |
| Carte | titre « Reprendre » ; corps « Ouvrez la dernière étape actualisée. » |
| Bouton | « Reprendre » |
| Écran | reconstruire l'étape fonctionnelle avec les données serveur actuelles |
| Erreur récupérable | « Je n'ai pas pu reprendre cette étape. Votre document reste conservé. » |

## U. Erreur récupérable

| Situation | Texte canonique |
|---|---|
| Information illisible | « J'ai du mal à lire {champ}. Quel est le montant exact ? » |
| Valeurs contradictoires | « Je vois deux valeurs différentes pour {champ}. Laquelle est correcte ? » |
| Donnée invalide | « Cette information doit être corrigée avant de continuer. » |
| Service temporaire | « Je ne peux pas terminer cette étape pour le moment. Vos informations sont conservées. » |
| Envoi d'écran | « Je n'ai pas pu ouvrir cette étape. Réessayons dans un moment. » |
| Sécurité/propriété | « Je ne peux pas ouvrir ce document depuis cette conversation. » |
| Action suivante | une seule : corriger, réessayer ou reprendre |

Ne jamais afficher le fournisseur, le code interne, la trace, l'état technique ou « commande non reconnue ».

## Variantes par type de document

| Concept | Facture | Devis | Reçu | Décharge |
|---|---|---|---|---|
| Introduction | « Préparons la facture pour votre client. » | « Préparons votre proposition commerciale. » | « Préparons le reçu du paiement déjà reçu. » | « Préparons l'attestation de remise. » |
| Partie | « Client » | « Client » | « Payeur ou bénéficiaire » | « Personne qui remet » et « Personne qui reçoit » |
| Contenu | « Produits ou services » | « Produits ou services proposés » | « Paiement reçu » ou contenu payé | « Somme, objet ou document remis » |
| Détails | « Paiement à recevoir » ; échéance éventuelle | durée de validité ; conditions | montant versé ; mode/référence éventuels | quantité éventuelle ; motif ; observations |
| Vérification | « Vérifiez la facture. » | « Vérifiez la proposition. » | « Vérifiez le paiement attesté. » | « Vérifiez les informations de la remise. » |
| Livraison | « Voici votre facture. » | « Voici votre devis. » | « Voici votre reçu. » | « Voici votre décharge. » |

## Remplacement des textes Meta de test

Après publication, aucune carte ne conserve « Hello! », « This is a test message to try your flow. », « Start testing your flow. » ou « This flow is only for testing. ».

| Transition | Titre | Corps | Bouton |
|---|---|---|---|
| Client compris | « Kadi » | « J'ai noté {client} comme client. Regardez ses informations avant de continuer. » | « Voir le client » |
| Client absent | « Kadi » | « Ajoutons le client avant de continuer. » | « Ajouter le client » |
| Après client | « Produits ou services » | « Client enregistré. Ajoutons maintenant les produits ou services. » | « Ajouter les articles » |
| Avant détails | « Autres détails » | « Les éléments sont enregistrés. Ajoutons les derniers détails. » | « Ajouter les détails » |
| Avant vérification | « Votre document » | « Tout est réuni. Vérifiez les informations avant de continuer. » | « Voir le document » |
| Avant aperçu | « Aperçu du document » | « Tout est prêt. Regardez le document avant sa génération. » | « Voir l'aperçu » |
| Avant coût | « Coût de génération » | « Le nombre de pages a été calculé. Regardez le coût avant de confirmer. » | « Continuer » |
| Avant génération | « Confirmer la génération » | « Votre document fera {pages} et coûtera {coût}. Aucun crédit ne sera débité avant votre confirmation. » | « Continuer » |
| Recharge | « Recharger mon compte » | « Votre document est conservé. Rechargez, puis revenez confirmer sa génération. » | « Voir les packs » |
| Historique | « Mes documents » | « Retrouvez vos brouillons et documents récents. » | « Voir mes documents » |

## Libellés Meta et longueurs

Les longueurs ci-dessous comptent les caractères visibles, espaces et apostrophes compris. Toute limite Meta exacte doit être reconfirmée dans la version du contrat utilisée avant implémentation. Par prudence, les options concernées restent à 30 caractères maximum.

| Libellé recommandé | Caractères | Usage | Statut |
|---|---:|---|---|
| Commencer | 9 | bouton | court |
| Continuer | 9 | bouton | court |
| Ajouter le client | 17 | bouton | court |
| Voir le client | 14 | bouton | court |
| Modifier le client | 18 | option/bouton | court |
| Ajouter les articles | 20 | bouton | court |
| Modifier les articles | 21 | option/bouton | remplace « Corriger les produits et services » |
| Ajouter les détails | 19 | bouton | court |
| Modifier les détails | 20 | option/bouton | court |
| Voir le document | 16 | bouton | court |
| Voir l'aperçu | 13 | bouton | court |
| Modifier | 8 | bouton | court |
| Préparer le PDF | 15 | bouton | court |
| Enregistrer pour plus tard | 26 | bouton | sous 30, limite exacte à confirmer |
| Générer le document | 19 | bouton | court |
| Recharger mon compte | 20 | bouton | court |
| Revenir à l'aperçu | 18 | bouton | court |
| Voir les packs | 14 | bouton | court |
| Voir mes documents | 18 | bouton | court |
| Rechercher | 10 | bouton | court |
| Reprendre | 9 | bouton | court |

Les titres, corps et aides ont d'autres limites que les boutons et options. Elles restent à confirmer techniquement avec le schéma Meta ciblé, le rendu mobile et la langue française avant modification des JSON.

## Entrées texte, vocal et photo

### Texte

L'utilisateur écrit librement. Kadi extrait ce qui est clair et pose une seule question sur le manque prioritaire.

### Vocal

Kadi transcrit, comprend et reformule les informations importantes. Le texte validé reste canonique ; l'audio éventuel ne change aucune valeur.

### Photo

Kadi extrait les informations visibles et distingue valeurs confirmables, incertaines, absentes et contradictoires. Exemple : « J'ai du mal à lire le prix de l'ordinateur. Quel est le montant exact ? » Une valeur incertaine n'est jamais persistée comme confirmée ni utilisée dans un total définitif.

## Questions de copie à arbitrer

| Sujet | Recommandation | Alternative 1 | Alternative 2 |
|---|---|---|---|
| Nom générique | « Produits ou services » | « Articles » dans les espaces courts | « Éléments » seulement hors commerce |
| Aperçu | « Voir l'aperçu » | « Voir le document » | « Continuer » |
| Annulation | « Conserver pour plus tard » | « Arrêter » avec confirmation | « Reprendre plus tard » |
| Recharge | texte expliquant manque et conservation | texte centré sur le pack recommandé | texte centré sur le solde |
| Devis | « durée de validité » | « valable jusqu'au » | « période de validité » |
| Reçu | « paiement reçu » | « montant versé » | formulation selon cas d'usage validé |
| Décharge | « remise » | « ce qui a été remis » | vocabulaire adapté après tests locaux |

Ces textes doivent être validés par tests utilisateurs avant publication ; aucune alternative n'est sélectionnée silencieusement.
