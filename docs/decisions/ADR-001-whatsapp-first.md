# ADR-001 — WhatsApp comme seule interface (WhatsApp-first)

**Statut :** `VALIDATED_CANARY`

## Contexte

La cible principale de Kadi (micro-entrepreneurs, commerçants, artisans et
secteur informel au Burkina Faso) utilise très majoritairement WhatsApp
comme canal de communication quotidien. Une application dédiée ou un site
web séparé introduit une friction d'installation, de compte et
d'apprentissage que cette cible n'a historiquement pas l'habitude de
franchir pour un outil administratif.

## Décision

Kadi AI est conçu **WhatsApp-first** : l'intégralité de l'expérience
(demande, collecte d'informations, vérification, génération et livraison de
document) se déroule dans une conversation WhatsApp, via l'API WhatsApp
Business Cloud. Les Flows Meta servent d'infrastructure de vérification
structurée, mais restent une couche technique invisible pour l'utilisateur.

## Alternatives envisagées

* **Application mobile dédiée** — écartée : coût d'acquisition et
  d'installation trop élevé pour la cible visée, alors que WhatsApp est déjà
  installé.
* **Site web / tableau de bord web pour la saisie** — écarté pour le
  parcours principal : introduit une bascule de canal qui casse la
  continuité conversationnelle ; peut rester envisageable plus tard pour des
  usages secondaires (ex. tableau de bord admin), mais pas pour le parcours
  utilisateur principal.
* **SMS simple** — écarté : pas de support riche (boutons, formulaires
  structurés, envoi de photo/audio) suffisant pour les Flows de saisie.

## Conséquences

* Toute nouvelle fonctionnalité utilisateur doit être conçue pour
  fonctionner dans les contraintes de l'API WhatsApp Business Cloud (Flows,
  messages interactifs, médias).
* Les frontières techniques des Flows (voir
  [`ADR-002-independent-meta-flows.md`](ADR-002-independent-meta-flows.md))
  doivent rester invisibles : l'utilisateur doit avoir l'impression de
  parler à une seule assistante.
* Toute dépendance à un canal externe à WhatsApp pour le parcours principal
  (paiement excepté, qui reste hors WhatsApp par nature) doit être justifiée
  explicitement avant d'être introduite.

## Statut

`VALIDATED_CANARY` — c'est l'architecture actuellement en place et testée en
CANARY.
