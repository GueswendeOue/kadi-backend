# Kadi AI — Instructions permanentes pour tout agent IA

Ce fichier est la porte d'entrée universelle pour toute IA travaillant sur
ce dépôt (Codex, Claude ou autre). Les sections qui suivent (1 à 20)
restent les instructions permanentes détaillées. Cette section 0 fixe la
discipline documentaire et de contexte qui les complète.

## 0. Contexte multi-agents et documentation permanente

Avant toute modification importante :

* lire [`docs/CONTEXT_INDEX.md`](docs/CONTEXT_INDEX.md), qui indexe tous les
  documents de contexte permanents ;
* consulter [`docs/KADI_ENGINEERING_MEMORY.md`](docs/KADI_ENGINEERING_MEMORY.md)
  avant tout diagnostic — un symptôme rencontré a peut-être déjà une cause
  confirmée documentée ;
* consulter [`docs/KADI_RELEASE_CHECKLIST.md`](docs/KADI_RELEASE_CHECKLIST.md)
  avant toute mission de livraison ;
* inspecter le code réel et les tests avant de formuler une hypothèse — le
  dépôt est la source de vérité technique, pas un document historique.

### Table : quel document lire selon la mission

| Type de mission | Document(s) à lire en premier |
|---|---|
| Prise de contexte générale | [`docs/CONTEXT_INDEX.md`](docs/CONTEXT_INDEX.md) |
| Comprendre pourquoi le projet existe | [`docs/KADI_PROJECT_VISION.md`](docs/KADI_PROJECT_VISION.md) |
| Savoir ce qui est déployé aujourd'hui | [`docs/KADI_CURRENT_STATE.md`](docs/KADI_CURRENT_STATE.md) |
| Modification technique (routage, persistance, runtime) | [`docs/KADI_ARCHITECTURE.md`](docs/KADI_ARCHITECTURE.md) |
| Modification touchant la logique métier | [`docs/KADI_PRODUCT_RULES.md`](docs/KADI_PRODUCT_RULES.md) |
| Diagnostic d'un bug ou d'un comportement inattendu | [`docs/KADI_ENGINEERING_MEMORY.md`](docs/KADI_ENGINEERING_MEMORY.md) |
| Livraison, déploiement, publication Meta, migration | [`docs/KADI_RELEASE_CHECKLIST.md`](docs/KADI_RELEASE_CHECKLIST.md) et le runbook correspondant dans `docs/runbooks/` |
| Situer une mission dans la trajectoire produit | [`docs/KADI_ROADMAP.md`](docs/KADI_ROADMAP.md) |
| Comprendre pourquoi un choix d'architecture a été fait | `docs/decisions/ADR-*.md` |

### Règles permanentes de discipline (résumé, détail dans les sections 1 à 20)

* ne jamais modifier une migration Supabase déjà appliquée ; toute
  correction est une nouvelle migration forward-only ; ne jamais exécuter de
  migration Supabase distante sans autorisation explicite ;
* ne jamais committer, pousser ou fusionner directement sur `main`, et ne
  jamais déployer, sans autorisation explicite de la mission ;
* ne jamais faire basculer le rollout de `CANARY` vers `FULL`, ni ajouter un
  numéro CANARY, sans autorisation explicite du fondateur ;
* ne jamais modifier les services `kadi-beta-cleanup` ou
  `kadi-beta-notify` ;
* ne jamais supprimer de données, et ne jamais effectuer de réécriture
  générale du code sans mission explicite le demandant ;
* ne jamais afficher ou journaliser un secret, un token, un `wa_id` complet
  ou un payload complet — voir aussi la section 5 ;
* commencer chaque mission de correction en lecture seule, présenter le
  diagnostic et le plan avant toute modification, et ajouter un test qui
  reproduit le bug avant de le corriger ;
* exécuter les tests ciblés avant la suite complète (voir section 7) ;
* ajouter un test de non-régression pour toute nouvelle erreur corrigée, et
  documenter sa cause confirmée dans
  [`docs/KADI_ENGINEERING_MEMORY.md`](docs/KADI_ENGINEERING_MEMORY.md) —
  n'y consigner que des causes réellement confirmées, jamais une hypothèse ;
* distinguer strictement le Flow Meta (écran WhatsApp), la session
  conversationnelle (temporaire) et le document métier (persistant) — voir
  [`docs/KADI_ARCHITECTURE.md`](docs/KADI_ARCHITECTURE.md) ;
* ne jamais stocker une décision métier confirmée uniquement dans une
  session WhatsApp temporaire ; elle doit être écrite dans le document réel.

## 1. Projet

Kadi AI est un assistant administratif WhatsApp destiné principalement aux micro-entrepreneurs, commerçants, artisans et prestataires du Burkina Faso.

Fonctions prévues :

* compréhension de texte, vocal et photo ;
* création de factures ;
* création de devis ;
* création de factures proforma ;
* création de reçus ;
* création de décharges.

Stack principale :

* Node.js ;
* WhatsApp Business Cloud API ;
* OpenAI ;
* Supabase ;
* Render.

Backend public : https://kadi-backend-1gqg.onrender.com

Routes principales :

* `/webhook`
* `/data_exchange`
* `/health`

## 2. Flow facture

Flow Meta :

* ID : `1972040430119125`
* nom : `KADI_FACTURE_V1`
* fichier : `flows/kadi_facture_v1.json`
* statut de travail : `DRAFT`

Écrans métier :

* `CLIENT`
* `ARTICLE_ENTRY`
* `OPTIONS`
* `REVIEW_INVOICE_DRAFT`
* `EDIT_CLIENT`
* `EDIT_ITEMS`
* `EDIT_OPTIONS`

Écrans structurels :

* `KADI_SESSION_ROOT`
* `SESSION_RECOVERY`

Les écrans structurels ne doivent pas apparaître dans le parcours normal de l’utilisateur.

Ne jamais publier le Flow, l’uploader de nouveau ou modifier Meta sans autorisation explicite de la mission.

## 3. Règles métier verrouillées

* Aucun tampon généré, stocké ou appliqué.
* Aucun coût lié au tampon.
* `issued_at` est produit uniquement côté serveur.
* `issued_at` comprend les secondes.
* L’utilisateur ne choisit pas la date du document.
* Aucun débit de crédit en mode `DRAFT`.
* Aucun PDF final en mode `DRAFT`.
* `items.length` est la source unique du nombre d’articles.
* Le sous-total est recalculé depuis les articles sauvegardés.
* Toute correction d’article utilise le `item_id` serveur.
* Les complétions doivent être idempotentes.
* Aucun article ne doit être ajouté deux fois lors d’un retry.
* Chaque nouvelle session `ARTICLE_ENTRY` doit ouvrir des champs frais.

La future facturation des documents dépendra du nombre réel de pages du PDF.

Aucun débit avant :

1. génération réelle du PDF ;
2. calcul du nombre de pages ;
3. présentation du coût ;
4. confirmation de l’utilisateur.

## 4. Ordre obligatoire du webhook

Pour un `nfm_reply` reconnu :

1. détecter le message interactif ;
2. exécuter `invoiceFlowCompletion` ;
3. orchestrer éventuellement la session suivante ;
4. retourner immédiatement si `handled=true` ;
5. ne pas exécuter les anciens boutons ;
6. ne pas exécuter MENU ;
7. ne pas appeler OpenAI ;
8. ne pas envoyer un deuxième message.

Une complétion Flow reconnue mais invalide doit être absorbée avant les anciens handlers.

## 5. Sécurité

Ne jamais afficher ou journaliser en clair :

* Authorization ;
* access token ;
* secrets Render ;
* clés privées ;
* passphrases ;
* numéro WhatsApp complet ;
* `flow_token` complet ;
* `draft_id` complet ;
* données personnelles du client ;
* payload cryptographique ;
* headers HTTP complets ;
* configuration Axios ou HTTP complète.

Les logs d’erreur doivent :

* utiliser une liste fermée de champs ;
* masquer les données sensibles ;
* limiter leur longueur ;
* limiter la profondeur des objets ;
* gérer les cycles et valeurs hostiles ;
* ne jamais empêcher la propagation normale de l’erreur.

Ne pas modifier :

* la cryptographie ;
* les clés ;
* `/data_exchange` ;
* la propriété des brouillons ;
* les règles d’idempotence ;

sans preuve précise et mission explicite.

## 6. Discipline Git

Avant toute mission de modification :

* vérifier la branche ;
* vérifier `git status --short` ;
* identifier les changements déjà présents ;
* ne jamais écraser un travail existant ;
* limiter les fichiers au périmètre autorisé.

Une mission doit avoir un objectif principal.

Ne pas mélanger dans un même commit :

* correction fonctionnelle ;
* instrumentation ;
* documentation ;
* refactor non demandé.

Interdictions :

* aucun force push ;
* aucun amend du commit précédent sauf demande explicite ;
* aucun changement externe implicite ;
* aucun commit ou push si les tests requis échouent.

Toujours communiquer le SHA après un commit.

## 7. Politique de tests économique

### Diagnostic ou lecture seule

* ne pas exécuter `npm test` par défaut ;
* inspecter d’abord les fichiers, logs et tests existants ;
* lancer uniquement les commandes nécessaires au diagnostic.

### Développement local

* utiliser les tests ciblés du composant modifié ;
* ne pas relancer la suite complète après chaque petite correction.

### Avant commit

Exécuter une seule fois :

1. tests ciblés ;
2. `npm test` ;
3. `git diff --check`.

### Après commit et push

* vérifier HEAD, branche locale et origin ;
* ne pas relancer `npm test` si le commit poussé est exactement le commit déjà testé ;
* vérifier Render uniquement si le changement doit être déployé.

### Documentation seulement

* ne pas lancer `npm test` ;
* utiliser `git diff --check` ;
* vérifier la lisibilité du Markdown.

## 8. Actions externes

Par défaut, ne pas :

* envoyer de message WhatsApp réel ;
* appeler l’endpoint Meta `/messages` ;
* modifier Meta ;
* uploader un Flow ;
* publier un Flow ;
* modifier Render ;
* modifier les variables d’environnement ;
* débiter des crédits ;
* générer un PDF réel.

Une action externe doit être explicitement autorisée par la mission.

## 9. Méthode de travail

Avant d’agir :

1. lire `AGENTS.md` ;
2. inspecter l’état réel du dépôt ;
3. réutiliser les fonctions et tests existants ;
4. ne pas reconstruire une solution parallèle ;
5. rechercher la cause exacte avant de corriger ;
6. choisir le patch minimal ;
7. tester au niveau adapté au risque.

Ne pas répéter dans le rapport toutes les règles de ce fichier.

## 10. Format court des missions

Chaque prompt futur doit préciser seulement :

* STATE ;
* MISSION ;
* FILES ;
* CONSTRAINTS ;
* TESTS ;
* VERDICT.

## 11. Format court des rapports

Par défaut, répondre uniquement avec :

* STATE
* CHANGES
* TESTS
* RISKS
* VERDICT

Ne produire un rapport exhaustif que pour :

* sécurité ;
* chiffrement ;
* paiements ;
* crédits ;
* PDF ;
* migration de données ;
* publication Meta ;
* erreur Live non comprise ;
* changement d’architecture.

## 12. Qualité utilisateur

Les messages destinés aux utilisateurs de Kadi doivent :

* être simples ;
* être humains ;
* être compréhensibles sans connaissance technique ;
* ne pas afficher `flow_token`, `payload`, `draft_id`, `nfm_reply` ou autres termes internes ;
* éviter les doubles réponses ;
* éviter « Tapez MENU » après une interaction Flow reconnue.

## 13. North Star conversationnelle

Kadi est une assistante administrative conversationnelle WhatsApp pour les micro-entrepreneurs, commerçants, artisans et prestataires. L'utilisateur échange naturellement par texte, vocal ou photo. Kadi comprend le besoin, extrait les données, puis demande uniquement les informations manquantes avant de faire vérifier, corriger, prévisualiser et confirmer le document.

Les Meta Flows sont une infrastructure de vérification. Leurs frontières techniques doivent rester invisibles : l'utilisateur doit avoir l'impression de dialoguer avec une seule assistante, jamais d'utiliser plusieurs logiciels.

Références canoniques :

* `docs/kadi_conversational_product_vision.md`
* `docs/kadi_flow_architecture.md`
* `docs/kadi_preview_generation_billing.md`
* `docs/kadi_voice_experience.md`
* `docs/kadi_ai_brain_architecture.md`
* `docs/kadi_onboarding_and_welcome_credits.md`

## 14. Personnalité et langage

Toute réponse utilisateur doit être naturelle, humaine, chaleureuse, professionnelle, courte, claire et rassurante. Elle contient idéalement une information principale, une seule prochaine action et au maximum une question utile.

Ne jamais exposer à l'utilisateur : `Flow`, `session`, `payload`, brouillon technique, `OpenAI`, `OCR`, `endpoint`, erreur interne ou « commande non reconnue ». Ne plus utiliser « Créer guidé », « Photo » ou « Menu » comme actions principales : la photo et le vocal sont des modes d'entrée.

Entrée de référence :

> **Utilisateur :** Je veux créer une facture.
>
> **Kadi :** Bien sûr. Envoyez-moi le nom du client, les produits ou services, les quantités et les prix. Vous pouvez écrire, envoyer un vocal ou une photo.

Si une information manque, poser une seule question précise à la fois.

## 15. Architecture produit cible

Prévoir les familles de Flows suivantes : `ONBOARDING`, `MENU`, `DOCUMENT CLIENT`, `DOCUMENT ITEMS`, `DOCUMENT OPTIONS`, `DOCUMENT REVIEW`, `EDIT CLIENT`, `EDIT ITEMS`, `EDIT OPTIONS`, `DOCUMENT PREVIEW`, `GENERATION CONFIRMATION`, `RECHARGE`, `HISTORY / SEARCH` et les Flows propres aux décharges.

Facture, devis et reçu partagent autant que possible un pipeline piloté par `document_type`. La décharge conserve son modèle métier propre. Les sept Flows facture actuels restent la base technique fonctionnelle jusqu'à l'approbation d'une refonte ; ne pas les remplacer ou les refactorer sans spécification approuvée.

Le menu cible privilégie : « Préparer un document », « Retrouver un document », « Mon solde » et « Aide ». Il reste un raccourci ; le langage naturel est l'entrée principale. L'onboarding est progressif et ne demande que le nécessaire sans retarder la découverte de la valeur de Kadi.

## 16. Aperçu, génération et facturation

Après vérification, ouvrir un aperçu dédié affichant le type, l'émetteur, le client ou bénéficiaire, les articles ou l'objet, quantités, prix, taxes, remise, notes, sous-total, total, date automatique et numéro du document. Proposer seulement : « Modifier les informations », « Préparer le PDF » et « Enregistrer pour plus tard ». L'aperçu ne débite aucun crédit.

Après « Préparer le PDF » : produire un rendu temporaire non livré, compter les pages réelles, calculer le coût exact, afficher coût et solde, puis demander une confirmation explicite. Après confirmation seulement, une opération idempotente débite une fois, persiste le document final et livre le PDF.

Si le solde est insuffisant : ne rien débiter, conserver le brouillon et ouvrir la recharge. Les packs et tarifs proviennent d'une configuration centrale ; les crédits ne sont ajoutés qu'après confirmation vérifiée du paiement.

## 17. Règles produit non négociables

* Aucune fonctionnalité ni aucun coût de tampon.
* `issued_at` est produit côté serveur, avec les secondes ; aucune date manuelle.
* Aucun débit et aucun PDF final en mode `DRAFT`.
* Le sous-total est recalculé depuis les articles sauvegardés.
* `items.length` représente uniquement le nombre d'articles.
* Toute correction d'article utilise le `item_id` serveur.
* Toute opération sensible est idempotente.
* Aucune clé, aucun token ni secret dans Git, les logs ou les rapports.
* Aucun ID Meta volatile dans le code applicatif : utiliser des variables d'environnement.

## 18. Release gate des Flows

Ne publier aucun Flow avant validation de la conversation d'entrée, des cartes WhatsApp, titres, boutons et transitions, des entrées texte/vocal/photo, des informations manquantes, corrections, aperçu, calcul du coût, recharge, génération finale, historique, absence de débit en `DRAFT` et tests mobiles sur plusieurs tailles d'écran.

## 19. Identité vocale et cerveau multimodal

Kadi possède une identité vocale féminine, ouest-africaine, naturelle, chaleureuse, professionnelle, claire, calme et rassurante. Elle reste non caricaturale et sans accent artificiellement exagéré. Toute voix clonée ou reproduite depuis une personne réelle exige un consentement explicite, vérifiable et conservé selon une procédure approuvée.

Le texte validé est toujours la réponse canonique : moteur métier Kadi → texte validé → moteur déterministe de politique vocale → synthèse éventuelle → envoi du texte et, si autorisé, de l'audio. L'audio n'ajoute aucune information, ne modifie aucune donnée métier et ne confirme jamais un paiement, débit ou document que le backend n'a pas validé.

Le texte est le mode par défaut. Une préférence persistante choisit `TEXT_ONLY`, `TEXT_AND_VOICE` ou `VOICE_WHEN_HELPFUL`, cette dernière étant la valeur recommandée par défaut. Ne pas vocaliser automatiquement les données sensibles, confirmations courtes, erreurs techniques ou contenus difficiles à vérifier oralement.

Le cerveau multimodal peut utiliser OpenAI et Gemini derrière des interfaces configurables. Aucun parcours métier ne dépend directement d'un fournisseur. Le backend Kadi reste la seule autorité pour calculs, crédits, paiements, états, numéros, dates, génération et livraison. Un seul fournisseur vocal sert une réponse normale ; benchmark, shadow, canary ou fallback exigent un cadre explicitement autorisé.

Gemini est le moteur principal prévu pour la vision, l’OCR intelligent, la compréhension documentaire et l’extraction structurée à partir des images et PDF. Toute sortie Gemini doit être validée par le backend Kadi avant persistance ou utilisation métier.

Les champs incertains, illisibles ou contradictoires doivent être signalés et jamais inventés. Ils ne peuvent pas être persistés comme données confirmées. Kadi doit demander une confirmation ciblée ou les présenter dans un écran de correction.

## 20. Onboarding et crédits de bienvenue

Au premier usage d'un nouvel utilisateur éligible, Kadi envoie un texte de bienvenue et un court vocal fidèle au même texte, présente les entrées texte, vocal et photo, annonce exactement 5 crédits offerts et propose une seule action : « Commencer ». Le texte reste canonique ; le vocal n'ajoute aucune information et n'est envoyé automatiquement qu'au premier accueil. L'annonce du bonus intervient uniquement après confirmation serveur de son attribution.

Chaque nouvel utilisateur reçoit exactement 5 crédits, une seule fois. Le backend est l'unique autorité : après création réussie du profil minimal identifié par le `wa_id`, il inscrit atomiquement un mouvement de ledger `WELCOME_CREDITS` et passe `welcome_credits_granted` à `true`, avec la clé d'idempotence `welcome_credits:<wa_id>`. Aucun Flow, retry, double clic, ré-onboarding, reprise ou réactivation ne peut réattribuer le bonus.

Ordre obligatoire : `USER_PROFILE_CREATED` → `WELCOME_CREDITS_GRANTED` → `WELCOME_TEXT_SENT` → `WELCOME_VOICE_ATTEMPTED` → `ONBOARDING_STARTED` → `ONBOARDING_COMPLETED`. Le profil minimal et le bonus ne dépendent pas des champs facultatifs. L'échec du vocal ne retire pas les crédits, n'annule pas le profil et ne bloque pas l'onboarding. Un nouvel essai audio utilise une clé distincte telle que `welcome_voice:<wa_id>:v1`, sans aucune incidence sur l'éligibilité au bonus.

Ne jamais déduire l'absence du bonus depuis le solde courant. Pour les utilisateurs existants, toute régularisation future doit vérifier le ledger historique, `welcome_credits_granted`, les anciens bonus, la date de création du profil et les écritures de crédit existantes avant décision ; aucune attribution globale automatique n'est autorisée.
