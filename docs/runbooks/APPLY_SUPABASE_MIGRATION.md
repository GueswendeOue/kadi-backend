# Runbook — Écrire et appliquer une migration Supabase

## Convention de fichiers

Toute migration corrective est **forward-only** et écrite en deux copies
byte-identiques :

* `supabase/migrations/<timestamp_complet_YYYYMMDDHHMMSS>_<description>.sql`
* `migrations/<date_YYYYMMDD>_<description>.sql`

Le style habituel du dépôt pour une correction de contrainte est
`drop constraint if exists ...` suivi de `add constraint ...` (pas de
`BEGIN`/`COMMIT` explicite ; Supabase applique chaque fichier dans sa propre
transaction).

## Interdictions strictes

* **Ne jamais modifier une migration déjà appliquée.** Une migration
  appliquée est un fait historique ; toute correction ultérieure est une
  **nouvelle** migration qui ajoute ou corrige, jamais une édition du
  fichier existant.
* **Ne jamais exécuter un `db reset` distant.** Cette opération efface des
  données réelles ; elle n'a pas sa place dans un flux de correction.
* **Ne jamais exécuter `supabase migration repair` sans compréhension
  préalable.** `repair` modifie l'historique de migrations connu par
  Supabase, pas la base elle-même — l'utiliser sans avoir d'abord comparé le
  SQL distant et local peut faire croire à tort qu'une migration réelle a
  été appliquée ou non. Voir fiche E de
  [`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md).
* **Ne jamais appliquer une migration si le dry-run montre des migrations
  inattendues.** Si `db push --dry-run` liste autre chose que la migration
  qu'on s'attend à appliquer, s'arrêter et comprendre l'écart avant de
  continuer.

## Procédure

1. **Écrire la migration** localement, en respectant le principe
   forward-only ci-dessus. Écrire un commentaire SQL bref expliquant le
   pourquoi de la migration.
2. **Créer les deux copies** byte-identiques (`supabase/migrations/` et
   `migrations/`) et vérifier leur identité octet par octet.
3. **Écrire un test** qui vérifie : présence des deux fichiers, identité
   byte-à-byte, non-modification des migrations déjà appliquées, forme
   attendue du changement (ex. nombre exact de valeurs ajoutées à une
   contrainte).
4. **`migration list`** : comparer l'état des migrations connues en local et
   en distant avant toute action, pour détecter une désynchronisation
   éventuelle (voir fiche E de
   [`../KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md)).
5. **`db push --dry-run`** : lire intégralement la sortie. Si elle contient
   une migration non attendue, s'arrêter.
6. **Application distante** — action externe, uniquement avec autorisation
   explicite de la mission.
7. **Vérification SQL en lecture seule** après application : relire la
   définition de l'objet modifié (ex. `\d+` sur la contrainte) sans exécuter
   d'écriture, pour confirmer que le résultat correspond exactement à ce qui
   était attendu.
8. **Suivi Git** : si une migration a été appliquée en distant par un autre
   moyen que ce flux (cas de régularisation), l'ajouter au suivi Git dès que
   son équivalence de contenu est prouvée — ne jamais laisser Git diverger
   silencieusement de l'état distant réel.

## Après application

* Mettre à jour [`../KADI_CURRENT_STATE.md`](../KADI_CURRENT_STATE.md) pour
  refléter que la migration est désormais confirmée appliquée en distant,
  pas seulement écrite localement.
