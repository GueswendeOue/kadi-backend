# ADR-003 — Modèle de crédits par page de PDF finale

**Statut :** `VALIDATED_CANARY` pour le principe ; certains raffinements
restent `PLANNED` (voir « Conséquences »).

## Contexte

Kadi doit financer la génération de documents PDF tout en restant simple et
prévisible pour une cible peu familière des modèles d'abonnement ou de
facturation à l'usage complexe. Le coût réel dépend directement du nombre de
pages du PDF final, qui n'est connu qu'après un rendu réel du document.

## Décision

* Le portefeuille de l'utilisateur est débité **uniquement** au moment de la
  génération finale confirmée, à raison d'**un crédit par page du PDF
  final**.
* L'aperçu, la modification et toute correction avant confirmation ne
  coûtent **rien**.
* Une génération qui échoue ne débite **rien**.
* Retélécharger un PDF déjà généré ne débite **rien**.
* Une nouvelle version régénérée après correction est facturée selon son
  propre nombre de pages réel, recalculé après un nouveau rendu.
* Aucun débit n'a lieu avant, dans l'ordre : génération réelle d'un rendu,
  calcul du nombre de pages réel, présentation du coût et du solde à
  l'utilisateur, confirmation explicite de l'utilisateur.
* Un nouvel utilisateur réellement nouveau reçoit exactement cinq crédits de
  bienvenue, une seule fois, par une écriture atomique et idempotente.
  Aucune régularisation ne recalcule ou ne remet à zéro un portefeuille déjà
  existant.

## Alternatives envisagées

* **Abonnement mensuel forfaitaire** — écarté pour la V1 : introduit un
  engagement financier récurrent peu adapté à une cible aux revenus
  irréguliers, et complique le lancement initial.
* **Coût fixe par document, indépendant du nombre de pages** — écarté :
  crée une iniquité entre un document d'une page et un document de dix
  pages, et une incitation perverse à limiter artificiellement le contenu.
* **Débit avant génération, sur une estimation du nombre de pages** —
  écarté : le nombre de pages réel ne peut être connu qu'après rendu ;
  débiter sur une estimation risquerait un débit incorrect en cas d'écart.

## Conséquences

* Le pipeline de génération doit produire un rendu réel (même temporaire)
  avant tout calcul de coût — voir
  [`../KADI_ARCHITECTURE.md`](../KADI_ARCHITECTURE.md).
* Le débit doit être une opération idempotente, robuste aux retries de
  webhook.
* Le raffinement de la robustesse du débit dans les cas limites (échec
  partiel, retry concurrent) reste `PLANNED` — voir
  [`../KADI_ROADMAP.md`](../KADI_ROADMAP.md), point « débit de crédits
  robuste ».

## Statut

`VALIDATED_CANARY` pour le principe et les règles listées ci-dessus (voir
[`../KADI_PRODUCT_RULES.md`](../KADI_PRODUCT_RULES.md)). Le durcissement des
cas limites reste `PLANNED`.
