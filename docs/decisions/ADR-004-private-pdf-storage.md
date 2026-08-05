# ADR-004 — Stockage privé des PDF générés

**Statut :** `VALIDATED_CANARY` pour le principe de stockage privé ; le QR
de vérification associé reste `PLANNED`.

## Contexte

Les documents générés par Kadi (factures, devis, reçus, décharges)
contiennent des données métier et parfois personnelles (nom du client,
montants, coordonnées). Un stockage accessible publiquement par simple
connaissance d'une URL exposerait ces données à quiconque devine ou obtient
le lien, sans contrôle d'accès.

## Décision

Tout artefact PDF final est stocké de façon **privée** : l'accès au fichier
n'est pas ouvert par défaut et passe par un contrôle applicatif (le backend
Kadi reste l'autorité), pas par une URL publique permanente. Chaque fichier
final référence une version immuable du document dont il est issu ; une
correction ultérieure ne remplace jamais silencieusement un fichier déjà
livré (voir `docs/kadi_v1_foundational_decisions.md`, décision KFD-007, pour
le détail historique de ce principe).

## Alternatives envisagées

* **Stockage public avec URL non devinable (obscurité par le lien)** —
  écarté : ne constitue pas un contrôle d'accès réel, et un lien peut être
  transféré ou intercepté sans que Kadi puisse le révoquer.
* **Envoi du PDF uniquement en pièce jointe WhatsApp, sans conservation
  côté serveur** — écarté comme solution unique : empêche l'historique et le
  retéléchargement (voir [`../KADI_ROADMAP.md`](../KADI_ROADMAP.md)), et
  complique la preuve d'intégrité d'un document déjà livré.

## Conséquences

* L'historique et le retéléchargement sécurisé (`kadiV1HistoryService.js`)
  peuvent s'appuyer sur ce stockage privé sans nouvelle génération ni
  nouveau débit de crédit.
* Un QR code ou une page de vérification externe, permettant à un tiers de
  confirmer l'authenticité d'un document sans accès direct au stockage
  privé, est prévu mais **non implémenté** — statut `PLANNED`, voir
  [`../KADI_PRODUCT_RULES.md`](../KADI_PRODUCT_RULES.md).
* Toute évolution du mécanisme de stockage doit préserver l'immuabilité de
  version déjà établie : un fichier livré ne doit jamais être modifié en
  place.

## Statut

`VALIDATED_CANARY` pour le principe de confidentialité et d'immuabilité.
`PLANNED` pour le QR / la page de vérification externe associée.
