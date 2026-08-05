# KADI_CONVERSATIONAL_MULTIMODAL_V1 — Fondation isolée

**Statut :** `MERGED_DEPLOYMENT_UNVERIFIED_DISABLED_NOT_INTEGRATED` —
implémentée, testée, revue et **fusionnée dans `main`** via
[PR #8](https://github.com/GueswendeOue/kadi-backend/pull/8) (commit de
merge `c3030c909fdb526c5341622afe5a8b5389f0a77d`). Le déploiement Render de
ce commit n'est pas vérifiable depuis cet environnement — ne pas en déduire
qu'il a ou n'a pas été déployé. Dans tous les cas, **aucun comportement
utilisateur n'est affecté** : les deux flags restent désactivés par défaut
et aucun câblage n'existe dans l'orchestrateur ni le bootstrap de
production (voir §5). Ce n'est pas un comportement actif en production.

Ce document décrit la fondation de compréhension conversationnelle multimodale
construite dans cette mission. Il complète, sans le remplacer,
[`kadi_ai_brain_architecture.md`](kadi_ai_brain_architecture.md) (référence
canonique du cerveau IA) et [`../AGENTS.md`](../AGENTS.md) §13-§19.

## 0. Constat de départ — ne pas reconstruire ce qui existe déjà

Avant d'écrire du code, l'audit en lecture seule de cette mission a montré
qu'une part importante de ce qui était demandé existait déjà dans le dépôt,
désactivée par défaut :

| Brique | Fichier existant | Rôle déjà couvert |
|---|---|---|
| Contrat multimodal unifié | `kadiV1BrainContracts.js` | Schéma de requête/résultat, liste fermée `AUTHORITY_FIELDS` interdisant tout champ métier (débit, total, `issued_at`...) dans une sortie IA |
| Orchestration et routage fournisseur | `kadiV1Brain.js`, `kadiV1BrainProviders.js` | OpenAI/Gemini par modalité, politiques `PRIMARY_ONLY` / `CONTROLLED_FALLBACK` / `SHADOW_COMPARE`, observabilité sûre |
| Vision structurée | `kadiV1GeminiVisionProvider.js` | Extraction image/PDF avec incertitudes, jamais de valeur inventée |
| Transcription | `kadiV1SpeechToText.js` | OPENAI_STT en production ; `createGeminiSpeechToTextProvider` déjà présent mais non câblé |
| Compréhension déterministe | `kadiV1ConversationOrchestrator.js` (`detectNaturalIntent`) | Détection par mots-clés FR de CANCEL/HELP/BALANCE/HISTORY_SEARCH/MENU/PREPARE_DOCUMENT, déjà active indépendamment du cerveau LLM |
| Application à un brouillon | `kadiV1ConversationOrchestrator.js` (`documents.apply`) | Réutilisation des données déjà connues, application d'un résultat IA au document actif |

Tout cela reste gated derrière `KADI_V1_BRAIN_ENABLED`, `KADI_V1_VISION_ENABLED`,
`KADI_V1_TRANSCRIPTION_ENABLED` (tous `false` par défaut) — la présence de ce
code ne change donc rien au comportement CANARY actuel.

**Décision retenue pour cette mission** (validée explicitement) : construire
`KADI_CONVERSATIONAL_MULTIMODAL_V1` comme une **couche additive fine** qui
réutilise cette infrastructure plutôt que de la dupliquer, et ne combler que
les écarts réels. Voir [`../AGENTS.md`](../AGENTS.md) §9 (« ne pas
reconstruire une solution parallèle »).

## 1. Routes fournisseur actuelles et cibles

**Actuelles (production, hors CANARY conversationnel)** : Meta Flows
structurés (formulaires WhatsApp) pour toute la collecte de données ; aucun
appel OpenAI/Gemini pour comprendre un texte libre dans le parcours livré.

**Actuelles (code déjà présent, désactivé)** : texte → OpenAI ; transcription
→ OPENAI_STT ; image → Gemini ; document → Gemini. Correspond exactement au
routage annoncé dans l'état courant de cette mission.

**Cible (cette fondation, toujours désactivée)** : même routage, plus audio
direct → Gemini (expérimental, `KADI_GEMINI_AUDIO_V1_ENABLED`), plus une
enveloppe de compréhension unifiée (`source` incluant `FLOW`) au-dessus du
cerveau existant et du classificateur déterministe.

## 2. Responsabilités

### OpenAI

* moteur principal de compréhension conversationnelle en texte libre
  (`kadiV1Brain.js`, modalités `TEXT`/`TRANSCRIPTION`, déjà câblé) ;
* personnalité et ton naturel de Kadi ;
* interprétation des corrections naturelles, sélection de la question
  suivante utile (`user_facing_message_draft` du contrat existant) ;
* explications et messages de reprise après erreur.

### Gemini

* compréhension d'image et de document (déjà câblé, `kadiV1GeminiVisionProvider.js`) ;
* extraction de tableaux et lignes d'articles ;
* classification du type de document depuis un contenu multimodal ;
* détection des champs manquants et ambigus ;
* compréhension audio directe expérimentale, désactivée par défaut
  (nouveau : `kadiV1GeminiAudioProvider.js`, `KADI_GEMINI_AUDIO_V1_ENABLED`) ;
* extraction multimodale structurée.

### Backend Kadi

* tous les calculs financiers, totaux, quantités, devises ;
* transitions d'état du document, vérification et débit de crédit,
  autorisation, persistance, génération PDF, validation finale ;
* **aucun modèle ne peut débiter un crédit, finaliser un document ou écrire
  une donnée arbitraire sans validation backend** — appliqué techniquement
  par une **liste fermée `AUTHORITY_FIELDS` unique**, définie et exportée
  par `kadiV1BrainContracts.js`, puis **importée telle quelle** (jamais
  recopiée) par `kadiV1ConversationalMultimodalContracts.js` et par
  `kadiV1GeminiVisionProvider.js` — les trois points d'entrée IA partagent
  donc exactement la même liste, sans copie indépendante susceptible de
  diverger. Elle rejette toute sortie contenant `debit`, `total`,
  `issued_at`, `document_number`, `final_generation`, `generation_cost`,
  etc.

## 3. Contrat de requête normalisé (nouveau)

Fichier : `kadiV1ConversationalMultimodalContracts.js`.

* `source` : `TEXT | AUDIO | IMAGE | DOCUMENT | FLOW` — étend le cerveau
  existant (`TEXT/TRANSCRIPTION/IMAGE/DOCUMENT`) avec `FLOW`, sans modifier
  `BRAIN_MODALITIES` (laissé intact et isolé) ;
* `intent` : `CREATE_DOCUMENT | UPDATE_DOCUMENT | SEARCH_HISTORY |
  CHECK_BALANCE | RECHARGE | CANCEL | HELP | UNKNOWN` — vocabulaire exact de
  la mission, distinct du vocabulaire interne du cerveau
  (`CREATE_DOCUMENT/UPDATE_DOCUMENT/SEARCH_DOCUMENT/REQUEST_HELP/UNKNOWN`) et
  de celui de l'orchestrateur (`BALANCE/HISTORY_SEARCH/MENU/...`) ; cette
  enveloppe fait le pont entre les deux ;
* `document_type` : réutilise l'énumération canonique existante
  `FACTURE | DEVIS | RECU | DECHARGE` (`normalizeDocumentType` de
  `kadiV1BrainContracts.js`). Les mots `INVOICE/QUOTE/RECEIPT/DISCHARGE`
  mentionnés dans la mission sont traités comme un glossaire descriptif en
  anglais, pas comme une seconde taxonomie parallèle au modèle métier
  verrouillé (voir [`KADI_PRODUCT_RULES.md`](KADI_PRODUCT_RULES.md)) ;
* `operation` : `CORRECT_FIELD | REMOVE_ITEM | ADD_ITEM | CHANGE_DOCUMENT_TYPE`,
  uniquement pour `UPDATE_DOCUMENT` ;
* `language`, `extracted_entities`, `requested_corrections`, `missing_fields`,
  `ambiguous_fields`, `needs_confirmation`, `provider_metadata`,
  `schema_version` (`"1.0"`).

`validateConversationalResult` échoue fermé sur tout champ inconnu, tout
champ d'autorité, toute confiance ou toute confirmation incohérente. Voir les
tests dans `tests/kadiV1ConversationalMultimodalContracts.test.js`.

## 4. Feature flags

Ajoutés (additif uniquement) dans `kadiV1RuntimeConfig.js` →
`FEATURE_ENV_KEYS` :

* `conversationalMultimodalV1` → `KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED` (défaut `false`) ;
* `geminiAudioV1` → `KADI_GEMINI_AUDIO_V1_ENABLED` (défaut `false`).

Comme tous les flags existants, ils restent coupés tant que
`KADI_V1_ENABLED` est faux, et sont indépendants les uns des autres (test
dédié dans `tests/kadiV1RuntimeConfig.test.js`). **Aucune variable Render
n'a été posée** — ces noms sont prêts à être configurés par une mission de
déploiement ultérieure, explicitement autorisée.

## 5. Ce qui est câblé et ce qui ne l'est pas

Câblé et testé dans cette fondation :

* `kadiV1ConversationalMultimodalContracts.js` — validation de requête/résultat ;
* `kadiV1ConversationalMultimodalPolicy.js` — classification déterministe :
  CANCEL/HELP/CHECK_BALANCE/SEARCH_HISTORY réutilisent directement
  `detectNaturalIntent` (et `validateCanonicalText`) de
  `kadiV1ConversationOrchestrator.js`, avec des tests de parité qui
  comparent les deux sorties sur le même texte ; seuls RECHARGE et
  l'ambiguïté « quel document » — que `detectNaturalIntent` ne couvre pas
  aujourd'hui — sont classifiés localement. CREATE_DOCUMENT n'est jamais
  court-circuité par ce chemin déterministe : il retombe systématiquement
  sur le cerveau existant (`brain.understand`, jamais réimplémenté), pour
  ne pas perdre les entités présentes dans le même message (ex. « Moussa »
  dans « Fais une facture pour Moussa »). Ce chemin gère aussi la détection
  d'opération (correction/ajout/retrait/changement de type) sur
  UPDATE_DOCUMENT ;
* `kadiV1GeminiAudioProvider.js` — extraction structurée directe depuis
  l'audio, désactivée par défaut, réutilise
  `normalizeStructuredExtraction` de `kadiV1GeminiVisionProvider.js`.

**Non câblé intentionnellement dans cette mission** :

* `kadiV1ConversationOrchestrator.js` n'appelle pas ce nouveau module — le
  brancher dans l'orchestrateur qui sert réellement le trafic CANARY est un
  changement d'intégration production, hors périmètre d'une « fondation
  isolée ». Une mission dédiée, revue séparément, doit faire ce câblage ;
* `kadiV1ProductionBootstrap.js` ne construit pas `kadiV1GeminiAudioProvider` ;
  le pipeline OPENAI_STT existant reste strictement inchangé ;
* aucun Meta Flow n'est contourné — la mission `KADI_CONVERSATIONAL_MULTIMODAL_V1`
  prépare la compréhension en amont, mais la confirmation sécurisée via Flow
  reste le mécanisme de complétion tant qu'aucune mission ne dit le contraire
  (§13 AGENTS.md).

## 6. Sécurité

* Aucun jeton, prompt complet ou contenu de message personnel dans les
  métadonnées de diagnostic — `provider_metadata` est une liste fermée de
  clés (`provider`, `model`, `request_ref`, `latency_ms`, `classifier`) avec
  détection de motifs de secret (voir `validateProviderMetadata`) ;
* aucun identifiant interne (`flow_token`, `payload`, `nfm_reply`,
  `draft_id`) ni nom de fournisseur ne peut apparaître dans un texte validé
  par `validateCanonicalResponseText` (§7) ;
* les corrélations sont hashées (SHA-256, tronquées) dans les événements
  d'observabilité, comme le fait déjà `kadiV1Brain.js`.

## 7. Politique de conversation Kadi

Voir [`KADI_CONVERSATION_POLICY.md`](KADI_CONVERSATION_POLICY.md) pour le
détail formel. Un validateur exécutable
(`validateCanonicalResponseText` dans `kadiV1ConversationalMultimodalPolicy.js`)
applique une longueur maximale, l'absence de nom de fournisseur, l'absence de
jargon interne et l'unicité de la question posée.

## 8. Plan de déploiement (non exécuté dans cette mission)

1. revue de cette fondation ;
2. câblage explicite dans `kadiV1ConversationOrchestrator.js` (mission dédiée) ;
3. activation en local/test uniquement (`KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED=true`
   en environnement de développement, jamais en production sans mission
   explicite) ;
4. shadow ou canary contrôlé, critères d'arrêt définis avant activation
   (voir `docs/kadi_ai_brain_architecture.md` §« Sélection des fournisseurs ») ;
5. configuration Render, uniquement avec autorisation explicite et suivant
   [`KADI_RELEASE_CHECKLIST.md`](KADI_RELEASE_CHECKLIST.md).

## 9. Plan de mesure (conception uniquement, aucune collecte démarrée)

Indicateurs prévus, sans donnée personnelle en clair :

* taux de succès de classification d'intention (déterministe vs cerveau) ;
* taux d'acceptation des champs extraits sans correction ;
* nombre de corrections par document ;
* nombre de questions nécessaires avant l'aperçu ;
* taux de complétion du document ;
* taux d'abandon ;
* latence par fournisseur et par modalité ;
* taux d'échec par fournisseur ;
* coût estimé par document complété ;
* répartition d'usage audio/image/document/texte ;
* pourcentage de documents complétés sans passage par un formulaire manuel
  complet.

Aucune collecte de donnée de production n'est démarrée par cette mission.

## 10. Rollback

Cette fondation est un ensemble de nouveaux fichiers plus deux ajouts
additifs (`FEATURE_ENV_KEYS` dans `kadiV1RuntimeConfig.js`) sans câblage dans
l'orchestrateur ni dans le bootstrap de production. Maintenant que la
branche est fusionnée dans `main` (commit `c3030c909fdb526c5341622afe5a8b5389f0a77d`),
**aucune action de rollback en production n'est nécessaire tant que
l'orchestrateur et le bootstrap ne sont pas câblés et qu'aucun flag n'est
activé** — le code présent sur `main` n'a, par construction, aucun chemin
d'exécution atteignable par un utilisateur réel. Si un rollback devenait
nécessaire malgré tout avant tout câblage, un simple `git revert` du commit
de merge suffit, sans coordination Render ni Supabase puisque rien n'est
activé ni migré.

## 11. Rappels produit non négociables

* le tampon numérique est définitivement abandonné et **hors périmètre** —
  aucun code, aucun champ, aucun coût lié n'existe dans cette fondation ;
* Gemini n'est pas utilisé comme simple OCR : il produit une extraction
  structurée avec incertitudes, jamais un texte brut non qualifié ;
* aucun modèle multimodal ne peut autoriser une opération financière — voir
  §2 et §6 ;
* la release CANARY actuelle est indépendante de cette branche : les fichiers
  qui servent réellement le trafic de production
  (`kadiV1ConversationOrchestrator.js`, `kadiV1ProductionBootstrap.js`,
  `kadiV1WebhookRuntime.js`) n'ont pas été modifiés. Le seul fichier partagé
  touché est `kadiV1RuntimeConfig.js`, par un ajout strictement additif de
  deux entrées `FEATURE_ENV_KEYS` (voir §4) qui ne change la résolution
  d'aucun flag existant — confirmé par les tests existants restés au vert.
