# KADI_CONVERSATIONAL_MULTIMODAL_V1 — Fondation et intégration orchestrateur

Ce document couvre deux livraisons distinctes, à des états différents :

* **Fondation** (contrats, politique, adaptateur Gemini Audio) — **statut :
  `MERGED_DEPLOYMENT_UNVERIFIED_DISABLED_NOT_INTEGRATED`**, fusionnée dans
  `main` via [PR #8](https://github.com/GueswendeOue/kadi-backend/pull/8)
  (commit de merge `c3030c909fdb526c5341622afe5a8b5389f0a77d`). Le
  déploiement Render de ce commit n'est pas vérifiable depuis cet
  environnement — ne pas en déduire qu'il a ou n'a pas été déployé.
* **Intégration orchestrateur/bootstrap** (§5) — **statut :
  `IMPLEMENTED_NOT_MERGED`**, sur la branche
  `feat/kadi-conversational-orchestrator-integration-v1`, qui n'existe pas
  sur `main`.

**Dans les deux cas, aucun comportement utilisateur n'est affecté
aujourd'hui** : `KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED` et
`KADI_GEMINI_AUDIO_V1_ENABLED` restent `false` par défaut,
`KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS` n'est configuré nulle
part, et la branche d'intégration elle-même n'est pas fusionnée. Ce n'est
pas un comportement actif en production.

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

**Câblé dans l'orchestrateur et le bootstrap de production, sur une branche
de fonctionnalité (`feat/kadi-conversational-orchestrator-integration-v1`),
non fusionnée, non déployée, non activée** :

* `kadiV1ConversationalMultimodalRuntimeAdapter.js` (nouveau) implémente
  exactement le même port `interpret(command)` que l'adaptateur existant
  `createKadiV1InterpretationRuntimeAdapter` — c'est ce qui permet de
  brancher la fondation **sans modifier `kadiV1ConversationOrchestrator.js`
  pour le câblage lui-même** : seule la couche de composition
  (`kadiV1ProductionOrchestratorComposition.js`) choisit quel adaptateur
  d'interprétation construire. `kadiV1ConversationOrchestrator.js` reçoit
  une seule ligne de changement fonctionnel : une branche additive pour
  l'intent `RECHARGE` (voir ci-dessous), inatteignable par l'adaptateur
  d'origine ;
* l'éligibilité est vérifiée **à chaque appel**, jamais figée à la
  construction : `KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS` est une
  allowlist indépendante de `KADI_V1_CANARY_WA_IDS` (voir
  `kadiV1CanaryIngress.js`, `createKadiV1ConversationalMultimodalCanaryConfig`
  / `isKadiV1ConversationalMultimodalOwnerAllowed`) — être en CANARY
  général n'accorde jamais automatiquement l'éligibilité conversationnelle ;
* pour tout propriétaire non éligible, toute entrée `FLOW_REPLY`, ou
  simplement quand `KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED` est faux
  (le cas par défaut, y compris sur cette branche tant qu'elle n'est pas
  activée), l'adaptateur délègue **exactement** à l'adaptateur existant —
  comportement inchangé, prouvé par des tests de composition dédiés ;
* pour un propriétaire éligible, `CREATE_DOCUMENT`/`UPDATE_DOCUMENT`
  produisent `{intent, document_type, brain_result}` via une **chaîne
  canonique unique et explicite** :
  `interpretConversationalInput` (enveloppe validée par
  `validateConversationalResult`) →
  `conversationalResultToBrainResult` (nouveau,
  `kadiV1ConversationalMultimodalBrainAdapter.js`) → objet indépendamment
  revalidé par `kadiV1BrainContracts.validateBrainResult` →
  `documents.apply(...)`. Le mapping est une **liste fermée** (jamais un
  spread) : seuls les champs `EXTRACTED_FIELD_KEYS` non `AUTHORITY_FIELDS`
  sont copiés. `operation: CORRECT_FIELD`/`ADD_ITEM` sont acceptées ;
  `REMOVE_ITEM`/`CHANGE_DOCUMENT_TYPE` sont **toujours rejetées** par cet
  adaptateur précis (non exprimables en un seul appel `documents.apply(...)`
  avec le pipeline actuel) — c'est intentionnel : ces deux opérations sont
  interceptées **avant** d'atteindre cet adaptateur (voir ci-dessous), pas
  une lacune silencieuse. Cela signifie que **l'application au brouillon
  existant (`documents.apply`, questions manquantes, ouverture de Flow) est
  totalement réutilisée, sans deuxième implémentation** ;
* `RECHARGE` est un intent que l'adaptateur d'origine ne produit jamais —
  `kadiV1ConversationOrchestrator.js` gagne une branche dédiée qui ouvre le
  Flow `RECHARGE` existant (comme le fait déjà `HISTORY_SEARCH`), sans
  jamais muter de document ; inatteignable tant que l'intégration n'est
  pas câblée pour un propriétaire donné ;
* **`REMOVE_ITEM`** est supporté, mais pas via `documents.apply(...)` :
  `kadiV1ConversationalMultimodalItemLookup.js` (nouveau) résout la phrase
  de retrait (« enlève la livraison ») contre les `items` déjà persistés sur
  le document actif (comparaison normalisée sur `description`, jamais
  d'invention). La normalisation gère, de façon strictement déterministe
  (aucune correspondance floue/probabiliste) : accents, casse, apostrophes
  typographiques (`'`/`'` → `'`), espaces internes doublés ou en début/fin
  de chaîne, et une tolérance minimale au pluriel simple restreinte à un
  seul mot entier (« tables » retrouve un article nommé « Table », sans
  jamais permettre à un mot plus court et « replié » de correspondre par
  sous-chaîne à un mot plus long sans rapport — seule l'égalité exacte du
  mot replié est acceptée, jamais une inclusion). Cette tolérance ne peut
  jamais transformer un cas déjà ambigu en une suppression unique erronée :
  elle ne fait qu'élargir l'ensemble des candidats, jamais le réduire. En
  cas de correspondance unique et exacte,
  `kadiV1ConversationalMultimodalRuntimeAdapter.js` renvoie
  `{intent: "REMOVE_ITEM", document_type, remove_item_id}` ; en l'absence de
  correspondance ou en cas d'ambiguïté, zéro mutation et une clarification.
  `kadiV1ConversationOrchestrator.js` gagne une branche dédiée qui appelle
  le port **existant et déjà sûr** `documents.removeContent(...)`
  (`kadiV1RuntimeAdapters.js` → `kadiV1SharedDocumentPipeline.js`,
  suppression par `item_id` exact, recalcul serveur du sous-total) —
  aucune nouvelle logique de mutation n'a été ajoutée pour cette
  fonctionnalité, uniquement le câblage vers un port déjà existant et testé ;
* **`CHANGE_DOCUMENT_TYPE` est supporté pour exactement une paire
  compatible, FACTURE↔DEVIS**, via un nouveau port backend-contrôlé dédié
  `documents.changeDocumentType({ ownerWaId, documentId, expectedVersion,
  documentType, targetDocumentType, idempotencyKey })` — jamais un
  écrasement direct de `document_type` depuis la sortie du fournisseur.
  Chaîne : `kadiV1ConversationalMultimodalRuntimeAdapter.js` (le
  `target_document_type` est exactement `envelope.document_type`, la
  propre inférence validée du cerveau, jamais inventé ici) →
  `kadiV1ConversationOrchestrator.js` (nouvelle branche `CHANGE_DOCUMENT_TYPE`,
  miroir de `REMOVE_ITEM`) → `kadiV1RuntimeAdapters.js` →
  `kadiV1SharedDocumentPipeline.js` (enveloppe replay/version/idempotence
  identique aux autres mutations) → `kadiV1DocumentDomain.js`'s nouvelle
  `changeDocumentType(document, targetType)`, la seule fonction qui sait
  quelles paires sont compatibles en données (FACTURE et DEVIS partagent un
  stockage et une politique de normalisation identiques — voir
  `kadiV1SharedDocumentPolicies.js`). Réutilise le **même** portail
  d'état « éditable » que `modifyDocument` (`DOCUMENT_EVENTS.MODIFY` →
  `EDITABLE_STATES`, retour à `COLLECTING`, invalidation de l'aperçu/coût
  déjà calculés) plutôt que d'élargir la surface générale de patch de
  `modifyDocument` à tous ses appelants existants. Préserve client,
  articles, quantités et prix unitaires ; aucun débit, génération, numéro
  de document, `issued_at` ni transition vers un état final ; un rejeu de
  webhook avec la même clé d'idempotence ne change le type qu'une seule
  fois. **RECU et DECHARGE restent strictement exclus** — forme de données
  incompatible (`receipt`/`discharge` au lieu de `client`+`items`), aucune
  capacité de conversion sûre n'existe, inventer une politique de migration
  de données pour ces types aurait été hors mission ;
  `kadiV1ConversationalMultimodalRuntimeAdapter.js` intercepte donc
  `operation === "CHANGE_DOCUMENT_TYPE"` pour toute autre paire et répond
  systématiquement par une clarification invitant à annuler le brouillon en
  cours et à en démarrer un nouveau — zéro mutation, zéro écriture de
  `document_type` ;
* **repli exact `PREPARE_DOCUMENT` en cas d'échec de mapping** : si
  `CREATE_DOCUMENT` a été déterminé avec un `document_type` validé mais que
  `conversationalResultToBrainResult` échoue (extraction malformée, cas
  limite), l'adaptateur ne renvoie plus une clarification générique : il
  renvoie `{intent: "PREPARE_DOCUMENT", document_type, brain_result: null}`,
  ce qui déclenche exactement le chemin `documents.start(...)` déjà existant
  (brouillon vide, aucune donnée non validée appliquée) — zéro mutation
  conversationnelle, un seul brouillon, aucun second appel payant au
  fournisseur. Les échecs survenant **avant** la construction d'une
  enveloppe validée (timeout, refus, sortie malformée au niveau du
  fournisseur ou de `interpretConversationalInput` lui-même) restent en échec
  fermé classique (identique à l'adaptateur d'origine sur la même panne) :
  sans enveloppe validée, aucun `document_type` fiable n'est disponible, et
  en inventer un violerait la règle « jamais de valeur inventée » ;
* **Résolution de la contradiction PREPARE_DOCUMENT** (audit puis correctif) :
  `kadiV1ConversationOrchestrator.js` calcule `direct =
  detectNaturalIntent(input.text)` (sa propre détection déterministe locale,
  distincte de celle de la politique conversationnelle) **avant** toute
  notion d'éligibilité conversationnelle ou d'appel à
  `interpretation.interpret(...)`. Pour tout texte contenant un mot-clé
  reconnu (« facture », « devis », « reçu », « décharge »),
  `direct.intent === "PREPARE_DOCUMENT"` court-circuitait
  **inconditionnellement** — pour tout propriétaire, éligible ou non — en
  appelant directement `documents.start(...)` sans jamais consulter
  `interpretation.interpret(...)`. Résultat confirmé par audit : même pour
  un propriétaire conversationnel éligible, « Fais une facture pour Moussa
  avec trois tables à 45 000. » démarrait un brouillon **vide**, perdant
  Moussa et les articles — la couche politique
  (`kadiV1ConversationalMultimodalPolicy.js`), pourtant déjà conçue pour ne
  jamais court-circuiter `CREATE_DOCUMENT` précisément pour cette raison
  (voir son propre commentaire), n'était simplement jamais atteinte.
  **Correctif :** le court-circuit déterministe ne s'applique plus
  inconditionnellement. Un nouveau paramètre optionnel du constructeur de
  l'orchestrateur, `conversationalEligibilityGate` (fonction synchrone,
  locale, sans appel réseau — **exactement** la même fonction
  d'allowlist que celle déjà injectée dans l'adaptateur conversationnel,
  câblée une seule fois par `kadiV1ProductionOrchestratorComposition.js`,
  jamais deux vérifications indépendantes), détermine si le propriétaire
  est éligible **et** si `config.features.brain` est actif. Si non
  éligible (le cas par défaut absolu : tout déploiement existant, tout test
  qui ne câble pas ce paramètre) → comportement historique **strictement
  inchangé**, zéro appel fournisseur. Si éligible → le court-circuit est
  sciemment **ignoré** pour laisser l'interprétation conversationnelle
  s'exécuter une seule fois et capturer les données du même message ; aucun
  indice de type n'a besoin d'être transmis manuellement, la couche
  politique redérive le même indice via les mêmes fonctions
  `detectNaturalIntent`/`detectDocumentTypeHint`. Si cette interprétation
  échoue ensuite (timeout, refus, sortie malformée, échec de validation ou
  de mapping — tout ce qui produit `interpreted.ok === false`), le MÊME
  `direct.intent === "PREPARE_DOCUMENT"` déjà calculé sert de repli exact
  vers le chemin historique (`documents.start(...)` avec le
  `direct.document_type` déterministe, même `idempotencyKey`) — zéro
  mutation conversationnelle, un seul brouillon, aucun second appel
  fournisseur. Preuve de bout en bout (adaptateur réel + orchestrateur réel
  + pipeline document réel, comptage réel des appels fournisseur et des
  brouillons créés) dans
  `tests/kadiV1PrepareDocumentConversationalPath.test.js` ;
* `kadiV1ProductionBootstrap.js` lit
  `KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS` **uniquement** quand
  `config.features.conversationalMultimodalV1` est vrai, et expose un état
  sûr (`readiness.conversational_multimodal_v1`) sans jamais exposer
  d'identifiant WhatsApp ; une allowlist malformée ne fait jamais échouer
  le démarrage du webhook — elle rend seulement la fonctionnalité inerte
  (personne n'est éligible) ;
* `kadiV1GeminiAudioProvider.js` reste **non construit** dans
  `kadiV1ProductionBootstrap.js` : le pipeline `OPENAI_STT` existant pour
  les vocaux reste strictement inchangé, et Gemini Audio ne peut jamais
  devenir requis au démarrage, flag ou pas ;
* aucun Meta Flow n'est contourné : une entrée `FLOW_REPLY` délègue
  toujours au chemin authoritaire existant
  (`kadiV1FlowReplyRuntime.js`), jamais réinterprétée par un résultat IA
  (§13 AGENTS.md).

**Toujours non activé pour de vrais utilisateurs** : `main` ne contient
aucun de ces changements (voir §0 et la section Statut en tête de ce
document) ; sur cette branche même, `KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED`
reste `false` par défaut et `KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS`
n'est configuré nulle part.

## 5bis. Observabilité conversationnelle (privacy-safe, non branchée à un tableau de bord)

`kadiV1ConversationalMultimodalObservability.js` (nouveau) reprend le motif
`safeEmitter(logger)` déjà utilisé par `kadiV1GeminiVisionProvider.js` /
`kadiV1GeminiAudioProvider.js` / `kadiV1VoiceProviders.js` : un `logger`
injecté (jamais construit dans le module), une liste fermée de 5 noms
d'événement, et une liste fermée de champs sûrs — tout le reste d'un objet
`details` passé est silencieusement ignoré, jamais transmis.

Événements : `conversational_route_selected`, `conversational_result_validated`,
`conversational_fallback_selected`, `conversational_draft_applied`,
`conversational_clarification_required`.

**Deux émetteurs distincts, une seule règle : `conversational_draft_applied`
ne signifie jamais autre chose qu'« une mutation backend a réellement
réussi ».**

* `kadiV1ConversationalMultimodalRuntimeAdapter.js` émet
  `conversational_result_validated`, `conversational_route_selected`,
  `conversational_fallback_selected` et `conversational_clarification_required`
  — des événements d'*interprétation*, jamais de mutation. Cet adaptateur
  n'appelle jamais `documents.apply(...)` / `documents.removeContent(...)` /
  `documents.changeDocumentType(...)` lui-même ; il ne peut donc jamais
  savoir si une mutation va réussir, échouer, ou être absorbée comme un
  rejeu. Pour les trois issues qui remettent une mutation à l'appelant
  (REMOVE_ITEM résolu, CHANGE_DOCUMENT_TYPE convertible, CREATE_DOCUMENT/
  UPDATE_DOCUMENT mappé), la valeur renvoyée porte un sac de champs déjà
  filtrés et gelés (`observabilityFields`) — jamais émis directement par ce
  module.
* `kadiV1ConversationOrchestrator.js` est le **seul et unique** endroit qui
  émet `conversational_draft_applied`, et seulement après que le port
  backend correspondant (`documents.apply`, `documents.removeContent` ou
  `documents.changeDocumentType`) a lui-même renvoyé `ok:true` avec
  `duplicate !== true`. Concrètement : `ok:false` (échec, conflit de
  version, validation) → zéro événement de succès ; `duplicate:true` (rejeu
  d'un webhook déjà appliqué, détecté par
  `kadiV1SharedDocumentPipeline.js`'s propre `replayFor`) → zéro second
  événement de succès. `kadiV1RuntimeAdapters.js`'s `apply(...)` a été
  corrigé pour ne plus faire perdre ce signal `duplicate` en aval de
  `advanceIfComplete(...)` (il ne le faisait pas avant cette correction).
  Un repli/une clarification n'émet jamais `conversational_draft_applied` —
  seulement `conversational_fallback_selected`/`conversational_clarification_required`,
  jamais les deux catégories confondues.

Champs autorisés uniquement : `source`, `intent` (normalisé, y compris
`CHANGE_DOCUMENT_TYPE` — mesurable comme toute autre issue), `document_type`,
`operation`, `result_status` (`OK`/`ERROR`), `missing_field_count`,
`ambiguous_field_count`, `provider_category` (`DETERMINISTIC`/`BRAIN`),
`latency_bucket` (buckets grossiers : `LT_1S`/`LT_3S`/`LT_10S`/`GTE_10S`,
jamais la milliseconde brute), `fallback_reason_code` (motif fermé,
ex. `REMOVE_ITEM_AMBIGUOUS`, `CREATE_DOCUMENT_TYPE_UNSUPPORTED`), et
`correlation_ref` (SHA-256 tronqué de `correlationId`, jamais le
`wa_id`/texte/transcript/token en clair).

Explicitement jamais transmis, quelle que soit la valeur d'entrée : numéro
WhatsApp complet, nom, texte du message, transcript, contenu extrait,
description d'article, montant, réponse brute d'un fournisseur, prompt,
token, ID de média complet, `flow_token`, ou contenu de l'allowlist — un
test dédié (`tests/kadiV1ConversationalMultimodalObservability.test.js`)
construit un événement volontairement rempli de ces champs sensibles et
vérifie qu'aucun ne survit à l'émission.

Garanties : l'émission ne change jamais la valeur renvoyée à l'appelant (un
`logger` qui lève une exception est absorbé, testé explicitement) ; elle ne
bloque jamais le chemin document si le logger échoue ou est absent (défaut
`null` → no-op) ; un webhook rejoué ne produit jamais un second événement
`conversational_draft_applied` pour la même mutation — preuve de bout en
bout, pipeline réel compris, dans
`tests/kadiV1PrepareDocumentConversationalPath.test.js` (test 8) et
`tests/kadiV1ConversationalDraftAppliedObservability.test.js` (7 scénarios :
3 échecs → zéro événement, 3 succès → un événement chacun, 1 rejeu → un
seul événement au total).

`kadiV1ProductionOrchestratorComposition.js` construit un unique
`conversationalObservabilityEmit` (via
`createConversationalObservabilityEmitter(...)`, la même fabrique que
l'adaptateur conversationnel utilise pour son propre `logger`) et le
transmet à `kadiV1ConversationOrchestrator.js` — cet orchestrateur ne
construit jamais lui-même de télémétrie, il ne fait que recevoir un
callback déjà construit. `kadiV1ProductionBootstrap.js` construit le
`logger` structuré sous-jacent uniquement quand
`config.features.conversationalMultimodalV1` est vrai, en pontant le
`logger` déjà injecté (`logger.log(event, safeDetails)`) — aucune nouvelle
destination de journalisation, de persistance ou de tableau de bord n'est
créée par cette mission.

### Compatibilité admin-stats (documentation uniquement)

Aucun tableau de bord n'est construit sur cette branche. Une mission future
`KADI_ADMIN_AI_OBSERVABILITY_V1` est prévue pour consommer ces 5 événements
(agrégation, lecture seule) sans jamais lire le contenu d'un message —
seuls les champs listés ci-dessus existent dans le flux d'événements ; le
texte, les entités extraites et l'identité complète du propriétaire n'y sont
jamais disponibles, par construction.

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

## 8. Plan de déploiement

1. ~~revue de la fondation~~ — **fait**, PR #8 fusionnée ;
2. ~~câblage explicite dans `kadiV1ConversationOrchestrator.js`~~ — **fait**
   sur `feat/kadi-conversational-orchestrator-integration-v1`, via
   composition (§5), pas encore fusionné dans `main` ;
3. revue indépendante de cette branche d'intégration (mission dédiée) ;
4. fusion de la branche d'intégration dans `main`, toujours avec
   `KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED=false` ;
5. activation en local/test uniquement
   (`KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED=true` en environnement de
   développement, `KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS` limité
   à quelques propriétaires de test), jamais en production sans mission
   explicite ;
6. shadow ou canary contrôlé, critères d'arrêt définis avant activation
   réelle (voir `docs/kadi_ai_brain_architecture.md` §« Sélection des
   fournisseurs ») ;
7. configuration Render des deux variables
   (`KADI_CONVERSATIONAL_MULTIMODAL_V1_ENABLED`,
   `KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS`), uniquement avec
   autorisation explicite et en suivant
   [`KADI_RELEASE_CHECKLIST.md`](KADI_RELEASE_CHECKLIST.md).

Aucune des étapes 3 à 7 n'a été exécutée par la mission qui a produit cette
version du document.

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

**Fondation (sur `main`, commit `c3030c909fdb526c5341622afe5a8b5389f0a77d`) :**
aucune action de rollback en production n'est nécessaire tant qu'aucun flag
n'est activé et que la branche d'intégration n'est pas fusionnée — ce code
n'a, par construction, aucun chemin d'exécution atteignable par un
utilisateur réel. Un `git revert` du commit de merge suffirait si
nécessaire, sans coordination Render ni Supabase.

**Intégration (branche `feat/kadi-conversational-orchestrator-integration-v1`,
pas encore fusionnée) :** modifie `kadiV1ConversationOrchestrator.js` (trois
branches additives, `RECHARGE`/`REMOVE_ITEM`/`CHANGE_DOCUMENT_TYPE`, toutes
inatteignables sans l'adaptateur conversationnel ; `assertPort` exige
désormais `removeContent` et `changeDocumentType` sur `documentRuntime`,
tous deux déjà exposés par l'adaptateur réel existant ; le court-circuit
déterministe `PREPARE_DOCUMENT` devient conditionnel à
`conversationalEligibilityGate`, un nouveau paramètre optionnel qui vaut
`null` par défaut — voir §5 « Résolution de la contradiction
PREPARE_DOCUMENT » pour le détail exact), `kadiV1ProductionOrchestratorComposition.js`
et `kadiV1ProductionBootstrap.js` (lecture conditionnelle de deux variables,
allowlist et logger d'observabilité, câblage de
`conversationalEligibilityGate`). Ajoute aussi, de façon strictement
additive, `changeDocumentType` à trois fichiers **déjà utilisés par le
parcours Flow Meta historique servant le trafic CANARY réel** —
`kadiV1DocumentDomain.js` (nouvelle fonction pure, aucune fonction
existante modifiée), `kadiV1SharedDocumentPipeline.js` (nouvelle méthode du
pipeline), `kadiV1RuntimeAdapters.js` (nouvelle méthode de l'adaptateur, et
`assertMethods` qui l'exige désormais sur `sharedPipeline` — toujours
satisfait, puisque `sharedPipeline` n'est jamais construit qu'via la
fabrique réelle `createSharedDocumentPipeline`, qui l'expose désormais).
`kadiV1RuntimeAdapters.js` reçoit en plus, suite à la revue adversariale,
une correction minimale et additive de sa fonction `apply(...)` **déjà
existante** : elle préserve désormais l'indicateur `duplicate` renvoyé par
`applyBrainExtraction` au lieu de le laisser silencieusement disparaître en
passant par `advanceIfComplete(...)` (qui ne reçoit que le document, pas le
résultat complet). C'est la seule fonction déjà existante modifiée dans ces
trois fichiers ; le changement est un ajout pur de champ (`duplicate` sur
la valeur de retour), sans changement de signature ni de comportement pour
aucun appelant qui ne lit pas ce champ. Ajoute enfin quatre
fichiers source entièrement nouveaux, inertes tant que la branche n'est pas
fusionnée et activée : `kadiV1ConversationalMultimodalBrainAdapter.js`,
`kadiV1ConversationalMultimodalRuntimeAdapter.js`,
`kadiV1ConversationalMultimodalItemLookup.js`,
`kadiV1ConversationalMultimodalObservability.js`. Tant que
`KADI_CONVERSATIONAL_MULTIMODAL_V1_CANARY_WA_IDS` n'est configuré sur
Render pour personne, ces changements restent sans effet observable même
une fois fusionnés et déployés — le rollback le plus simple est de ne
jamais configurer cette variable. Si un rollback complet devenait
nécessaire après fusion, un `git revert` du commit de merge de cette
branche suffit également, pour la même raison (rien n'est activé ni
migré).

## 11. Rappels produit non négociables

* le tampon numérique est définitivement abandonné et **hors périmètre** —
  aucun code, aucun champ, aucun coût lié n'existe dans cette fondation ;
* Gemini n'est pas utilisé comme simple OCR : il produit une extraction
  structurée avec incertitudes, jamais un texte brut non qualifié ;
* aucun modèle multimodal ne peut autoriser une opération financière — voir
  §2 et §6 ;
* la release CANARY actuelle est indépendante de cette branche : `main` ne
  contient aucun de ces changements (voir §0/statut en tête de document).
  Sur la branche d'intégration elle-même, plusieurs fichiers qui servent
  réellement le trafic de production sont modifiés
  (`kadiV1ConversationOrchestrator.js`, `kadiV1ProductionBootstrap.js`,
  `kadiV1ProductionOrchestratorComposition.js`, `kadiV1DocumentDomain.js`,
  `kadiV1SharedDocumentPipeline.js`, `kadiV1RuntimeAdapters.js`,
  `kadiV1RuntimeConfig.js`, `kadiV1CanaryIngress.js`) — mais chaque
  changement y est strictement additif (nouvelle branche conditionnelle,
  nouvelle fonction, nouvelle méthode, nouveau paramètre optionnel par
  défaut inerte, ou nouvelle entrée `FEATURE_ENV_KEYS`), jamais une
  modification du comportement d'une fonction ou d'un flag existant ;
  confirmé par la suite de tests existante restée entièrement au vert
  (1092/1092 à la date de cette mise à jour) sans qu'aucun de ces tests
  n'ait dû changer son assertion sur un comportement préexistant.
