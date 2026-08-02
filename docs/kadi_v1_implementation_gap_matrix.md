# Kadi V1 — Matrice d'écarts d'implémentation

## Portée et méthode

Cet audit compare le code suivi au contrat produit canonique au commit de référence. Il ne considère jamais un document comme preuve d'implémentation. Aucun état Render, Meta ou Supabase distant n'a été interrogé ; les propriétés qui en dépendent sont classées `UNKNOWN_REQUIRES_RUNTIME_CHECK`.

Statuts autorisés : `IMPLEMENTED`, `PARTIAL`, `MISSING`, `LEGACY_TO_REPLACE`, `UNKNOWN_REQUIRES_RUNTIME_CHECK`.

## Inventaire factuel de l'existant

| Capacité | Statut | Preuves de dépôt | Conclusion |
|---|---|---|---|
| Webhook WhatsApp | IMPLEMENTED | `index.js`, `kadiFlowMonitoringWebhook.js`, `kadiRuntimeSecretBoundary.js`, `whatsappApi.js` | vérification, réception, statuts, verrou utilisateur et envoi Cloud API présents |
| Routage conversationnel | LEGACY_TO_REPLACE | `kadiEngine.js`, `kadiPriorityRouter.js`, `kadiNaturalFlow.js`, `kadiInteractiveFlow.js` | fonctionnel mais dispersé entre priorités, états en mémoire et handlers historiques |
| Kadi Brain | PARTIAL | `kadiOpenAI.js`, `kadiGemini.js`, `kadiOcrEngine.js`, `kadiNLUEngine.js` | capacités présentes sans interface unifiée ni contrat de fournisseur transversal |
| OpenAI | PARTIAL | `kadiOpenAI.js`, `kadiAudio.js`, `kadiOcrEngine.js` | NLU, transcription et vision appelés directement ; pas de provider configurable commun |
| Gemini | PARTIAL | `kadiGemini.js`, `kadiOcrFlow.js` | OCR/parsing disponible en branche hybride ; pas encore moteur principal derrière interface |
| Transcription vocale | PARTIAL | `kadiAudio.js`, `kadiVoiceParser.js` | téléchargement, transcription OpenAI et routage présents ; politique fournisseur et persistance cible absentes |
| OCR, images et documents | PARTIAL | `kadiImageFlow.js`, `kadiOcr.js`, `kadiOcrEngine.js`, `kadiOcrFlow.js`, `kadiVisionOcr.js` | plusieurs moteurs et garde-fous existent, mais pipeline unifié, PDF entrant et contrat d'incertitude incomplets |
| Envoi de fichiers et médias | IMPLEMENTED | `whatsappApi.js`, `kadiMessaging.js`, `supabaseStorage.js` | upload média, document, image et téléchargement sont disponibles |
| Gestion des utilisateurs | PARTIAL | `store.js`, `kadiIdentity.js`, `kadiCreditsRepo.js` | profil `wa_id`/BSUID et synchronisation existent ; modèle minimal cible et migrations suivies incomplets |
| Onboarding | LEGACY_TO_REPLACE | `kadiOnboarding.js`, `kadiProfileFlow.js` | messages, actions et marquage actuels ne suivent pas encore le contrat canonique texte + vocal |
| Cinq crédits de bienvenue | LEGACY_TO_REPLACE | `kadiOnboarding.js:ensureWelcomeCredits` | montant configurable, clé `welcome:<wa_id>`, test du solde et mise à jour non atomique contredisent le contrat V1 |
| Wallet et ledger | PARTIAL | `kadiCreditsRepo.js`, `billingRepo.js` | RPC idempotents v2 présents, mais deux interfaces coexistent et les migrations des tables/RPC ne sont pas suivies |
| Facture | PARTIAL | sept JSON mono-écran, `kadiInvoice*`, pipeline historique | preuve technique DRAFT robuste, mais pas encore pipeline documentaire commun publié |
| Devis | PARTIAL | `kadiProductFlow.js`, `kadiNaturalFlow.js`, `pdf/kadiPdfDevis.js` | création et PDF historiques présents ; contrat partagé versionné absent |
| Reçu | PARTIAL | `kadiProductFlow.js`, `kadiNaturalFlow.js`, `pdf/kadiPdfRecuA4.js`, `pdf/kadiPdfRecuCompact.js` | parcours historique présent ; sémantique et états communs non persistés |
| Décharge | PARTIAL | `kadiDecharge.js`, `kadiProductFlow.js`, `pdf/kadiPdfDecharge.js` | modèle et rendu spécialisés existent, mais le Flow et le domaine cible restent à construire |
| Meta Flows | PARTIAL | `flows/kadi_facture_*.json`, `kadiInvoiceFlowIds.js` | sept Flows facture mono-écran et une baseline historique ; familles V1 restantes absentes |
| Sessions Flow | IMPLEMENTED | `kadiInvoiceFlowSession.js`, migrations `20260801` et `20260802` | token haché, propriétaire, expiration, révocation et cible fermée présents pour la facture |
| Client facture | IMPLEMENTED | `kadiInvoiceFlowScreens.js`, Flow `CLIENT`, completion et tests | collecte/correction courte fonctionnelle dans la preuve technique |
| Articles facture | IMPLEMENTED | `kadiInvoiceCartService.js`, Flow `ARTICLE_ENTRY` | champs frais, `item_id`, limite et déduplication présents |
| Options facture | IMPLEMENTED | `kadiDynamicInvoiceContract.js`, Flow `OPTIONS` | options normalisées et calcul déterministe présents pour la facture |
| Corrections facture | IMPLEMENTED | Flows `EDIT_*`, `kadiInvoiceFlowCompletion.js` | client, articles et options conservés avec sessions courtes |
| Aperçu | PARTIAL | `kadiProductFlow.js`, `kadiNaturalFlow.js`, Flow `REVIEW_INVOICE_DRAFT` | révision textuelle existe ; aperçu canonique partagé et persistant absent |
| Génération PDF | PARTIAL | `kadiPdf.js`, `kadiPdfFlow.js`, `pdf/` | renderers multi-documents présents, mais pipeline final cible et version immuable incomplets |
| Calcul réel des pages | PARTIAL | `kadiInvoicePdfDryRun.js`, `kadiInvoicePageQuote.js` | fondation testée en mémoire, non reliée au parcours de production |
| Tarification | LEGACY_TO_REPLACE | `kadiPricing.js`, `kadiRechargeConfig.js` | coût fixe et coût de tampon historiques incompatibles avec coût réel par pages et absence de tampon |
| Débit des crédits | PARTIAL | `kadiCreditsRepo.js`, `kadiPdfFlow.js` | clé d'opération présente, mais débit effectué avant rendu/page/confirmation cible |
| Recharge | PARTIAL | `kadiRechargeConfig.js`, `kadiRechargeUi.js`, `kadiPayments.js` | packs et reprise existent, avec preuve manuelle ; Flow Recharge cible absent |
| Paiements et webhooks | PARTIAL | `kadiPaymentsRepo.js`, approbation dans `kadiInteractiveFlow.js` | workflow manuel idempotent partiel ; webhook fournisseur vérifié non trouvé |
| Historique | PARTIAL | `kadiHistoryRepo.js`, `kadiHistoryFlow.js` | liste et renvoi PDF présents ; les brouillons sont exclus et le contrat V1 n'est pas complet |
| Recherche | PARTIAL | `kadiHistoryRepo.js`, `kadiHistoryFlow.js` | recherche texte propriétaire présente, sans index/métadonnées cibles ni Flow partagé |
| Voix TTS | MISSING | aucune occurrence de synthèse ou d'envoi audio généré | ni `VoiceProvider`, ni policy engine, ni artefact vocal sortant |
| Préférences utilisateur | MISSING | aucun `voice_response_mode` dans le code | pas de persistance ni service de préférence |
| Sécurité | PARTIAL | crypto Flow, vérification webhook, redaction Graph, tests sécurité | socle fort ; logs OCR historiques, modèle RLS distant et frontières IA demandent audit |
| Idempotence | PARTIAL | sessions Flow, `processed_action_keys`, RPC crédits, clés PDF/topup | mécanismes locaux présents, pas de service ni registre transversal |
| Observabilité | PARTIAL | `kadiActivityRepo.js`, `kadiLearningLogger.js`, logs Flow/PDF | événements dispersés, schéma commun et corrélation bout en bout absents |
| Migrations Supabase | PARTIAL | trois migrations facture sous `migrations/` | aucune migration suivie pour profils, wallet, documents, événements ou nouveaux états |
| Tests existants | PARTIAL | 248 déclarations `test(...)` dans `tests/` | bonne couverture facture/crypto/parser ; aucun test onboarding/welcome TTS et peu de paiements |
| Configuration runtime V1 | UNKNOWN_REQUIRES_RUNTIME_CHECK | variables lues dans `index.js`, providers et repos | présence, schéma distant, RLS, clés et Flows DRAFT nécessitent un audit pré-déploiement séparé |

## Matrice des écarts V1

| Exigence et référence | État | Modules concernés | Dépendances | Risque | Effort | Preuve de fin | Compatibilité existante |
|---|---|---|---|---|---|---|---|
| Orchestrateur conversationnel unique — `AGENTS.md` §13–15 | LEGACY_TO_REPLACE | `kadiEngine.js`, routeurs et flows historiques | domaine, états, providers | élevé : doubles routes et textes hérités | LARGE | tests de priorité et parcours quatre documents sans handler parallèle | adaptateur temporaire vers anciens handlers, puis extinction mesurée |
| Interfaces OpenAI/Gemini — `kadi_ai_brain_architecture.md` | PARTIAL | `kadiOpenAI.js`, `kadiGemini.js`, `kadiAudio.js`, `kadiOcrEngine.js` | provider contracts, observabilité | moyen : verrou fournisseur et sorties incohérentes | MEDIUM | mocks contractuels interchangeables et aucun import fournisseur dans le métier | encapsuler les fonctions actuelles avant remplacement |
| Incertitudes visuelles jamais confirmées implicitement — `AGENTS.md` §19 | PARTIAL | `kadiOcrFlow.js`, `kadiOcrEngine.js` | contrat extraction, correction | élevé : montant inventé/persisté | MEDIUM | tests `confirmed/uncertain/absent/contradictory`, total bloqué | conserver les parseurs, normaliser leurs sorties |
| Accueil texte + vocal + action unique — document onboarding | LEGACY_TO_REPLACE | `kadiOnboarding.js`, futur TTS | welcome service, voice policy | élevé : expérience et bonus divergents | MEDIUM | test E2E sans TTS puis avec TTS, texte canonique unique | détecter profils existants sans rejouer l'accueil |
| Cinq crédits atomiques — document onboarding | LEGACY_TO_REPLACE | `kadiOnboarding.js`, `kadiCreditsRepo.js`, `store.js` | migration/RPC atomique | critique : double bonus ou marqueur incohérent | MEDIUM | deux webhooks concurrents = un ledger de 5 et marqueur vrai | audit historique obligatoire, jamais le solde seul |
| Préférences vocales persistantes — document voix | MISSING | futur `UserPreferenceService` | profil/migration | moyen : consentement et UX | SMALL | lecture/écriture idempotente des trois modes | défaut explicite pour lignes existantes |
| Domaine commun facture/devis/reçu — document domain model | PARTIAL | contrats actuels et flows historiques | tables documents/versions/items | élevé : modèles divergents | LARGE | mêmes invariants et state machine pour trois types | importer les documents historiques via couche de lecture |
| Domaine spécifique décharge — document domain model | PARTIAL | `kadiDecharge.js`, renderer | agrégat spécialisé, preview | moyen | MEDIUM | scénarios argent/bien/document sans panier artificiel | mapper les anciens champs sans les réinterpréter |
| Machine d'états persistante — document state machine | MISSING | états en mémoire et draft facture | domaine, migrations, idempotence | critique : reprises et opérations sensibles | LARGE | transitions autorisées/interdites testées en concurrence | états historiques mappés avec statut `legacy`/projection |
| Aperçu structuré canonique — document preview | PARTIAL | previews texte et review facture | version documentaire | moyen | MEDIUM | projection complète liée à une version et invalidée sur édition | réutiliser formatters et calculateurs |
| Rendu temporaire non livré — document preview | PARTIAL | `kadiInvoicePdfDryRun.js` | renderer commun, stockage temporaire | élevé : coût faux | MEDIUM | page count réel multi-types, aucune livraison/débit | réutiliser `buildPdfBuffer`, séparer stockage temporaire |
| Coût réel affiché avant confirmation — document billing | PARTIAL | `kadiInvoicePageQuote.js`, `kadiPricing.js` | rendu temporaire, config tarifaire | critique : facturation incorrecte | MEDIUM | quote versionnée, pages exactes, solde relu | déprécier coût fixe sans changer anciens soldes |
| Débit unique après confirmation — document billing | PARTIAL | RPC crédits, `kadiPdfFlow.js` | quote, state machine, idempotency | critique : débit prématuré/double | LARGE | tests timeout/retry/concurrence, aucune consommation avant confirmation | adaptateur RPC v2, nouveau reason/key namespace |
| Génération finale immuable — document billing | PARTIAL | `kadiPdfFlow.js`, `kadiRepo.js`, storage | débit confirmé, version figée | élevé | MEDIUM | un fichier par version/clé, relivraison sans régénération | conserver renderers et médias historiques |
| Recharge vérifiée et reprise — contrats partagés | PARTIAL | topups manuels et UI | provider paiement/webhook, state machine | élevé : crédit non vérifié/double | LARGE | webhook signé/idempotent et retour à confirmation | conserver topups historiques et clés `topup:<id>` |
| Historique/recherche V1 — release scope | PARTIAL | `kadiHistoryRepo.js`, `kadiHistoryFlow.js` | modèle commun, index | moyen | MEDIUM | brouillons/finals autorisés, pagination stable, filtres | vue d'adaptation pour `kadi_documents` existants |
| Meta Flows V1 coordonnés — flow architecture | PARTIAL | sept Flows facture, mapping IDs | tous services précédents | élevé : publication partielle | LARGE | contrats, DRAFT E2E et textes français tous PASS | garder les sept Flows comme preuve/régression |
| Aucune fonctionnalité de tampon — `AGENTS.md` §17 | LEGACY_TO_REPLACE | `kadiStamp*`, `kadiPricing.js`, `kadiPdfFlow.js` | nettoyage contrôlé | élevé : règle produit violée | MEDIUM | aucune action, coût, rendu ou texte de tampon dans V1 | ne pas supprimer les données historiques avant politique d'archive |
| Release gate complet — critères V1 | MISSING | suite de tests et processus release | tous lots | critique | LARGE | matrice signée sans FAIL/BLOCKED critique | conserver suite historique comme non-régression |

## Réutilisation de l'existant

### Réutilisable sans modification fonctionnelle

* réception et vérification du webhook dans `index.js` et `kadiRuntimeSecretBoundary.js` ;
* client WhatsApp et primitives médias de `whatsappApi.js` après conservation de la redaction ;
* cryptographie Meta Flow et route chiffrée ;
* modèle de session Flow opaque, lié au propriétaire et expirant ;
* validateurs/calculateur facture déterministes ;
* renderers PDF dans `pdf/`, sous réserve d'un audit visuel par type ;
* garde-fous DRAFT des sept Flows facture.

### Réutilisable après adaptation

* sept Flows facture : base des contrats partagés, pas expérience finale ;
* drafts et sessions facture : adaptateur vers `Document` et machine d'états ;
* OpenAI/Gemini/OCR/STT : envelopper derrière providers ;
* `kadiInvoicePdfDryRun.js` et `kadiInvoicePageQuote.js` : généraliser aux quatre types ;
* RPC wallet v2 : conserver derrière `WalletLedgerService` après vérification de schéma ;
* recharge manuelle, historique et recherche : connecter aux nouveaux états et événements ;
* journalisation d'activité : normaliser vers un audit log corrélé.

### À déprécier

* `billingRepo.js` au profit d'une seule façade crédits ;
* états conversationnels métiers uniquement en mémoire dans `kadiState.js` ;
* coût fixe `kadiPricing.js` pour la génération documentaire ;
* appels directs OpenAI/Gemini depuis les parcours métier ;
* ancien Flow multi-écran `flows/kadi_facture_v1.json` après bascule sûre.

### À remplacer

* `ensureWelcomeCredits` actuel ;
* orchestration par enchaînement de handlers historiques ;
* débit/génération actuel qui consomme avant le calcul réel et la confirmation cible ;
* toute action, tarification ou application de tampon dans la V1 ;
* copies de test et textes Meta non canoniques avant publication.

## Compatibilité et contrôles runtime requis

Avant toute migration, produire des comptages anonymisés : profils, marqueur bienvenue, ledger, wallets, documents par type/statut, sessions actives, topups et fichiers. Vérifier les RPC, contraintes, RLS, index et fonctions réellement déployés. Aucun backfill de bonus ne part du solde. Les anciennes sessions restent lisibles jusqu'à expiration ou sont révoquées explicitement ; aucun document historique n'est renuméroté ni dupliqué.

## Principaux bloqueurs

1. Corriger atomiquement les crédits de bienvenue avant le nouvel onboarding.
2. Introduire domaine et machine d'états avant les nouveaux Flows.
3. Séparer rendu temporaire, coût, confirmation, débit et génération finale.
4. Éliminer le tampon de l'expérience V1 sans détruire l'historique.
5. Construire providers IA/voix et préférences avant toute promesse vocale sortante.
6. Obtenir les preuves runtime Supabase/Render/Meta avant chaque bascule.
