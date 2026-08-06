# Runbook — Déployer en CANARY sur Render

## Règle de release obligatoire (confirmée 2026-08-06)

**`kadi-backend` sur Render n'auto-déploie jamais `main`** — l'API Render
confirme `autoDeploy:"no"` pour ce service ; tout historique de déploiement
observé est `trigger:"manual"` (ou `"rollback"`), jamais automatique. Une
fusion GitHub réussie dans `main` **ne prouve jamais**, à elle seule, qu'un
nouveau code est en cours d'exécution. Voir fiche P de
[`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md), sous-section
« Fenêtre de compatibilité migration-avant-déploiement (2026-08-06) », pour
l'incident confirmé qu'une hypothèse contraire a causé.

**Ordre obligatoire pour toute release touchant le backend et une migration
Supabase, dans cet ordre, sans le paralléliser :**

1. **Vérifier le SHA `main` cible** (`git rev-parse origin/main`) avant
   d'engager quoi que ce soit.
2. **Vérifier la compatibilité de la migration de base de données dans les
   deux sens** — nouveau backend face à l'ancienne base, **et** ancien
   backend face à la nouvelle base (cette seconde direction est facile à
   oublier ; c'est elle qui a causé l'incident du 2026-08-06).
3. **Appliquer la migration** uniquement selon l'ordre de release approuvé
   (voir [`../KADI_RELEASE_CHECKLIST.md`](../KADI_RELEASE_CHECKLIST.md)),
   avec autorisation explicite.
4. **Fusionner la PR approuvée** dans `main`.
5. **Déclencher explicitement un déploiement manuel Render** — la fusion
   seule ne suffit pas ; il s'agit d'une action distincte et obligatoire.
6. **Observer le build** jusqu'à son terme (succès ou échec).
7. **Vérifier que le déploiement passe à `live`** via les métadonnées
   Render (API ou tableau de bord) — un déploiement « en cours » n'est pas
   un déploiement terminé.
8. **Confirmer que les métadonnées du commit `live` correspondent
   exactement au SHA `main` attendu** (`deploy.commit.id`) — ne jamais
   déduire l'identité du code déployé depuis `GET /health` seul (réponse
   statique, sans SHA ni métadonnées de version) ni depuis le seul statut
   de fusion GitHub.
9. **Vérifier le boot et la préparation** (logs Render : boot propre,
   `KADI_V1_WEBHOOK_READY` sans `blocker`, absence de
   `KADI_V1_SERVER_FIELD_FORBIDDEN` ou d'autre erreur RPC/migration).
10. **Alors seulement commencer** la publication Meta et la validation
    CANARY.

**Interdiction explicite : ne jamais supposer qu'un déploiement a eu lieu
uniquement parce qu'une PR a été fusionnée sur GitHub.** Toute affirmation
de déploiement doit être appuyée par une vérification directe des
métadonnées Render (déploiement `live`, commit exact).

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
