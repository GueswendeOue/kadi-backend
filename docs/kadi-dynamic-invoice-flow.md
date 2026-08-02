# KADI_FACTURE_V1 — fondation dynamique

Cette fondation locale n'est reliée ni au webhook actif, ni au portefeuille, ni à l'envoi PDF.

- Flow JSON `7.3`, protocole de données `3.0`.
- Le parcours principal est `CLIENT` → `ARTICLE_CART_A` ↔ `ARTICLE_CART_B` → `OPTIONS` → `REVIEW_INVOICE_DRAFT` → `DRAFT_SAVED`; le modèle de routage déclare aussi les retours de correction depuis la vérification.
- « Ajouter un autre article » alterne dynamiquement entre `ARTICLE_CART_A` et `ARTICLE_CART_B` depuis l'endpoint `data_exchange`, avec résumé, compteur et sous-total recalculés. Chaque écran contient directement son propre formulaire (`item_form_a` ou `item_form_b`) afin de remonter des composants de saisie neufs. Aucun `Form` n'est imbriqué dans une branche conditionnelle, seul le `Form` reçoit `init-values` et aucun composant individuel ne reçoit `init-value`.
- « Terminer les articles » ajoute le dernier article de façon idempotente puis avance vers `OPTIONS`.
- Le backend conserve le panier canonique `items[]`, déduplique les actions et limite techniquement un document à 100 articles.
- Les requêtes de l'endpoint utilisent RSA-OAEP SHA-256 puis AES-128-GCM. La réponse réutilise la clé AES avec l'IV inversé, conformément à l'exemple officiel WhatsApp.
- La confirmation recalcule les montants localement, finalise le brouillon de manière idempotente avec une date serveur, puis ouvre l'écran humain `DRAFT_SAVED`.
- Ce parcours ne génère aucun PDF, n'effectue aucun débit et n'envoie aucun second message WhatsApp après la complétion valide du Flow.

Variables documentées : `KADI_INVOICE_FLOW_ENABLED`, `KADI_INVOICE_FLOW_ID`, `KADI_INVOICE_FLOW_MODE`, `KADI_INVOICE_FLOW_ENDPOINT_URL`, `KADI_INVOICE_FLOW_ENDPOINT_PATH`, `KADI_INVOICE_FLOW_TEST_RECIPIENTS`, `KADI_INVOICE_FLOW_TEST_TRIGGER`, `KADI_INVOICE_FLOW_SESSION_TTL_MINUTES`, `KADI_INVOICE_MAX_ITEMS`, `KADI_FLOW_PRIVATE_KEY`, `KADI_FLOW_PRIVATE_KEY_PASSPHRASE`.

La route HTTP locale est `POST /data_exchange` (modifiable uniquement via `KADI_INVOICE_FLOW_ENDPOINT_PATH`) et reste désactivée tant que `KADI_INVOICE_FLOW_ENABLED` n'est pas explicitement `true`.

Avant activation, le JSON, l'URL HTTPS et la clé publique devront être validés dans Meta Flow Builder. Aucune configuration Meta n'est réalisée par ce code.

Le nom suivi `.env.exeample` est historique dans ce dépôt et reste volontairement inchangé. Seules des variables factices peuvent y être documentées.
