# KADI_FACTURE_V1 — fondation dynamique

Cette fondation locale n'est reliée ni au webhook actif, ni au portefeuille, ni à l'envoi PDF.

- Flow JSON `7.3`, protocole de données `3.0`.
- Routage déclaré strictement orienté vers l'avant : `CLIENT` → `ARTICLE_CART` → `OPTIONS` → `DOCUMENT_ESTIMATE`.
- « Ajouter un autre article » renvoie dynamiquement `ARTICLE_CART` depuis l'endpoint `data_exchange`, avec résumé, compteur et sous-total recalculés. L'écran est renvoyé sans valeur initiale pour que les champs et sélections repartent vides; ce rafraîchissement serveur n'est volontairement pas déclaré comme auto-route dans `routing_model`.
- « Terminer les articles » ajoute le dernier article de façon idempotente puis avance vers `OPTIONS`.
- Le backend conserve le panier canonique `items[]`, déduplique les actions et limite techniquement un document à 100 articles.
- Les requêtes de l'endpoint utilisent RSA-OAEP SHA-256 puis AES-128-GCM. La réponse réutilise la clé AES avec l'IV inversé, conformément à l'exemple officiel WhatsApp.
- Le dry-run PDF appelle le renderer final `kadiPdf.buildPdfBuffer`, puis compte les pages du buffer réellement rendu avec `pdf-lib`; il ne se fonde pas sur un nombre fixe d'articles.
- Le buffer reste en mémoire : aucun débit, aucun envoi, aucune entrée d'historique et aucun artefact temporaire. Le résultat interdit explicitement tout débit de production dans cette fondation.
- La politique tarifaire doit toujours être injectée explicitement.

Variables documentées : `KADI_INVOICE_FLOW_ENABLED`, `KADI_INVOICE_FLOW_ID`, `KADI_INVOICE_FLOW_MODE`, `KADI_INVOICE_FLOW_ENDPOINT_URL`, `KADI_INVOICE_FLOW_ENDPOINT_PATH`, `KADI_INVOICE_MAX_ITEMS`, `KADI_FLOW_PRIVATE_KEY`, `KADI_FLOW_PRIVATE_KEY_PASSPHRASE`.

La route HTTP locale est `POST /data_exchange` (modifiable uniquement via `KADI_INVOICE_FLOW_ENDPOINT_PATH`) et reste désactivée tant que `KADI_INVOICE_FLOW_ENABLED` n'est pas explicitement `true`.

Avant activation, le JSON, l'URL HTTPS et la clé publique devront être validés dans Meta Flow Builder. Aucune configuration Meta n'est réalisée par ce code.

Le nom suivi `.env.exeample` est historique dans ce dépôt et reste volontairement inchangé. Seules des variables factices peuvent y être documentées.
