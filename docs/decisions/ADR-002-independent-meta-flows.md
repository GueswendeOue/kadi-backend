# ADR-002 — Flows Meta indépendants et mono-écran

**Statut :** `VALIDATED_CANARY`

## Contexte

La conception initiale de P8.A1 regroupait la décision « ajouter un article
/ terminer » (`DOCUMENT_CONTENT`) et le formulaire de saisie d'article
(`ARTICLE_FORM`) dans un seul Flow Meta à deux écrans, partageant un même
`flow_key`. En production, Meta a refusé cette approche avec l'erreur
**#131009** : « Specified screen ARTICLE_FORM is not allowed as first screen
of this flow ». Voir la fiche B de
[`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md) pour le
détail de l'incident.

La cause est une contrainte de la plateforme Meta : un Flow ne peut être
ouvert que sur son **premier écran déclaré**. Un Flow multi-écrans ne peut
donc pas être navigué en ouvrant directement un écran interne, ce qui rendait
impossible la réouverture ciblée de l'écran de saisie d'article après le
premier article ajouté.

## Décision

Chaque Flow Meta du dépôt est verrouillé au contrat suivant :

* **exactement un écran**, marqué `terminal: true` ;
* `routing_model` réduit à `{ [flow_key]: [] }` (aucune transition interne
  déclarée) ;
* l'identifiant de l'écran (`screens[0].id`) est égal au `flow_key` lui-même.

Un parcours à plusieurs étapes logiques (ex. décision puis saisie) est donc
implémenté comme **plusieurs Flows indépendants**, chacun avec son propre
`flow_key`, sa propre variable Render, sa propre entrée dans
`KADI_V1_DRAFT_FLOW_CATALOG`, et son propre passage par la contrainte
Supabase `expected_flow_key`. Le routage entre ces Flows est assuré côté
backend (`kadiV1ProductionPresenter.js`, fonction `nextFlowForReply`), pas
par Meta.

Ce contrat est vérifié automatiquement par `kadiV1ReleaseGate.js`
(`validateFlowJson`) et par `kadiV1ProductionPresenter.js`
(`loadFlowRegistry`), qui rejettent tout Flow non conforme avant qu'il ne
puisse être présenté à un utilisateur.

## Alternatives envisagées

* **Flow à deux écrans terminaux sous un même `flow_key`** — tentée en
  premier lieu, rejetée par Meta (#131009) en conditions réelles.
* **Un unique Flow géant couvrant tout le parcours document** — écarté :
  aggrave le même problème de navigation interne à mesure que le nombre
  d'écrans augmente, et rend le fichier JSON difficile à faire évoluer sans
  risque de régression sur des écrans non concernés par un changement donné.

## Conséquences

* Ajouter une nouvelle étape logique au parcours signifie presque toujours
  ajouter un nouveau `flow_key` complet (JSON, action, variable, routage,
  contrainte Supabase, tests) plutôt qu'un écran supplémentaire dans un Flow
  existant — voir
  [`../runbooks/ADD_NEW_META_FLOW.md`](../runbooks/ADD_NEW_META_FLOW.md).
* Le registre `FLOW_KEYS` grandit avec chaque nouvelle étape logique
  (`ARTICLE_FORM` puis `INVOICE_TYPE`), ce qui est un coût accepté en
  échange de la fiabilité de navigation.
* La contrainte Supabase `expected_flow_key` doit être mise à jour à chaque
  nouveau `flow_key`, sous peine de reproduire l'incident décrit en fiche D
  de [`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md).

## Statut

`VALIDATED_CANARY` pour le contrat lui-même et pour `ARTICLE_FORM`
(déployé et validé). `INVOICE_TYPE` applique le même contrat mais reste
`IMPLEMENTED_NOT_DEPLOYED` — voir
[`../KADI_CURRENT_STATE.md`](../KADI_CURRENT_STATE.md).
