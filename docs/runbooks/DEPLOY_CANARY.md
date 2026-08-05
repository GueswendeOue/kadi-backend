# Runbook — Déployer en CANARY sur Render

## Portée

* **Service `kadi-backend` uniquement.**
* **Ne jamais** déclencher un déploiement ou une modification sur
  `kadi-beta-cleanup` ou `kadi-beta-notify` — ces services sont hors
  périmètre par restriction explicite du projet (voir
  [`../../CLAUDE.md`](../../CLAUDE.md)).

## Avant le déploiement

* S'assurer que les prérequis du Flow concerné sont satisfaits (JSON publié
  sur Meta si applicable, variable Render posée, migration Supabase
  appliquée — voir
  [`../KADI_RELEASE_CHECKLIST.md`](../KADI_RELEASE_CHECKLIST.md)).
* **Vérifier le commit exact** qui sera déployé : il doit correspondre au
  commit déjà testé localement (`npm test` exécuté sur ce commit précis,
  pas sur un état différent).

## Déploiement

* Déclencher le déploiement uniquement avec autorisation explicite de la
  mission.
* **Attendre le statut Live** confirmé sur Render avant de considérer le
  déploiement terminé — un déploiement « en cours » n'est pas un
  déploiement réussi.

## Configuration de rollout

* **Utiliser uniquement la configuration CANARY déjà autorisée**
  (`KADI_V1_ROLLOUT_MODE=CANARY`, `KADI_V1_CANARY_WA_IDS` déjà défini).
* **Ne jamais activer `FULL`** sans autorisation explicite du fondateur —
  voir [`../KADI_CURRENT_STATE.md`](../KADI_CURRENT_STATE.md).
* Ne pas ajouter de nouveau numéro à `KADI_V1_CANARY_WA_IDS` sans
  autorisation explicite.

## Après le déploiement

* Démarrer un **nouveau parcours CANARY** depuis un message entrant frais —
  ne jamais valider un déploiement en reprenant une session WhatsApp ouverte
  avant ce déploiement (fiche F de
  [`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md)).
* Contrôler les logs (absence de secret, token, `wa_id` complet ou payload
  complet) et l'absence de débit de crédit inattendu.
* Mettre à jour [`../KADI_CURRENT_STATE.md`](../KADI_CURRENT_STATE.md) avec
  le statut réel observé après ce parcours, pas avant.
