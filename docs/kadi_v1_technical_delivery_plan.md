# Kadi V1 — Plan technique de livraison

## Principes d'exécution

* Construire par adaptation : préserver webhook, crypto Flow, médias, validateurs, renderers et RPC sûrs.
* Chaque lot produit un contrat testable et un rollback avant d'ouvrir le suivant.
* Les nouveaux chemins restent derrière des flags et utilisent des données versionnées.
* Aucune publication Meta partielle : tous les Flows restent `DRAFT` jusqu'au lot 15.
* Aucun backfill, débit, crédit ou changement de statut sans idempotence et preuve d'audit.

## Architecture technique cible

| Composant | Responsabilité | Entrées → sorties | Persistance | Dépendances | Frontière de sécurité et interface existante |
|---|---|---|---|---|---|
| Conversation Orchestrator | choisir une seule prochaine action et absorber les complétions | événement WhatsApp + contexte → commande métier/réponse | curseur conversationnel minimal | domaine, brain, flows | verrou par utilisateur ; remplace progressivement les branches de `kadiEngine.js` |
| Kadi Brain Provider Interface | normaliser compréhension multimodale | contenu validé + schéma → candidats, incertitudes, provenance | aucune vérité métier | providers IA | sortie non autoritaire et validée ; enveloppe `kadiOpenAI.js`/`kadiGemini.js` |
| OpenAI Provider | conversation, transcription et voix selon config | requête provider → résultat contractuel | métriques non sensibles | interface brain/voice | timeout, budget, redaction ; aucun accès wallet |
| Gemini Provider | vision, OCR, documents et extraction structurée | média + contrat → valeurs et incertitudes | métriques/provenance autorisée | interface brain | aucun calcul final ; adapte `kadiGemini.js` |
| Vision/OCR Pipeline | valider média, extraire et demander confirmation | image/PDF → champs confirmés/incertains/absents/contradictoires | candidats et source selon rétention | Gemini, stockage | limites type/taille/propriété ; adapte `kadiOcrFlow.js` |
| Speech-to-Text Pipeline | transformer un vocal en texte candidat | média audio → transcription + confiance | transcription selon rétention | OpenAI Provider | validation média, aucune instruction interne ; adapte `kadiAudio.js` |
| Voice Policy Engine | décider `TEXT_ONLY` ou `TEXT_AND_VOICE` | préférence, sensibilité, contexte → décision déterministe | motif non sensible | préférences, VoiceProvider | la confidentialité domine ; aucun débit métier |
| Voice Provider Interface | synthétiser uniquement le texte validé | texte/version/style → audio WhatsApp | artefact dérivé court | provider configuré | clé idempotente, pas de clonage non consenti |
| Document Domain Service | porter les invariants des quatre documents | commandes validées → agrégat/version/événements | documents, versions, items | state machine | propriété et recalcul serveur ; adapte calculateurs/drafts |
| Document State Machine | autoriser les transitions et reprises | état + événement + version → nouvel état | état courant et événement | domaine, idempotence | compare-and-set ; interdit débit/génération prématurés |
| Shared Document Flow Router | ouvrir le Flow fonctionnel adapté | cible + référence pseudonyme → message Flow | session Flow | orchestrateur, domaine | aucun PII initial ; adapte sessions facture |
| Preview Service | produire la projection lisible versionnée | version vérifiée → aperçu | previews | domaine | aucun débit ; invalidation sur modification |
| Temporary Render Service | rendre sans livrer pour compter | aperçu/version → artefact temporaire + pages | temporary_renders | renderers PDF, storage | non téléchargeable publiquement ; adapte dry-run |
| Generation Cost Service | calculer un devis exact | rendu/pages + tarif → quote | generation_quotes | config tarifaire, wallet lecture | aucun débit ; expiration et empreinte de version |
| Wallet/Ledger Service | lire et muter les crédits atomiquement | opération + clé → solde/ledger | wallet, ledger | RPC/DB | une façade unique ; adapte `kadiCreditsRepo.js` |
| Recharge Service | créer, vérifier et reprendre une recharge | pack + paiement → crédit/reprise | recharge_sessions, ledger | paiement/webhook | webhook authentique, déduplication fournisseur |
| Final Generation Service | figer la version et générer une fois | confirmation + débit → fichier immuable | attempts, final_files | renderer, wallet, domaine | saga idempotente ; adapte `kadiPdfFlow.js` |
| Delivery Service | livrer ou relivrer le même fichier | fichier + destinataire autorisé → tentative | delivery_attempts | WhatsApp médias | aucune régénération ni second débit |
| History/Search Service | lister/rechercher les données autorisées | propriétaire + filtres → résultats paginés | index/métadonnées | documents, storage | filtrage propriétaire ; adapte historique actuel |
| User Preference Service | gérer langue et voix sans ré-onboarding | commande utilisateur → préférence | profil/préférences | orchestrateur | consentement et valeurs fermées |
| Welcome Credits Service | accorder exactement 5 une fois | `wa_id` + profil minimal → ledger/marqueur | profil, ledger, idempotence | wallet, onboarding | transaction unique `welcome_credits:<wa_id>` |
| Idempotency Service | dédupliquer toutes les opérations rejouables | scope + clé + empreinte → résultat stable | idempotency_records | tous services sensibles | payload hash, statut, TTL/rétention, aucune PII en clé |
| Audit/Event Log | corréler les faits sans secret | événement métier assaini → trace | document_events/audit | tous composants | liste fermée, identifiants pseudonymes, rétention |

## Données et migrations pressenties

Aucun SQL n'est défini ici. Les noms sont des recommandations à valider contre le schéma Supabase réel.

| Objet | Champs/contraintes/index potentiels | Compatibilité et migration |
|---|---|---|
| `business_profiles` ou `kadi_users` | `wa_id` unique, `onboarding_status`, `welcome_credits_granted`, dates d'événements, version | étendre la table existante ; ne jamais recréer un profil à partir du seul numéro affiché |
| `user_preferences` | `profile_id` unique, `voice_response_mode`, locale, consentements, version | défaut explicite pour anciens profils ; aucune voix automatique sensible |
| `documents` | id, propriétaire, type, état, version courante, numéro, `issued_at`, devise | mapper `kadi_documents` ; conserver références et nombres historiques |
| `document_versions` | document, version unique, snapshot normalisé, hash, auteur/événement | créer une version initiale depuis `raw` sans modifier le fichier historique |
| `document_items` | version/document, `item_id` stable, position, quantité, unité, prix | préserver l'ordre et les valeurs ; ne pas dédupliquer sur libellé seul |
| `document_events` | document, type, clé, état avant/après, horodatage, métadonnées assainies | index document/date et clé unique si événement idempotent |
| `previews` | document/version unique, projection, statut, hash | invalidation plutôt que suppression lors d'une édition |
| `temporary_renders` | version, objet storage, pages, expiration, hash, statut | bucket privé et purge ; jamais exposé comme fichier final |
| `generation_quotes` | version/render, pages, tarif, coût, solde observé, expiration | unique par empreinte/tarif actif ; quote obsolète non réutilisable |
| `generation_attempts` | quote, clé, état débit/génération, erreurs récupérables | verrou unique ; reprise de saga sans second débit |
| `final_files` | document/version, storage id, hash, taille, pages, statut | immutable ; lien vers médias historiques si vérifiable |
| `kadi_wallets` | profil unique, solde non négatif, version | réutiliser après audit ; aucune remise à zéro |
| `kadi_credit_ledger` | profil, montant signé, reason, operation_key unique, meta assainie | vérifier RPC v2 ; backfill uniquement depuis preuves existantes |
| `idempotency_records` | scope/key unique, request hash, résultat, statut, expiration | scopes séparés welcome, Flow, paiement, génération, livraison, voix |
| `recharge_sessions` | profil, pack snapshot, provider ref unique, statut, reprise document | adapter `kadi_topups`, conserver les preuves manuelles historiques |
| `delivery_attempts` | final_file, canal, message ref, statut, tentative | index fichier/statut ; relivraison sans regénération |
| métadonnées recherche | type, client normalisé, numéro, date, statut, tokens autorisés | index ciblés ; aucune fuite inter-propriétaire |

### Stratégie pour les données existantes

1. Snapshot et comptages anonymisés avant migration.
2. Ajouter les colonnes nullable/défauts sûrs, puis déployer un runtime compatible ancien/nouveau.
3. Identifier les bonus via ledger, anciens reasons, marqueur et date de profil ; les cas ambigus restent non éligibles en attente de revue.
4. Ne jamais modifier le solde pendant un backfill de statut.
5. Créer des projections de documents historiques avec clé source unique ; ne jamais dupliquer le PDF.
6. Laisser expirer les sessions Flow anciennes ou les révoquer explicitement ; ne pas changer leur sens en place.
7. Backfill par lots bornés, journalisés et réexécutables, avec comptage avant/après.

## Plan d'implémentation par lots

### LOT 0 — Baseline, sauvegarde et observabilité

* **Objectif :** figer inventaire, métriques, schéma runtime et parcours actuels.
* **Prérequis :** accès lecture Supabase/Render/Meta et jeu de comptes fictifs.
* **Fichiers probables :** audit logger, health diagnostics, runbooks, tests de caractérisation.
* **Migration :** aucune mutation ; export/snapshot approuvé.
* **Tests ciblés :** webhook, crypto, facture actuelle, PDF/historique, redaction.
* **Acceptation :** métriques anonymisées, sauvegarde restaurable, 248 tests de référence ou nouvelle baseline expliquée.
* **Rollback :** suppression des seuls flags/diagnostics nouveaux.
* **Hors périmètre :** changement produit.
* **Dépendance suivante :** fournit les preuves de compatibilité aux lots 1–2.

### LOT 1 — Domaine documentaire et machine d'états

* **Objectif :** implémenter agrégats, commandes, événements et transitions sans I/O externe.
* **Prérequis :** LOT 0 et contrats documentaires validés.
* **Fichiers probables :** nouveaux modules `domain/`, adaptateurs calculateurs/décharge.
* **Migration :** aucune au début.
* **Tests ciblés :** quatre types, versions, transitions interdites, calculs déterministes.
* **Acceptation :** domaine pur, aucune dépendance Meta/IA/wallet.
* **Rollback :** flag désactivé, anciens parcours inchangés.
* **Hors périmètre :** UI, PDF, paiement.
* **Dépendance suivante :** définit le schéma persistant du LOT 2.

### LOT 2 — Persistance et migrations

* **Objectif :** tables/versioning/idempotence et adaptateurs legacy.
* **Prérequis :** modèle LOT 1, audit du schéma réel.
* **Fichiers probables :** migrations versionnées, repositories, scripts de pre/postcheck.
* **Migration :** additive, runtime backward-compatible, backfill séparé.
* **Tests ciblés :** migration vide/peuplée, contraintes, RLS, concurrence, rollback logique.
* **Acceptation :** comptages stables, aucun solde/document perdu, anciennes sessions sûres.
* **Rollback :** désactiver le nouveau chemin ; ne supprimer aucune donnée créée sans analyse.
* **Hors périmètre :** crédit welcome effectif.
* **Dépendance suivante :** stockage des sorties contrôlées et onboarding.

### LOT 3 — Kadi Brain et fournisseurs IA

* **Objectif :** interfaces provider, schémas de sortie, budgets, timeouts et fallback.
* **Prérequis :** contrats LOT 1.
* **Fichiers probables :** providers/adapters autour des modules OpenAI/Gemini existants.
* **Migration :** configuration seulement, aucune donnée métier.
* **Tests ciblés :** mocks, erreurs, JSON hostile, incertitudes, absence d'autorité métier.
* **Acceptation :** aucun nouveau parcours métier n'importe un SDK fournisseur.
* **Rollback :** provider adapter vers comportement actuel.
* **Hors périmètre :** OCR/TTS live complets.
* **Dépendance suivante :** LOT 4 et LOT 11–12.

### LOT 4 — Onboarding, accueil vocal et cinq crédits

* **Objectif :** profil minimal, bonus atomique, texte canonique et tentative vocale non bloquante.
* **Prérequis :** LOT 2, façade wallet, idempotence ; VoiceProvider peut être stub texte seul.
* **Fichiers probables :** onboarding, welcome service, préférences, orchestration.
* **Migration :** marqueur/état/ledger et audit historique.
* **Tests ciblés :** concurrence, webhooks doubles, solde nul, anciens profils, panne TTS.
* **Acceptation :** exactement 5 et une écriture ; aucune réattribution.
* **Rollback :** désactiver nouvel accueil, conserver ledger déjà écrit.
* **Hors périmètre :** campagne de bonus rétroactive.
* **Dépendance suivante :** identité stable pour les documents.

### LOT 5 — Pipeline partagé facture/devis/reçu

* **Objectif :** conversation → contenu → vérification pour trois types.
* **Prérequis :** LOT 1–4.
* **Fichiers probables :** orchestrateur, domain service, shared Flow router, adaptateurs des sept Flows.
* **Migration :** documents/versions/items selon LOT 2.
* **Tests ciblés :** trois types, corrections, retries, interruptions, propriété.
* **Acceptation :** mêmes invariants, textes adaptés et aucune perte de données.
* **Rollback :** router par flag vers parcours historique.
* **Hors périmètre :** génération finale.
* **Dépendance suivante :** LOT 6 et aperçu.

### LOT 6 — Parcours spécifique décharge

* **Objectif :** remettant, receveur, somme/bien/document et motif.
* **Prérequis :** LOT 1–5.
* **Fichiers probables :** adaptateur `kadiDecharge.js`, domaine et Flow spécifique.
* **Migration :** snapshot/version propre à la décharge.
* **Tests ciblés :** unions de sujet, quantités, corrections, aucune terminologie panier imposée.
* **Acceptation :** rejoint review/preview commun sans perdre son modèle.
* **Rollback :** ancien parcours décharge sous flag.
* **Hors périmètre :** signatures futures.
* **Dépendance suivante :** quatre types disponibles au LOT 7.

### LOT 7 — Preview, rendu temporaire et calcul du coût

* **Objectif :** aperçu versionné, PDF temporaire, pages réelles et quote.
* **Prérequis :** LOT 5–6 et renderers audités.
* **Fichiers probables :** preview/render/quote services, généralisation du dry-run.
* **Migration :** previews, temporary_renders, generation_quotes.
* **Tests ciblés :** 1/2/3+ pages, invalidation, tarifs, absence débit/livraison.
* **Acceptation :** coût exact affichable pour les quatre types.
* **Rollback :** supprimer artefacts temporaires, revenir à brouillon sans débit.
* **Hors périmètre :** débit et fichier final.
* **Dépendance suivante :** quote fiable pour LOT 8.

### LOT 8 — Débit idempotent, génération et livraison

* **Objectif :** confirmer, débiter une fois, générer une fois, livrer/reprendre.
* **Prérequis :** LOT 7, wallet audité, stockage privé.
* **Fichiers probables :** generation saga, delivery service, adaptation `kadiPdfFlow.js`.
* **Migration :** generation_attempts, final_files, delivery_attempts.
* **Tests ciblés :** timeout à chaque frontière, concurrence, rollback/compensation, relivraison.
* **Acceptation :** aucun débit avant confirmation ; fichier immuable lié à version.
* **Rollback :** désactiver nouvelles confirmations ; reprendre opérations engagées par clé.
* **Hors périmètre :** nouvelle tarification non approuvée.
* **Dépendance suivante :** reprise après recharge.

### LOT 9 — Recharge et reprise

* **Objectif :** paiement vérifié, crédit unique et retour au même document.
* **Prérequis :** LOT 2, 7, 8 et contrat fournisseur approuvé.
* **Fichiers probables :** recharge service, webhook paiement, Flow Recharge.
* **Migration :** adapter topups/recharge_sessions et références uniques.
* **Tests ciblés :** signature, double webhook, montant faux, reprise quote expirée.
* **Acceptation :** aucun crédit avant preuve ; aucune génération automatique.
* **Rollback :** suspendre nouvelles recharges, conserver sessions en attente.
* **Hors périmètre :** remboursements non spécifiés.
* **Dépendance suivante :** états complets visibles dans historique.

### LOT 10 — Historique et recherche

* **Objectif :** brouillons et finals propriétaires, pagination et filtres.
* **Prérequis :** modèle/version/statuts stabilisés.
* **Fichiers probables :** adaptation `kadiHistoryRepo.js`, service et Flow partagé.
* **Migration :** métadonnées/index ; vues legacy si nécessaire.
* **Tests ciblés :** propriété, pagination, filtres, reprise, documents historiques.
* **Acceptation :** aucun résultat tiers, aucun doublon entre pages.
* **Rollback :** revenir à historique generated-only.
* **Hors périmètre :** analytics avancés.
* **Dépendance suivante :** enrichissement multimodal sans perdre la reprise.

### LOT 11 — OCR Gemini, photo et documents

* **Objectif :** Gemini principal pour vision avec incertitudes explicites.
* **Prérequis :** LOT 3 et domaine partagé.
* **Fichiers probables :** Gemini adapter, vision pipeline, média/PDF parser.
* **Migration :** provenance/incertitudes si conservées.
* **Tests ciblés :** images/PDF, tableaux, valeurs contradictoires, coût/latence simulés puis canary.
* **Acceptation :** aucune valeur incertaine confirmée ou total IA autoritaire.
* **Rollback :** texte manuel ou OCR actuel derrière flag.
* **Hors périmètre :** promesse de précision absolue.
* **Dépendance suivante :** expérience multimodale complète.

### LOT 12 — Vocal entrant et réponses vocales

* **Objectif :** STT provider, préférences, voice policy et TTS fidèle.
* **Prérequis :** LOT 3–4, confidentialité et benchmark préparé.
* **Fichiers probables :** adapters STT/TTS, policy, media delivery.
* **Migration :** préférences et métadonnées audio minimales.
* **Tests ciblés :** fidélité, données sensibles, panne, idempotence, formats WhatsApp.
* **Acceptation :** texte toujours présent ; aucun audio divergent.
* **Rollback :** `TEXT_ONLY` global.
* **Hors périmètre :** voix clonée ou langue non benchmarkée.
* **Dépendance suivante :** textes/Flows finaux.

### LOT 13 — Refonte des textes et Meta Flows

* **Objectif :** créer tous les Flows DRAFT et cartes françaises canoniques.
* **Prérequis :** services et contrats des lots précédents stables.
* **Fichiers probables :** JSON Flow versionnés, mappings env, contrats/tests.
* **Migration :** aucune donnée ; configuration IDs séparée.
* **Tests ciblés :** schémas Meta, transitions, longueurs, DRAFT E2E.
* **Acceptation :** aucune carte anglaise/test, frontières invisibles.
* **Rollback :** conserver anciens IDs et assets DRAFT intacts.
* **Hors périmètre :** publication.
* **Dépendance suivante :** LOT 14.

### LOT 14 — Tests complets et release gate

* **Objectif :** exécuter toutes les matrices automatisées, live DRAFT et mobiles.
* **Prérequis :** LOT 0–13 déployés en environnement contrôlé.
* **Fichiers probables :** tests, fixtures, runbooks et preuves signées.
* **Migration :** répétition de migration sur copie représentative.
* **Tests ciblés :** stratégie complète du document dédié.
* **Acceptation :** zéro FAIL critique et tous les critères obligatoires PASS.
* **Rollback :** rester DRAFT, flags désactivés.
* **Hors périmètre :** correction opportuniste non revue pendant le gate.
* **Dépendance suivante :** autorisation explicite du LOT 15.

### LOT 15 — Publication coordonnée

* **Objectif :** publier une seule version cohérente et basculer les IDs/configurations.
* **Prérequis :** gate signé, sauvegarde, rollback et fenêtre approuvée.
* **Fichiers probables :** aucun code nouveau ; runbook/version/release notes.
* **Migration :** uniquement celles déjà validées, avant code dépendant.
* **Tests ciblés :** smoke post-publication borné, health, métriques, parcours sentinelle.
* **Acceptation :** tous Flows attendus disponibles, aucun texte de test, métriques saines.
* **Rollback :** bascule config vers version publiée précédente si Meta le permet ; sinon désactiver l'entrée et guider en conversation.
* **Hors périmètre :** ajout de fonctionnalité.
* **Dépendance suivante :** observation et amélioration post-V1.

## Stratégie Meta Flows

### Portefeuille cible

* Conserver les sept Flows facture mono-écran comme preuve technique et base de non-régression.
* Construire des Flows partagés pilotés par `document_type` : `DOCUMENT_CLIENT`, `DOCUMENT_CONTENT`, `DOCUMENT_OPTIONS`, `DOCUMENT_REVIEW`, `EDIT_CLIENT`, `EDIT_CONTENT`, `EDIT_OPTIONS`, `DOCUMENT_PREVIEW` et `GENERATION_COST_CONFIRMATION`.
* Construire des Flows transverses : `ONBOARDING`, `MENU`, `RECHARGE`, `HISTORY_SEARCH`.
* Construire au moins `DISCHARGE_DETAILS` et ses corrections spécifiques pour la décharge.
* Ne pas réutiliser un texte facture pour reçu/décharge lorsqu'il change le sens métier.

### Versionnement et DRAFT

* Nommer chaque nouvelle génération avec une version fonctionnelle ; conserver mapping cible → variable d'environnement, jamais ID codé.
* Créer/uploader séquentiellement, vérifier `validation_errors=[]`, endpoint et asset, sans publier.
* Tester les sessions directes et `data_exchange` avec tokens pseudonymes et propriétés minimales.
* Les IDs DRAFT restent séparés des IDs actifs jusqu'au gate.

### Publication et rollback

1. Geler textes, contrats et JSON.
2. Vérifier migrations puis déployer le backend compatible avec anciens et nouveaux IDs.
3. Exécuter le gate DRAFT complet.
4. Publier les Flows dans une fenêtre coordonnée uniquement après autorisation explicite.
5. Basculer les variables Render de façon atomique ou par groupe compatible.
6. Sur échec avant publication, revenir aux IDs DRAFT précédents sans perte.
7. Après publication, traiter l'asset comme immuable : correction par nouvelle version/Flow, jamais modification improvisée.

## Décisions à arbitrer par le fondateur

| Question | Recommandation | Alternatives | Produit | Technique | Coût | Urgence |
|---|---|---|---|---|---|---|
| Fournisseur TTS principal | benchmark local puis configuration | OpenAI ; Gemini ; texte seul au lancement | qualité/confiance | adapter provider | appels audio | avant LOT 12 |
| Voix exacte | féminine préférée localement, non caricaturale | plusieurs voix par langue | identité Kadi | voice config/version | benchmark | avant release gate vocal |
| Tarif documentaire | crédits par page réelle | paliers ; forfait + pages | transparence | quote engine | revenus/coût PDF | avant LOT 7 |
| Coût des vocaux | texte gratuit, décision explicite avant facturation audio | inclus ; quota ; wallet séparé | adoption | ledger reasons | API TTS | avant LOT 12 |
| Paiement V1 | fournisseur avec webhook vérifiable | maintien validation manuelle bornée | fluidité/recharge | webhook/signature | frais provider | avant LOT 9 |
| Profil minimal | identité technique + nom/activité seulement si utile | nom obligatoire ; découverte sans champ | friction | colonnes/validation | faible | avant LOT 4 |
| Devis : validité | durée configurée avec date serveur | date explicite ; facultative | compréhension | règles/version | faible | avant LOT 5 |
| Reçu : minimum | payeur/bénéficiaire, montant, motif | mode/référence obligatoires | conformité perçue | validation conditionnelle | faible | avant LOT 5 |
| Décharge : minimum | remettant, receveur, sujet, motif | quantité/identité renforcées | utilité/risque | modèle spécifique | moyen | avant LOT 6 |
| Rétention rendus temporaires | purge courte configurable | jusqu'à génération ; aucune persistance | confidentialité | job/bucket | stockage | avant LOT 7 |
| Édition après génération | nouveau document/version corrective | duplication ; interdiction | confiance/historique | immutabilité/liens | stockage | avant LOT 8 |
| Historique initial | derniers éléments + recherche paginée | recherche d'abord ; nombre fixe | simplicité | index/cursor | faible | avant LOT 10 |
| Publication | une fenêtre coordonnée pour toute la V1 | vagues privées non publiées | cohérence | mapping/rollback | opérationnel | LOT 15 |

Toute décision modifiant paiement, crédits, tarification, conservation ou publication exige une validation écrite avant implémentation.
