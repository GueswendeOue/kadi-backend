# Kadi AI — Instructions permanentes Codex

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
