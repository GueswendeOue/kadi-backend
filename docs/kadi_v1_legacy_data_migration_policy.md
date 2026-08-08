# Kadi V1 — Politique de migration des données historiques

## Objet et portée

Cette politique définit comment préparer les données existantes à l'architecture V1 sans créer de SQL ni supposer l'état du Supabase déployé. Elle couvre profils, wallets, ledger, paiements, documents, PDF, sessions Flow, champs historiques de tampon et statuts incomplets.

Les schémas distants, RPC, contraintes, RLS, volumes et qualités de données restent `UNKNOWN_REQUIRES_RUNTIME_CHECK` tant qu'un audit autorisé n'en a pas produit une preuve anonymisée. Les modules du dépôt montrent plusieurs générations de stockage (`business_profiles`, `kadi_wallets`, `kadi_documents`, `kadi_topups` et sessions facture), mais ne suffisent pas à décrire la base réelle.

**Exception confirmée (T10 R1, 2026-08-09) : `kadi_topups`.** Une
inspection en lecture seule autorisée a levé `UNKNOWN_REQUIRES_RUNTIME_CHECK`
pour le contrat de colonnes de cette seule table : `id uuid`, `wa_id
text`, `reference text`, `amount_fcfa integer`, `credits integer`,
`includes_stamp boolean`, `status text`, `proof_text text`,
`proof_image_url text`, `payment_method text`, `created_at
timestamptz`, `updated_at timestamptz`, `approved_at timestamptz`,
`rejection_reason text` — RLS activé. Fait confirmé et significatif :
**`reference` n'a aucune contrainte d'unicité** — seule la clé primaire
`id` l'est. L'inspection a trouvé, en forme agrégée/anonymisée
uniquement, exactement un groupe de références dupliquées préexistant
(2 lignes, toutes deux legacy/non-V1, toutes deux `pending`) ; **sa
valeur réelle n'est consignée nulle part dans ce dépôt** et ces lignes
n'ont été ni modifiées ni supprimées. Voir la fiche AC de
`docs/KADI_ENGINEERING_MEMORY.md` pour le détail complet. Cette
exception ne s'étend à aucune autre table : RPC, RLS détaillée, volumes
et qualité de données au-delà de ce contrat de colonnes/unicité
restent `UNKNOWN_REQUIRES_RUNTIME_CHECK` pour `kadi_topups` comme pour
toutes les autres tables listées ci-dessous.

## Invariants obligatoires

* Aucun utilisateur historique ne reçoit automatiquement cinq nouveaux crédits.
* Aucun solde n'est recalculé depuis zéro ni remplacé par une valeur dérivée incomplète.
* Aucun document ou PDF historique n'est supprimé, renuméroté ou écrasé.
* Aucune session ancienne ne devient automatiquement un document final.
* Toute identité, propriété ou attribution ambiguë est placée en audit, jamais devinée.
* Les écritures wallet et paiements historiques restent traçables.
* Les champs historiques de tampon peuvent être archivés mais ne réactivent aucune fonctionnalité V1.
* Toute migration est additive et réversible lorsque possible ; une irréversibilité exige sauvegarde, répétition et approbation explicite.
* Aucun rapport de migration n'expose `wa_id`, téléphone, données client, contenu documentaire, token ou secret.

## Sources à inventorier avant toute migration

| Domaine | Preuves visibles dans le dépôt | Vérification runtime requise |
|---|---|---|
| Profils | `store.js` utilise `business_profiles`, `wa_id`, BSUID, `welcome_credits_granted`, onboarding et attributs historiques | colonnes, unicité, doublons d'identité, nulls, RLS, dates et provenance |
| Crédits | `kadiCreditsRepo.js` utilise des RPC v2 et `kadi_wallets`; `billingRepo.js` expose une ancienne interface | tables ledger réelles, unités, raisons, clés idempotentes, soldes et cohérence RPC |
| Bienvenue | `kadiOnboarding.js` utilise un montant configurable et une clé historique différente de la cible | anciens bonus, écritures associées, marqueurs vrais/faux/null et dates de profil |
| Paiements | `kadiPaymentsRepo.js` utilise `kadi_topups`; validations historiques partielles | statuts, références fournisseur, preuves, doublons et crédits associés |
| Documents | `kadiRepo.js` et `kadiHistoryRepo.js` utilisent `kadi_documents` avec champs structurés et `raw` | volumes par type/statut, numéros, propriétaire, doublons, totaux, fichiers et contraintes |
| PDF et médias | références média, nom, légende et stockage dans les repos/messagerie | existence, empreinte, accessibilité, propriété, orphelins et politique de rétention |
| Sessions Flow | migrations facture suivies et `kadiInvoiceFlowSession.js` | sessions actives, expirées, révoquées, sans cible et liens vers drafts |
| Drafts facture | migration et service de brouillon facture | propriétaires, expirations, statuts, items, actions traitées et compatibilité avec le domaine V1 |
| Tampon | champs historiques dans profil/document et anciens modules | présence, références de fichiers et coûts historiques à préserver en lecture seule |

## Classification préalable des lignes

Chaque enregistrement reçoit une classification de migration sans modifier sa signification :

* `READY` : propriétaire, type, statut et références cohérents ; migration automatisable.
* `READY_WITH_LEGACY_PROJECTION` : lisible par une projection de compatibilité sans réécriture du contenu.
* `AMBIGUOUS_REQUIRES_AUDIT` : identité, bonus, solde, statut ou propriété non prouvés.
* `ORPHANED_REFERENCE` : fichier, paiement, session ou document référence une entité absente.
* `INACTIVE_PRESERVE_ONLY` : état terminal ou obsolète conservé pour historique, non repris dans le parcours actif.

Les compteurs par classe sont anonymisés. Une ligne ambiguë n'est ni fusionnée, ni créditée, ni finalisée automatiquement.

## Politique par domaine

### Profils existants

1. Conserver l'identifiant historique et toutes les références entrantes.
2. Utiliser `wa_id` comme identité opérationnelle lorsqu'il est présent et valide, sans fusionner automatiquement deux profils concurrents.
3. Conserver BSUID et téléphone normalisé comme alias/provenance, pas comme preuve suffisante d'une fusion.
4. Ajouter les futurs champs de manière additive avec une provenance ou un état `UNKNOWN` lorsque l'historique ne permet pas de conclure.
5. Mapper l'ancien onboarding vers un état V1 seulement si la preuve est déterministe ; sinon `ONBOARDING_IN_PROGRESS` ou audit, jamais `ONBOARDING_COMPLETED` par défaut.
6. Ne pas considérer un profil sans document comme un nouvel utilisateur.

### Bonus de bienvenue

La décision KFD-001 reste applicable, mais aucun backfill aveugle n'est autorisé.

Pour chaque profil historique, rapprocher sans exposer ses données :

* `welcome_credits_granted` actuel ;
* écritures ledger pouvant correspondre à un bonus ;
* clés d'opération historiques, dont celles antérieures au namespace cible ;
* date de création du profil ;
* anciens bonus ou campagnes ;
* écritures de crédit et documents déjà produits.

Règles de classement :

| Situation prouvée | Politique |
|---|---|
| bonus déjà attribué | conserver le mouvement, établir le marqueur vrai sans nouveau crédit si une migration approuvée le permet |
| marqueur vrai, écriture identifiable | conserver les deux et enregistrer le rapprochement |
| marqueur vrai, écriture introuvable | `AMBIGUOUS_REQUIRES_AUDIT`, aucun nouveau crédit |
| marqueur faux/null mais bonus historique possible | `AMBIGUOUS_REQUIRES_AUDIT`, aucun nouveau crédit |
| solde nul | aucune conclusion sur l'éligibilité |
| profil réellement créé après la bascule V1 et jamais crédité | le service transactionnel normal décide, pas la migration historique |

### Wallet, ledger et soldes

* Sauvegarder les totaux et comptages avant transformation.
* Préserver chaque écriture avec identifiant, raison, montant, date et référence d'origine lorsque disponibles.
* Ne jamais reconstruire un solde en ignorant les écritures inconnues ou une ancienne interface.
* Si solde matérialisé et somme du ledger divergent, conserver les deux preuves, bloquer la mutation du profil concerné et auditer.
* Introduire les nouveaux namespaces de raisons/idempotence sans renommer destructivement les anciennes clés.
* Une correction financière future passe par une écriture d'ajustement approuvée, jamais par modification silencieuse de l'historique.

### Paiements et recharges

* Conserver statuts, montants, preuves, opérateur et références historiques.
* Dédupliquer uniquement sur une référence fournisseur ou une preuve métier forte.
* Un paiement ancien `pending` ne devient pas `confirmed` par migration.
* Un paiement confirmé sans écriture wallet associée est audité ; il n'est pas recrédité automatiquement.
* Les reprises V1 ne s'activent que pour une recharge liée sans ambiguïté à un document et un utilisateur.

### Documents et versions

* Conserver `doc_number`, type, statut, propriétaire, dates, totaux, contenu `raw` et références fichier.
* Ne jamais appliquer la future numérotation aux documents historiques.
* Créer, si nécessaire, une projection ou version d'import portant une provenance `legacy`, sans prétendre que tous les champs V1 étaient présents.
* Recalculer à des fins d'audit peut signaler une différence, mais ne remplace jamais silencieusement le total historique.
* Une donnée manquante reste absente ou incertaine ; elle n'est pas inventée depuis le PDF ou l'IA.
* Un document historique incomplet reste consultable selon les droits, mais n'est pas marqué final V1 sans preuve.
* Les doublons potentiels sont liés pour audit, pas supprimés.

### PDF et médias historiques

* Conserver l'objet original, son emplacement, son nom et sa relation au document.
* Calculer ultérieurement une empreinte sans réencoder ni remplacer le fichier.
* Un fichier manquant devient `ORPHANED_REFERENCE`; le document n'est pas supprimé.
* Une relivraison historique utilise le fichier existant si autorisé ; elle ne déclenche ni régénération ni débit.
* Aucune migration n'applique le nouveau tarif par pages aux fichiers déjà générés.

### Sessions Flow et brouillons en cours

* Les sessions actives restent lisibles jusqu'à expiration si le backend déployé les comprend.
* Une session expirée, révoquée, consommée, sans propriétaire ou sans cible ne revient pas à l'état actif.
* Une session ancienne sans cible explicite est rejetée fail-closed conformément au service actuel.
* Aucun token n'est copié dans les rapports ou les nouvelles tables en clair.
* Un brouillon facture peut être projeté vers le futur domaine seulement avec propriétaire, statut et version contrôlés.
* Une session ne finalise jamais un brouillon par migration ; l'utilisateur reprend depuis un dernier état sûr ou recommence une session, sans nouveau bonus.

### Champs de tampon

* Conserver les valeurs et fichiers historiques uniquement pour audit ou restitution d'un document ancien.
* Marquer ces champs comme hérités/inactifs dans les projections V1.
* Ne pas copier leur coût dans une quote V1, ne pas afficher d'action et ne pas les appliquer à un nouveau PDF.
* Une purge future de fichiers de tampon exige une politique de rétention distincte et approuvée.

### Anciens statuts et données incomplètes

Le mapping de statut doit être explicite, versionné et testable. Un statut inconnu devient une projection `LEGACY_UNKNOWN` ou une classe d'audit ; il n'est jamais converti par défaut en `GENERATED`, `DELIVERED` ou `CANCELLED`.

Les données incomplètes restent visibles comme historiques. Leur édition éventuelle crée un brouillon/version V1 distinct après confirmation de l'utilisateur et ne modifie pas l'original.

## Déroulement obligatoire d'une future migration

### Phase 0 — Décisions et gel

* Faire approuver KFD-101, KFD-102, KFD-103, KFD-104, KFD-105, KFD-106, KFD-107 et KFD-108 selon les lots concernés.
* Geler les écritures ou prévoir une stratégie de double écriture bornée.
* Identifier schéma, RPC, RLS, contraintes, volumes et dépendances réels.

### Phase 1 — Sauvegarde et répétition

* Produire une sauvegarde restaurable et vérifier sa restauration dans un environnement isolé.
* Exécuter un dry-run sur une copie anonymisée représentative.
* Calculer les comptages et empreintes de référence sans données personnelles.

### Phase 2 — Extension additive

* Ajouter structures, contraintes différables et index nécessaires sans supprimer ni renommer les sources.
* Déployer d'abord un backend compatible avec les anciennes et nouvelles représentations lorsque l'ordre de déploiement l'exige.
* Conserver une table ou un journal de correspondance technique avec statut, version de migration et erreur assainie.

### Phase 3 — Projection et backfill contrôlé

* Traiter par lots idempotents et reprenables.
* Ne migrer automatiquement que `READY` et `READY_WITH_LEGACY_PROJECTION`.
* Isoler les autres classes dans une file d'audit sans bloquer les données saines.
* Réexécuter un lot sans créer de profil, crédit, document ou fichier supplémentaire.

### Phase 4 — Vérifications

Comparer avant/après :

* profils et identités par classe ;
* somme des soldes et distribution des écarts, sans afficher d'identité ;
* nombre et somme des mouvements ledger par raison ;
* paiements par statut et montant ;
* documents par type/statut, numéros distincts et propriétaires ;
* fichiers présents, références orphelines et empreintes ;
* sessions par statut et expiration ;
* bonus de bienvenue prouvés, ambigus et nouvellement accordés — ce dernier compteur doit rester zéro pour l'historique ;
* lignes de tampon conservées en héritage et absentes des chemins V1.

Tout écart inexpliqué bloque la bascule.

### Phase 5 — Bascule et observation

* Activer la lecture V1 par feature flag ou cohorte interne.
* Surveiller doubles crédits, doubles débits, changements de solde, documents manquants et erreurs de propriété.
* Garder l'ancien chemin en lecture pendant la période de vérification approuvée.
* Ne déprécier une source qu'après preuve de parité et fenêtre de rollback écoulée.

## Réversibilité et rollback

Le rollback doit désactiver les nouveaux chemins et revenir à la lecture historique sans supprimer les structures ajoutées. Il ne doit jamais :

* effacer une écriture financière déjà créée ;
* remettre `welcome_credits_granted` à faux ;
* réutiliser un numéro ;
* supprimer un fichier final ;
* réactiver une session expirée ;
* rejouer un bonus, débit, paiement ou génération.

Les écritures nouvelles déjà validées restent la source financière d'audit. Si une étape est irréversible, la procédure documente précondition, point de non-retour, compensation et responsable d'approbation avant exécution.

## Gate de migration

La migration ne peut commencer que si :

1. les décisions fondatrices bloquant LOT 2 sont approuvées ;
2. l'inventaire runtime et la sauvegarde restaurable sont prouvés ;
3. les règles d'identité, propriété et RLS sont testées ;
4. le traitement des bonus historiques ne crée aucun crédit automatique ;
5. les invariants financiers ont une réconciliation avant/après ;
6. les mappings de documents et statuts sont versionnés ;
7. le dry-run, l'idempotence et le rollback sont validés ;
8. une procédure d'audit manuel existe pour les cas ambigus.

## Décisions encore nécessaires

* KFD-101 : contenu exact du profil minimal et valeur de migration des champs absents.
* KFD-106 : portée de la future numérotation, sans renumérotation historique.
* KFD-107 : représentation d'une correction post-génération.
* KFD-108 : primitive financière de réservation/capture/libération.
* Durée de double lecture et critères de dépréciation des tables/interfaces anciennes.
* Politique de rétention des médias historiques, y compris les anciens fichiers de tampon.

Ces décisions n'autorisent aucune migration tant qu'elles ne sont pas approuvées dans le registre.
