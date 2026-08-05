# Runbook — Revenir en arrière après un incident en production

## Avant toute action

* **Identifier le dernier commit validé** connu comme stable (déployé,
  vérifié en CANARY, sans incident ouvert) — voir
  [`../KADI_CURRENT_STATE.md`](../KADI_CURRENT_STATE.md) et l'historique Git
  des merges de mission.
* **Vérifier les migrations irréversibles** appliquées depuis ce commit.
  Une migration forward-only qui a ajouté une valeur à une contrainte (ex.
  un nouveau `flow_key`) n'a généralement pas besoin d'être annulée pour
  revenir à un code antérieur : le code antérieur ignore simplement la
  valeur ajoutée. Ne confondre ce cas avec une migration qui aurait modifié
  ou supprimé des données.

## Interdiction stricte

* **Ne jamais restaurer une ancienne migration en la modifiant.** Un
  rollback de code ne doit jamais s'accompagner d'une édition rétroactive
  d'un fichier de migration déjà appliqué. Si un rollback de schéma est
  réellement nécessaire, il s'écrit comme une **nouvelle** migration
  forward-only qui défait l'effet de la précédente, jamais comme une
  modification du fichier existant — voir
  [`APPLY_SUPABASE_MIGRATION.md`](APPLY_SUPABASE_MIGRATION.md).

## Procédure

1. Identifier le commit cible du rollback (dernier commit stable).
2. Vérifier que ce commit ne dépend pas d'un état de schéma Supabase
   incompatible avec l'état distant actuel (voir étape « migrations
   irréversibles » ci-dessus).
3. Effectuer le rollback de déploiement sur Render (service `kadi-backend`
   uniquement — voir [`DEPLOY_CANARY.md`](DEPLOY_CANARY.md)), uniquement
   avec autorisation explicite.
4. **Documenter le rollback** : commit de départ, commit cible, raison,
   heure. Ajouter une fiche à
   [`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md) si
   l'incident correspond à une cause confirmée nouvelle.
5. **Tester un nouveau parcours CANARY** après le rollback, depuis un
   message entrant frais, pour confirmer que l'état restauré fonctionne
   réellement (ne pas se fier à une reprise de session antérieure — fiche F
   de [`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md)).
6. Mettre à jour [`../KADI_CURRENT_STATE.md`](../KADI_CURRENT_STATE.md) pour
   refléter l'état réellement en production après le rollback.
