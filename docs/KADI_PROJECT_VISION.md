# Vision du projet Kadi

Statut du présent document : vision produit, stable dans son intention
générale. Les éléments datés ou en cours vivent dans
[`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md), pas ici.

## Ce qu'est Kadi

Kadi AI est un assistant administratif conversationnel, **WhatsApp-first** :
l'utilisateur interagit uniquement par WhatsApp, sans application séparée à
installer, sans compte web à créer.

Kadi n'est **pas** un simple générateur de PDF. L'objectif est une assistante
qui comprend une demande exprimée naturellement, extrait les données utiles,
ne demande que ce qui manque réellement, puis fait vérifier, corriger et
confirmer le document avant de le produire.

## Cible

* Micro-entrepreneurs ;
* commerçants ;
* artisans ;
* prestataires du secteur informel ou faiblement outillé.

Lancement initial : **Burkina Faso**.

## Documents couverts

* facture ;
* devis ;
* reçu ;
* décharge.

## Entrées utilisateur

* texte (disponible) ;
* vocal (PLANNED / en construction progressive, voir
  [`KADI_ROADMAP.md`](KADI_ROADMAP.md)) ;
* photo / OCR (PLANNED).

Ne jamais présenter le vocal entrant ou la photo/OCR comme déjà pleinement
opérationnels tant que [`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md) ne
les indique pas `VALIDATED_CANARY`.

## Valeurs guidant les décisions produit

* **simplicité** : une information principale, une seule action suivante,
  au maximum une question à la fois ;
* **rapidité** : premier document rapidement accessible après la première
  demande ;
* **crédibilité** : documents professionnels, cohérents, sans erreur de
  calcul ;
* **traçabilité** : chaque document a une date serveur, un numéro, une
  version, un historique.

## Parcours visé

De la première demande au premier document généré, la friction doit rester
minimale : Kadi collecte progressivement ce qu'il faut (formalisation
progressive), sans forcer un formulaire complet dès le premier message.

Les Flows Meta sont une infrastructure de vérification structurée ; leurs
frontières techniques doivent rester invisibles pour l'utilisateur, qui doit
avoir l'impression de parler à une seule assistante.

## Vision au-delà de la V1 (PLANNED, non disponible aujourd'hui)

* paiements et recharge intégrés ;
* support utilisateur structuré (tickets) ;
* impression et équipements compatibles (ex. imprimantes thermiques pour
  reçu ticket) ;
* historique et retéléchargement sécurisé des documents déjà générés.

Ces éléments sont des directions, pas des engagements de calendrier. Voir
[`KADI_ROADMAP.md`](KADI_ROADMAP.md) pour le séquencement réel et
[`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md) pour ce qui est
effectivement en place aujourd'hui.
