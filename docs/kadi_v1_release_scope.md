# Kadi — Périmètre canonique de la V1

## Objet

La V1 est une expérience administrative conversationnelle complète, pas une démonstration de facture. Elle doit permettre à un utilisateur de comprendre la valeur de Kadi, préparer plusieurs types de documents, vérifier les données, connaître le coût réel, confirmer, payer si nécessaire, recevoir le PDF et retrouver son travail.

La facture actuelle reste une preuve technique jusqu'à validation de toute l'expérience décrite ici. Aucun Flow supplémentaire ne doit être publié avant le passage complet du release gate.

## Principes de lancement

* Une seule assistante est visible, même lorsque plusieurs composants ou Flows interviennent.
* Le langage naturel est l'entrée principale ; le menu est un raccourci.
* Texte, vocal et photo sont des modalités d'entrée, jamais des services séparés.
* Kadi demande uniquement les informations manquantes, une question utile à la fois.
* Le backend reste l'autorité pour calculs, états, dates, numéros, crédits, paiements, génération et livraison.
* Aucune donnée incertaine n'est persistée comme confirmée.
* Aucun débit avant pages réelles, coût affiché et confirmation explicite.
* Aucun débit ni PDF final en mode `DRAFT`.

## Obligatoire au lancement

| Capacité | Résultat utilisateur minimal |
|---|---|
| Onboarding progressif | premier accueil texte et court vocal, 5 crédits attribués une fois côté serveur, action unique « Commencer », puis profil facultatif progressif |
| Accueil et menu | comprendre quoi demander et accéder aux quatre raccourcis validés |
| Compréhension naturelle | demander un document avec ses propres mots |
| Texte | transmettre toutes les informations en conversation |
| Vocal | faire transcrire, comprendre et reformuler les données importantes |
| Photo | extraire les données visibles, signaler toute incertitude et demander confirmation |
| Facture | préparer un paiement à recevoir avec client, lignes et options pertinentes |
| Devis | préparer une proposition commerciale avec validité à arbitrer |
| Reçu | attester un paiement déjà reçu sans reprendre le vocabulaire d'une créance |
| Décharge | décrire remettant, receveur, somme/bien/document et motif |
| Vérification et corrections | voir toutes les données et modifier client, contenu ou détails sans perte |
| Aperçu structuré | examiner le document complet avant préparation du PDF |
| Rendu temporaire | produire un artefact non livré pour compter les pages |
| Coût exact | afficher pages, coût et solde depuis les règles centrales |
| Confirmation | obtenir un accord explicite avant tout débit |
| Recharge | conserver le brouillon et reprendre au même endroit après paiement vérifié |
| Génération | débiter une seule fois et créer un PDF final lié à une version immuable |
| Livraison | envoyer le document final et permettre une reprise sans nouveau débit |
| Historique et recherche | retrouver ses propres brouillons et documents selon les droits du statut |
| Reprise | continuer après interruption, expiration ou échec récupérable |
| Aide | expliquer simplement quoi envoyer et comment reprendre |
| Sécurité | protéger propriété, données sensibles, idempotence et confidentialité vocale |

## Recommandé au lancement

| Capacité | Valeur | Condition |
|---|---|---|
| Réponses vocales sélectives | accessibilité et naturel | texte canonique, préférence et Voice Policy Engine validés |
| Recherche par plusieurs critères | accès rapide aux documents | pagination, propriété et libellés mobiles validés |
| Sauvegarde explicite pour plus tard | confiance lors d'une interruption volontaire | reprise fiable depuis l'état persistant |
| Résumé vocal des étapes complexes | compréhension du coût ou d'un document | aucune donnée sensible lue automatiquement |
| Aide contextuelle par étape | diminution des abandons | une seule prochaine action claire |
| Suggestions de correction ciblées | réduire les reprises complètes | aucune valeur incertaine imposée |

Une capacité recommandée peut être désactivée au lancement seulement si le parcours reste cohérent, accessible et conforme au release gate.

La ligne « Réponses vocales sélectives » concerne les réponses ordinaires. Le court vocal du premier accueil est obligatoire pour l'expérience cible et suit la règle de repli non bloquante vers le texte.

## Améliorations post-V1

* langues supplémentaires après validation locale, notamment mooré ;
* voix personnalisée uniquement avec consentement approuvé ;
* conversion contrôlée d'un devis accepté en facture ;
* avoirs, annulations avancées et documents correctifs ;
* recherche enrichie et archivage étendu ;
* automatisations récurrentes ;
* signatures ou attestations numériques pour les décharges ;
* partage multi-utilisateur et rôles d'entreprise ;
* tableaux de bord avancés ;
* recommandations proactives basées sur des règles approuvées.

## Parcours minimum par type

### Facture

Comprendre le besoin → client → produits ou services → paiement à recevoir et échéance éventuelle → vérification → aperçu → pages et coût → confirmation → génération → livraison → historique.

### Devis

Comprendre la proposition → client → produits ou services → durée et conditions → vérification → aperçu → pages et coût → confirmation → génération → livraison → historique. L'acceptation et la conversion futures restent hors V1 tant qu'elles ne sont pas spécifiées.

### Reçu

Comprendre le paiement déjà reçu → payeur ou bénéficiaire → montant ou contenu → mode et référence éventuels → vérification → aperçu → pages et coût → confirmation → génération → livraison → historique.

### Décharge

Comprendre la remise → personne qui remet → personne qui reçoit → somme, bien ou document → quantité éventuelle, motif et observations → vérification → aperçu → pages et coût → confirmation → génération → livraison → historique.

## Release gate

La V1 n'est prête que si :

1. tous les textes français visibles sont validés et aucun texte de test Meta ne subsiste ;
2. facture, devis, reçu et décharge passent leurs parcours complets ;
3. texte, vocal et photo gèrent données complètes, partielles et incertaines ;
4. corrections et reprises ne perdent ni ne dupliquent les données ;
5. aperçu, rendu temporaire, pages, coût, solde et confirmation sont cohérents ;
6. recharge reprend exactement le document concerné sans double crédit ;
7. débit, génération et livraison sont idempotents ;
8. historique et recherche respectent la propriété ;
9. texte et audio restent fidèles et les données sensibles ne sont pas lues automatiquement ;
10. les interfaces sont validées sur plusieurs tailles d'écran et conditions réseau ;
11. aucun Flow n'est publié partiellement pour contourner un défaut d'expérience ;
12. les critères de `docs/kadi_user_journey_acceptance_criteria.md` sont satisfaits.
13. le premier accueil annonce les 5 crédits seulement après leur attribution atomique et reste utilisable si le vocal échoue.

## Hors périmètre implicite

La V1 ne promet pas silencieusement : fiscalité automatisée, conformité juridique universelle, signature électronique, conversion devis-facture, annulation comptable, voix locale définitivement sélectionnée, langue autre que celles validées, stockage audio durable ou tarification non approuvée.

## Décisions à arbitrer

| Sujet | Recommandation | Alternative 1 | Alternative 2 |
|---|---|---|---|
| Menu | quatre actions canoniques | menu réduit à trois actions | menu enrichi après usage |
| Nom du contenu | « Produits ou services » dans la conversation | « Articles » dans les écrans compacts | « Éléments » pour la décharge uniquement |
| Bouton d'aperçu | « Voir l'aperçu » | « Voir le document » | « Continuer » si la carte explique l'étape |
| Vocal maximal | court, segmentable, limite après benchmark | limite fixe | limite par type de message |
| Voix par défaut | `VOICE_WHEN_HELPFUL` | `TEXT_ONLY` | choix explicite à l'onboarding |
| Historique initial | derniers documents avec recherche | recherche d'abord | liste par type |
| Nombre de documents | valeur configurée et paginée | cinq derniers | dix derniers |
| Annulation | conserver le brouillon sauf suppression explicite future | marquer annulé | demander confirmation de conservation |
| Recharge | expliquer manque, conservation et reprise | mettre le pack recommandé en avant | afficher tous les packs équitablement |
| Textes par type | variantes explicites par finalité | tronc commun avec une phrase spécifique | catalogue entièrement séparé |

Aucune recommandation de ce tableau ne devient une règle finale sans validation produit.
