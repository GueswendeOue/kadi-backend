# KADI_FACTURE_V1 — sessions courtes

Le parcours de facture utilise plusieurs ouvertures courtes du même Flow et conserve un seul brouillon côté serveur. Il n'est relié ni au portefeuille ni à l'envoi PDF.

- Flow JSON `7.3`, protocole de données `3.0`.
- Le `routing_model` est strictement acyclique : ses sept écrans d'entrée indépendants n'ont aucune transition interne. Chaque écran termine sa session avec `complete`.
- Le webhook traite `interactive.nfm_reply` avant les anciens routeurs. Il enregistre l'action, crée un jeton unique, puis ouvre la prochaine session avec `flow_action_payload.screen` et `flow_action_payload.data`.
- `ARTICLE_ENTRY` remplace les formulaires A/B. Chaque nouvel article reçoit une nouvelle instance de cet écran avec un Form direct, un résumé recalculé et des champs neufs (`designation: ""`, `quantity: "1"`, `unit_price: ""`; unité et décision sans sélection).
- « J'ajoute autre chose » ajoute l'article exactement une fois puis rouvre `ARTICLE_ENTRY`. Cette succession n'impose aucune limite fonctionnelle de deux ou trois articles ; la limite technique configurable du document reste à 100.
- « C'est tout » ajoute le dernier article exactement une fois, clôt la saisie des articles et ouvre `OPTIONS` dans une nouvelle session.
- `REVIEW_INVOICE_DRAFT` ne revient vers aucun écran. Les choix de correction terminent la session et ouvrent respectivement `EDIT_CLIENT`, `EDIT_ITEMS` ou `EDIT_OPTIONS`; la validation de la correction rouvre ensuite la vérification avec le brouillon actualisé.
- `EDIT_ITEMS` cible un article avec son `item_id` attribué par le serveur. Une correction remplace quantité et prix sans utiliser un index client et sans ajouter une ligne.
- Le backend conserve `draft_id`, le panier canonique `items[]`, le client et les options. Il déduplique avec les identités du message, de la soumission, de l'article, du brouillon et du jeton.
- Les requêtes de l'endpoint utilisent RSA-OAEP SHA-256 puis AES-128-GCM. La réponse réutilise la clé AES avec l'IV inversé, conformément à l'exemple officiel WhatsApp.
- La confirmation recalcule les montants localement et finalise le brouillon de manière idempotente avec une date serveur. Elle envoie uniquement la confirmation humaine prévue.
- Ce parcours ne génère aucun PDF et n'effectue aucun débit. Un retry n'ajoute pas d'article et n'envoie pas de message ou de prochaine ouverture en double.

Variables documentées : `KADI_INVOICE_FLOW_ENABLED`, `KADI_INVOICE_FLOW_ID`, `KADI_INVOICE_FLOW_MODE`, `KADI_INVOICE_FLOW_ENDPOINT_URL`, `KADI_INVOICE_FLOW_ENDPOINT_PATH`, `KADI_INVOICE_FLOW_TEST_RECIPIENTS`, `KADI_INVOICE_FLOW_TEST_TRIGGER`, `KADI_INVOICE_FLOW_SESSION_TTL_MINUTES`, `KADI_INVOICE_MAX_ITEMS`, `KADI_FLOW_PRIVATE_KEY`, `KADI_FLOW_PRIVATE_KEY_PASSPHRASE`.

La route HTTP locale est `POST /data_exchange` (modifiable uniquement via `KADI_INVOICE_FLOW_ENDPOINT_PATH`) et reste désactivée tant que `KADI_INVOICE_FLOW_ENABLED` n'est pas explicitement `true`.

Avec l'orchestration webhook active, `/data_exchange` conserve les opérations techniques `ping` et `INIT`, mais refuse les anciennes actions métier qui renverraient les écrans A/B retirés. Le chiffrement de la route n'est pas modifié.

Le nombre d'articles n'est plus limité par un nombre d'écrans Flow. Il reste soumis à la limite métier configurable (100 actuellement), à l'expiration du brouillon, ainsi qu'aux tailles maximales des résumés, payloads et messages WhatsApp.

Avant activation, le JSON, l'URL HTTPS et la clé publique devront être validés dans Meta Flow Builder. Aucune configuration Meta n'est réalisée par ce code.

Le nom suivi `.env.exeample` est historique dans ce dépôt et reste volontairement inchangé. Seules des variables factices peuvent y être documentées.
