# Feuille de route — Kadi V1

Ordre indicatif, pas un engagement de calendrier. Statuts :
`VALIDATED_CANARY`, `IMPLEMENTED_NOT_DEPLOYED`, `PLANNED`, `BLOCKED`,
`DEFERRED`. Voir [`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md) pour
l'état réel à date.

## Court terme

1. **Finaliser et valider INVOICE_TYPE** — `IMPLEMENTED_NOT_DEPLOYED`.
   Publication Meta, variable Render, migration Supabase distante,
   déploiement, nouveau parcours CANARY (voir
   [`KADI_RELEASE_CHECKLIST.md`](KADI_RELEASE_CHECKLIST.md)). Câbler
   également l'appelant de production manquant pour la reprise
   conversationnelle (fiche H de
   [`KADI_ENGINEERING_MEMORY.md`](KADI_ENGINEERING_MEMORY.md)).
2. **Finaliser et valider RECEIPT_DETAILS et l'écran initial DECHARGE** —
   `IMPLEMENTED_NOT_DEPLOYED`. Reçu A4 / reçu ticket 80 mm
   (`receipt_format = A4 | TICKET_80`) désormais implémentés avec un Flow
   dédié et un logo optionnel sur le format compact ; reste à publier le
   Flow `KADI_RECEIPT_DETAILS_V1`, poser `KADI_V1_FLOW_RECEIPT_DETAILS_ID`,
   appliquer la migration distante, déployer et valider par un nouveau
   parcours CANARY (voir
   [`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md)).
3. **Finaliser facture, reçu, devis et décharge** — correctifs de décharge
   restants non couverts par le point 2 — `PLANNED`.

## Moyen terme

4. **Moteur PDF professionnel** — rendu final soigné, cohérent entre types
   de documents — `PLANNED`.
5. **Date et numérotation** — renforcement de la numérotation automatique et
   de la traçabilité des dates serveur — `PLANNED`.
6. **QR et page de vérification** — authentification du document final —
   `PLANNED`.
7. **Débit de crédits robuste** — durcissement de l'idempotence et des cas
   limites du débit par page — `PLANNED`.
8. **Intention directe et reprise** — reconnaissance d'intention en langage
   naturel et reprise fiable d'un document en cours — `PLANNED`, dépend
   partiellement du point 1.

## Entrées et sorties multimodales

9. **Vocal entrant** — `PLANNED`.
10. **Photo / OCR** — extraction structurée à partir d'image ou de PDF,
    validée par le backend avant persistance — `PLANNED`.
11. **Voix sortante** — synthèse vocale fidèle au texte canonique,
    non systématique — `PLANNED`.

## Après stabilisation du cœur produit

12. **Historique et retéléchargement sécurisé** — accès aux documents déjà
    générés sans nouveau débit — `PLANNED`.
13. **Recharge et paiements** — intégration de moyens de paiement pour
    l'achat de crédits — `PLANNED`.
14. **Support utilisateur et tickets** — canal de support structuré —
    `PLANNED`.
15. **Analyse des abandons** — identifier où les utilisateurs quittent un
    parcours de document — `PLANNED`.
16. **Statistiques admin améliorées** — voir tableau de bord ci-dessous —
    `PLANNED`.
17. **Audit P8.7** — audit de cohérence transversal une fois les lots
    P8.A1/P8.A2 stabilisés en CANARY — `PLANNED`.

## Passage en `FULL`

Le passage du rollout `CANARY` vers `FULL` **n'a lieu que sur autorisation
explicite** du fondateur, jamais comme effet de bord d'une mission
technique — voir [`../AGENTS.md`](../AGENTS.md) et
[`KADI_CURRENT_STATE.md`](KADI_CURRENT_STATE.md).

## Tableau de bord admin (futur)

Commandes prévues, réservées à l'administrateur :

```
/stats
/stats global
/stats 30j
/stats 7j
/stats revenus
/stats documents
/stats parcours
/stats erreurs
```

* **Statut : `PLANNED`.**
* **`ADMIN_ONLY`** : ces commandes ne doivent jamais être accessibles à un
  utilisateur standard.
* **`FAIL_CLOSED`** : en cas de doute sur l'identité ou le droit
  administrateur, refuser l'accès plutôt que d'afficher des données
  partielles.
