# Kadi V1 — Stratégie de tests et release gate

## Objectif

Cette stratégie définit les preuves nécessaires avant une publication coordonnée. L'audit du dépôt recense 248 déclarations `test(...)`; ce nombre est un inventaire statique, pas un résultat d'exécution pour cette mission.

## Niveaux d'environnement

| Niveau | Réseau/coût | Usage | Données |
|---|---|---|---|
| L0 — pur local | aucun appel externe | domaine, contrats, state machine, calculs, copy | fixtures synthétiques |
| L1 — intégration locale | Supabase/HTTP simulés | repositories, migrations, crypto, clients providers mockés | base éphémère anonymisée |
| L2 — sandbox providers | API réelle bornée | OCR, STT, TTS et paiement sandbox | médias fictifs/consentis |
| L3 — Meta DRAFT | WhatsApp/Meta réels | Flows, endpoint chiffré, cartes, reprise | numéros test autorisés uniquement |
| L4 — manuel prépublication | appareils réels | UX, voix, lisibilité, réseau | scénarios fictifs contrôlés |
| L5 — postpublication sentinelle | production bornée | smoke et métriques | compte interne autorisé |

Les tests L0/L1 sont sans coût externe. L2 utilise des API réelles avec budget, quotas et redaction. L3 exige des Flows DRAFT et une autorisation explicite. L4 est manuel. L5 n'est autorisé qu'après publication approuvée.

## Socle de fixtures

* Identités pseudonymes distinctes : nouveau, onboarding interrompu, existant ancien, solde nul après bonus, solde suffisant, solde insuffisant.
* Quatre documents synthétiques avec variantes complète, partielle, ambiguë et contradictoire.
* Articles couvrant quantité fractionnaire, taxe, remise, zéro interdit, limites et plusieurs pages.
* Images nettes/floues, tableaux, montants contradictoires et PDF multi-pages sans donnée réelle.
* Audios français avec noms locaux, montants, bruit raisonnable et contenu sensible.
* Réponses providers : succès, timeout, JSON invalide, contenu hostile, quota et indisponibilité.
* Webhooks dupliqués, hors ordre et concurrents pour Meta, paiement et livraison.

## Matrice automatisée

### Tests unitaires L0

| Domaine | Cas obligatoires |
|---|---|
| Document | FACTURE/DEVIS/RECU, décharge séparée, champs conditionnels, calculs serveur |
| State machine | chaque transition autorisée, chaque transition interdite, version obsolète, annulation et reprise |
| Idempotence | même clé/même payload, même clé/payload différent, concurrence, expiration |
| Calculs | sous-total depuis items, taxes, remise, total, arrondis FCFA, `items.length` |
| Preview | projection par version, invalidation après édition, aucun débit |
| Pages/coût | 1, 2 et 3+ pages, tarif inconnu, quote expirée, changement de version |
| Voice policy | trois préférences, sensibilité dominante, demande explicite, provider absent |
| Providers | schéma strict, incertitudes, redaction, timeout/fallback, aucune autorité métier |
| Copy | texte canonique, libellés Meta, termes interdits, action unique |

### Tests de contrats L0/L1

* Contrat webhook WhatsApp et priorité `nfm_reply` avant MENU/IA.
* Contrat chiffré Meta : signature, enveloppe, déchiffrement, INIT, réponse et erreurs fermées.
* Contrats de tous les Flows : données reçues/retournées, types, limites et destinations.
* Contrat provider OpenAI/Gemini/STT/TTS : mêmes erreurs normalisées et aucune fuite SDK.
* Contrat wallet : solde non négatif, ledger unique, reasons fermés et résultat idempotent.
* Contrat stockage : temporaire privé, final immuable et média WhatsApp réutilisable.

### Tests SQL et migrations L1

Pour chaque migration : base vide, copie avec données représentatives, exécution répétée si conçue idempotente, precheck/postcheck et compatibilité runtime N-1/N.

Vérifier :

* contraintes de type/statut/version et clés étrangères ;
* index uniques `wa_id`, ledger operation key, document/version et provider reference ;
* RLS propriétaire et refus inter-utilisateur ;
* nombre de profils, wallets, ledgers, documents, items et sessions avant/après ;
* aucun changement de solde lors des backfills ;
* aucun bonus automatique aux utilisateurs existants ;
* anciennes sessions lisibles jusqu'à expiration ou rejetées proprement ;
* rollback du runtime sans suppression de colonnes/données nouvelles.

## Tests par capacité

### Onboarding et cinq crédits

* Nouveau `wa_id` : profil minimal, exactement 5, un ledger `WELCOME_CREDITS`, marqueur vrai.
* Deux webhooks/doubles clics/concurrence : une seule écriture.
* Solde positif, nul ou crédits consommés : le solde seul ne change jamais l'éligibilité.
* Ré-onboarding, reprise, réactivation et changement vocal : aucun nouveau bonus.
* Ancien profil ambigu : aucune attribution sans migration auditée.
* Texte envoyé seulement après bonus confirmé ; vocal fidèle tenté ensuite.
* Panne TTS : texte et onboarding continuent, retry vocal sans recrédit.

### Conversation et documents

Pour facture, devis, reçu et décharge : demande naturelle complète, manque unique, plusieurs manques, correction, interruption, expiration, reprise et annulation. Vérifier le vocabulaire propre au type, la propriété, la version et l'absence de données inventées.

### OCR et photo

* Tests simulés L0 avec sorties Gemini et OpenAI historiques normalisées.
* Tests L2 bornés sur corpus approuvé : photos, tableaux et PDF.
* Valeur confirmée/incertaine/absente/contradictoire distinguée.
* Aucun total final ni persistance confirmée tant qu'une valeur requise est incertaine.
* Taille/type/média invalide rejetés sans log sensible.

### Vocal entrant

* L0 : transcription mockée, routage, ambiguïtés, instructions internes rejetées.
* L2 : formats WhatsApp réels, noms locaux, montants et bruit.
* Timeout/quota : demande humaine de réessai ou texte, contexte conservé.

### Réponse vocale

* Texte canonique toujours envoyé.
* Audio généré uniquement depuis la même version/empreinte.
* Montants, noms, dates et statuts identiques entre texte et audio.
* Données sensibles bloquées ; voix clonée impossible sans consentement.
* Format WhatsApp, durée, latence et suppression sans effet métier.

### Wallet, coût et génération

* Rendu temporaire non livré et sans débit.
* Nombre réel de pages déterminé par le renderer final pour les quatre types.
* Quote liée à version/tarif, coût et solde affichés avant confirmation.
* Solde insuffisant : aucun débit, brouillon conservé.
* Confirmation dupliquée/concurrente : un débit et un fichier.
* Timeout avant/après débit, génération, stockage et envoi : reprise correcte.
* Livraison retry : même fichier, aucun débit ni génération supplémentaire.

### Recharge et paiement

* Pack issu de la configuration centrale.
* Retour client sans webhook : aucun crédit.
* Webhook authentique, doublé, hors ordre, montant/référence faux.
* Crédit unique puis reprise du même document à la confirmation.
* Quote expirée pendant recharge : nouveau rendu/coût, jamais génération automatique.

### Historique et recherche

* Brouillons et finals selon droits ; utilisateurs séparés.
* Pagination stable sans perte/doublon.
* Filtres type, client/bénéficiaire, numéro et période.
* Document historique legacy rendu sans duplication.
* Reprise d'un brouillon à sa version serveur.

## Tests Meta Flows

### Non-régression des sept Flows facture actuels

Conserver les tests de JSON mono-écran, mapping IDs, sessions, INIT, données par écran, corrections, trois articles, crypto et `nfm_reply`. Ils protègent la preuve technique pendant la refonte.

### Futurs Flows DRAFT

Pour chaque Flow : JSON et routing officiels, data contract, textes français, longueurs, cible backend, expiration, annulation et reprise. Vérifier l'asset, `validation_errors=[]`, endpoint et health sans publier.

Un parcours DRAFT complet couvre : onboarding → menu/intention → document → corrections → preview → coût → recharge éventuelle → confirmation simulée sans publication. Les opérations réelles de débit/livraison utilisent uniquement un environnement explicitement autorisé.

## Tests WhatsApp réels et mobiles

Maximum par campagne : comptes autorisés, scénarios numérotés, fenêtres courtes, logs corrélés et arrêt au premier effet sensible inattendu.

Appareils : petit Android, Android courant, iPhone courant si supporté, police agrandie. Réseaux : stable, lent, coupure/reprise. Vérifier clavier, troncature, retour, fermeture, ordre des cartes, texte/audio, média et absence de frontière technique visible.

Les tests manuels prépublication couvrent les quatre types, texte, vocal, photo, correction, recharge sandbox, historique/recherche et reprise après interruption.

## Sécurité et robustesse

* Webhooks/signatures invalides, replay, payloads surdimensionnés et structures hostiles.
* Propriété de profil, draft, document, fichier, paiement et historique.
* Aucun secret, token, `wa_id` complet, média ou donnée client dans les logs.
* SSRF/URL média, types MIME, tailles, fichiers corrompus et archives/PDF hostiles.
* Injection dans prompts, JSON, SQL/RPC et champs Meta.
* Concurrence sur bonus, items, correction, confirmation, recharge, génération et livraison.
* RLS et service-role séparés ; aucune clé privée côté client.
* Suppression complète des fonctions/coûts de tampon dans le chemin V1.

## Charge raisonnable

Sans stress agressif de services externes : tester localement rafales de webhooks dupliqués, verrous sur un même utilisateur, utilisateurs distincts, génération concurrente bornée et pagination. Mesurer p50/p95, mémoire, taille des files et taux d'erreur. Les appels providers réels sont limités par quota et remplacés par mocks pour la charge.

## Non-régression

La suite existante reste obligatoire tant que les modules historiques sont actifs. Ajouter des tests de caractérisation avant chaque adaptation, puis retirer un test legacy uniquement avec la fonctionnalité dépréciée et une preuve équivalente dans le nouveau chemin.

Gate de CI recommandé :

1. lint/Markdown et secret scan ;
2. tests unitaires et contrats ;
3. tests repositories/migrations éphémères ;
4. tests PDF avec empreintes et pages ;
5. suite complète sans API réelle ;
6. canary providers séparé, non bloquant hors fenêtre release ;
7. rapport de couverture par capacité, pas seulement nombre de tests.

## Release gate final

Aucune publication si un élément obligatoire n'est pas `PASS` avec preuve datée :

| Domaine | Preuve minimale PASS |
|---|---|
| Onboarding | texte canonique, vocal non bloquant, action « Commencer », reprise |
| Cinq crédits | exactement 5, ledger/marqueur atomiques, concurrence et anciens utilisateurs |
| Menu | quatre raccourcis et langage naturel prioritaire |
| Facture | parcours complet, calculs et corrections |
| Devis | vocabulaire, validité approuvée, parcours complet |
| Reçu | paiement reçu, minimum approuvé, parcours complet |
| Décharge | parties/sujet/motif, parcours spécifique complet |
| Texte | complet/partiel/ambigu, une question à la fois |
| Vocal entrant | transcription, ambiguïtés, fallback |
| Réponse vocale | fidélité, préférence, confidentialité, benchmark |
| Photo/OCR | images/PDF, incertitudes, aucun calcul IA autoritaire |
| Corrections | données non visées conservées, version/coût invalidés |
| Aperçu | projection complète, aucun débit |
| Coût | pages réelles, tarif central, quote/version |
| Solde insuffisant | aucun débit, brouillon conservé |
| Recharge | paiement vérifié, crédit unique, reprise |
| Génération | confirmation explicite, débit/fichier uniques |
| Livraison | fichier final livré ou relivrable sans redébit |
| Historique/recherche | propriété, pagination, legacy, reprise |
| Interruptions/reprises | dernier état sûr, aucune duplication |
| Idempotence | retries et concurrence aux frontières sensibles |
| Sécurité | crypto, RLS, secrets, médias, providers et logs |
| Mobile | tailles, police, réseaux et médias validés |
| Textes français | catalogue final, limites Meta, termes interdits absents |
| Meta | tous assets validés, aucune carte anglaise après publication |

Conditions globales : zéro `FAIL` sécurité/paiement/crédit/génération/propriété ; aucun `BLOCKED` sur une capacité obligatoire ; migrations répétées sur copie représentative ; rollback répété ; métriques et astreinte prêtes ; autorisation écrite du fondateur.

## Publication et surveillance

Après le gate seulement : sauvegarde, migrations déjà répétées, déploiement backend compatible, publication coordonnée, bascule des IDs, smoke sentinelle, surveillance rapprochée. Seuils d'arrêt : double crédit/débit, perte de données, fuite, erreur systémique Flow, incohérence texte/audio ou PDF. En cas d'arrêt, désactiver la nouvelle entrée et préserver les opérations engagées par leur clé plutôt que réexécuter aveuglément.
