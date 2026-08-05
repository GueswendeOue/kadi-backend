# Kadi V1 — Registre des décisions fondatrices

## Objet et règles du registre

Ce registre sépare les règles déjà validées des choix qui exigent encore une décision du fondateur. Il prépare les lots de domaine et de persistance sans constituer une spécification SQL ni une autorisation d'implémentation.

États autorisés :

* `PROPOSED` : recommandation à valider avant le lot indiqué ;
* `APPROVED` : règle explicitement établie dans `AGENTS.md` ou un document canonique validé ;
* `DEFERRED` : décision volontairement reportée, avec solution transitoire approuvée ;
* `REJECTED` : option explicitement écartée, conservée pour mémoire.

Une décision ne passe à `APPROVED` qu'avec une validation explicite et une mise à jour de ce registre. Les références à des modules décrivent l'existant, pas la conformité de leur comportement à la cible.

## Décisions déjà approuvées

### KFD-001 — Crédits de bienvenue uniques

* **Question :** quel bonus reçoit un nouvel utilisateur éligible ?
* **État :** `APPROVED`.
* **Recommandation :** attribuer exactement 5 crédits une seule fois après création du profil minimal, par une écriture `WELCOME_CREDITS`, avec `welcome_credits_granted=true` et la clé `welcome_credits:<wa_id>` dans une même frontière atomique.
* **Justification :** règle explicite de `AGENTS.md` §20 et de `kadi_onboarding_and_welcome_credits.md`.
* **Alternatives :** montant configurable, bonus fondé sur le solde ou bonus de réactivation ; elles ne sont pas retenues pour la V1.
* **Conséquences produit :** accueil fiable, sans double avantage après reprise ou ré-onboarding.
* **Conséquences techniques :** service backend transactionnel et idempotent ; le Flow ne crédite jamais directement.
* **Conséquences financières :** exposition bornée à cinq crédits par nouvel utilisateur éligible.
* **Risques :** anciens bonus ambigus et concurrence entre webhooks.
* **Éléments existants concernés :** `kadiOnboarding.js`, `kadiCreditsRepo.js`, `store.js`, profils et ledger distants à auditer.
* **Décision du fondateur requise :** non.
* **Lot bloqué :** LOT 2 et LOT 4 jusqu'à conception de la migration atomique.

### KFD-002 — Date d'émission sous autorité serveur

* **Question :** qui détermine la date d'un document ?
* **État :** `APPROVED`.
* **Recommandation :** produire `issued_at` uniquement côté serveur, avec les secondes, sans sélection manuelle.
* **Justification :** `AGENTS.md` §3 et §17, modèle documentaire et contrat de génération.
* **Alternatives :** date choisie par l'utilisateur ou date fournie par l'IA ; rejetées.
* **Conséquences produit :** date cohérente et vérifiable ; une date métier distincte peut exister si le type l'exige.
* **Conséquences techniques :** horloge serveur et instantané de version lors de la finalisation.
* **Conséquences financières :** aucune directe.
* **Risques :** confusion entre émission, paiement et validité du devis si les champs sont mélangés.
* **Éléments existants concernés :** `kadiRepo.js`, générateurs PDF et futurs documents/versionnements.
* **Décision du fondateur requise :** non.
* **Lot bloqué :** aucun ; invariant à respecter dès LOT 1.

### KFD-003 — Absence totale de tampon

* **Précision de portée (postérieure à cette fiche) :** cette fiche décrit
  la décision telle qu'elle s'appliquait à la V1 au moment de sa rédaction.
  Le fondateur a depuis confirmé que l'abandon du tampon est **produit-wide
  et permanent**, pas limité à la V1 — voir `AGENTS.md` §3/§17 (version
  courante, qui fait foi) et la fiche K de
  [`KADI_ENGINEERING_MEMORY.md`](../KADI_ENGINEERING_MEMORY.md).
* **Question :** Kadi propose-t-elle ou facture-t-elle un tampon ?
* **État :** `APPROVED`.
* **Recommandation :** aucune génération, conservation, application ou facturation de tampon dans la V1.
* **Justification :** `AGENTS.md` §3 et §17.
* **Alternatives :** tampon optionnel, logo assimilé à un tampon ou supplément de prix ; rejetées.
* **Conséquences produit :** expérience plus simple et sans promesse juridique implicite.
* **Conséquences techniques :** chemins historiques neutralisés sans supprimer les traces anciennes.
* **Conséquences financières :** suppression de tout coût ou revenu lié au tampon.
* **Risques :** réactivation accidentelle par un ancien handler ou tarif.
* **Éléments existants concernés :** `kadiStamp*`, `kadiPricing.js`, `kadiPdfFlow.js`, `store.js`, colonnes et données historiques de tampon.
* **Décision du fondateur requise :** non.
* **Lot bloqué :** LOT 14 tant que le chemin V1 n'est pas prouvé sans tampon.

### KFD-004 — Sécurité du mode DRAFT

* **Question :** quelles opérations sont permises pendant les parcours DRAFT ?
* **État :** `APPROVED`.
* **Recommandation :** aucun débit et aucun PDF final en mode `DRAFT`.
* **Justification :** `AGENTS.md` §3, §16 et §17.
* **Alternatives :** débit de test remboursé ou PDF final non livré ; rejetées.
* **Conséquences produit :** les essais ne consomment aucun crédit et ne créent aucun document définitif.
* **Conséquences techniques :** garde-fous au niveau orchestration, wallet et génération.
* **Conséquences financières :** aucun mouvement de portefeuille en DRAFT.
* **Risques :** confusion entre rendu temporaire et fichier final.
* **Éléments existants concernés :** sept Flows facture, `kadiPdfFlow.js`, wallet et tests DRAFT.
* **Décision du fondateur requise :** non.
* **Lot bloqué :** LOT 14 et LOT 15 si une régression existe.

### KFD-005 — Texte canonique avant audio

* **Question :** quelle réponse fait foi lorsque Kadi envoie aussi un vocal ?
* **État :** `APPROVED`.
* **Recommandation :** le texte validé reste canonique ; l'audio en est une restitution fidèle, sélective et non bloquante.
* **Justification :** `AGENTS.md` §19 et `kadi_voice_experience.md`.
* **Alternatives :** audio seul ou contenu enrichi par le fournisseur vocal ; rejetées.
* **Conséquences produit :** information vérifiable et accessible même si l'audio échoue.
* **Conséquences techniques :** moteur de politique vocale après validation du texte.
* **Conséquences financières :** les appels vocaux restent facultatifs et contrôlables.
* **Risques :** divergence texte/audio ou lecture de données sensibles.
* **Éléments existants concernés :** futurs `VoicePolicyEngine` et `VoiceProvider`, onboarding.
* **Décision du fondateur requise :** non.
* **Lot bloqué :** LOT 12 doit appliquer cet invariant.

### KFD-006 — Backend comme seule autorité métier

* **Question :** qui décide des calculs, crédits et paiements ?
* **État :** `APPROVED`.
* **Recommandation :** le backend Kadi est la seule autorité pour calculs, états, dates, numéros, crédits, paiements, génération et livraison ; IA et client ne fournissent que des entrées à valider.
* **Justification :** `AGENTS.md` §19 et architecture Kadi Brain.
* **Alternatives :** accepter un total calculé par l'IA ou une confirmation de paiement client ; rejetées.
* **Conséquences produit :** montants et statuts cohérents.
* **Conséquences techniques :** validateurs déterministes et interfaces de fournisseurs sans pouvoir métier.
* **Conséquences financières :** protection contre les crédits ou débits non autorisés.
* **Risques :** persistance prématurée d'une extraction incertaine.
* **Éléments existants concernés :** calculateurs facture, OpenAI/Gemini historiques, wallet, paiements et PDF.
* **Décision du fondateur requise :** non.
* **Lot bloqué :** invariant transversal à tous les lots.

### KFD-007 — Fichier final lié à une version immuable

* **Question :** un PDF livré peut-il être modifié silencieusement ?
* **État :** `APPROVED`.
* **Recommandation :** chaque fichier final référence une version immuable ; aucune correction ne remplace silencieusement le fichier déjà livré.
* **Justification :** modèle documentaire, machine d'états et `AGENTS.md` §16.
* **Alternatives :** écrasement du fichier ou mutation de la version finale ; rejetées.
* **Conséquences produit :** historique compréhensible et documents déjà reçus stables.
* **Conséquences techniques :** empreinte, version source, fichier et tentatives de livraison séparés.
* **Conséquences financières :** stockage supplémentaire possible pour les corrections.
* **Risques :** confusion entre version corrective, duplicata et nouveau document tant que KFD-107 reste ouverte.
* **Éléments existants concernés :** `kadiRepo.js`, `kadiHistoryRepo.js`, `kadiPdfFlow.js`, stockage média.
* **Décision du fondateur requise :** non pour l'immuabilité ; oui pour la forme des corrections.
* **Lot bloqué :** LOT 8 sur le choix détaillé KFD-107.

### KFD-008 — Publication coordonnée de la V1 complète

* **Question :** la facture peut-elle être publiée seule comme V1 finale ?
* **État :** `APPROVED`.
* **Recommandation :** aucune publication partielle limitée à la facture ; les Flows restent DRAFT jusqu'au release gate coordonné de la V1.
* **Justification :** `AGENTS.md` §18, périmètre V1 et stratégie de release.
* **Alternatives :** publication progressive visible de la seule facture ; rejetée pour cette V1.
* **Conséquences produit :** lancement cohérent couvrant facture, devis, reçu et décharge.
* **Conséquences techniques :** bascule coordonnée des contrats, IDs configurés et backend compatible.
* **Conséquences financières :** lancement plus tardif mais moins de dette et de support fragmenté.
* **Risques :** lot bloquant tardif et fenêtre de publication plus complexe.
* **Éléments existants concernés :** sept Flows facture DRAFT, mapping runtime et release gate.
* **Décision du fondateur requise :** non.
* **Lot bloqué :** LOT 15 jusqu'au PASS complet du LOT 14.

## Décisions proposées à valider

### KFD-101 — Profil utilisateur minimal progressif

* **Question :** quelles données faut-il demander avant que l'utilisateur découvre Kadi ?
* **État :** `PROPOSED`.
* **Recommandation :** créer le profil avec `wa_id` unique, téléphone normalisé dérivé de la source WhatsApp, `onboarding_status`, `welcome_credits_granted=false`, `voice_response_mode=VOICE_WHEN_HELPFUL`, locale configurée et timestamps serveur. Demander le nom ou nom commercial seulement lorsqu'il est utile à l'expérience ; exiger les données d'émetteur nécessaires avant la première génération, pas avant le premier brouillon.
* **Justification :** minimise la friction tout en permettant propriété, bonus et reprise.
* **Alternatives :** nom obligatoire avant toute interaction ; profil technique avec seul `wa_id` puis enrichissement intégral plus tard.
* **Conséquences produit :** accès rapide à la valeur, avec collecte progressive.
* **Conséquences techniques :** distinguer clairement création du profil, onboarding et readiness de génération.
* **Conséquences financières :** bonus accordé tôt ; risque d'abandon après attribution à surveiller sans reprendre le bonus.
* **Risques :** doublons si le téléphone affiché remplace `wa_id`, locale erronée, champs d'émetteur incomplets au moment de générer.
* **Éléments existants concernés :** `business_profiles` via `store.js`, `kadiIdentity.js`, `kadiOnboarding.js`.
* **Décision du fondateur requise :** oui.
* **Lot bloqué :** LOT 2 et LOT 4.

#### Niveaux de complétude proposés

| Moment | Données |
|---|---|
| Création indispensable | `wa_id`, téléphone normalisé si disponible depuis la source vérifiée, `onboarding_status`, `welcome_credits_granted`, mode vocal par défaut, locale par défaut, timestamps serveur |
| Avant première génération | nom ou nom commercial de l'émetteur et champs administratifs réellement requis par le type ; devise confirmée |
| Facultatif, plus tard | activité, adresse, logo, préférences enrichies et informations non nécessaires au document courant |

### KFD-102 — Minimum métier d'une facture

* **Question :** quand une facture peut-elle être sauvegardée, prévisualisée puis finalisée ?
* **État :** `PROPOSED`.
* **Recommandation :** autoriser un brouillon incomplet dès que propriétaire et type existent ; exiger pour l'aperçu un émetteur identifiable, un client, au moins une ligne avec désignation, quantité positive et prix unitaire validé, une devise, puis sous-total et total recalculés par le serveur. Exiger avant génération les données d'émetteur/client requises, numéro et `issued_at` serveur selon la politique approuvée. Taxes, remise, notes et conditions restent facultatives sauf contexte validé.
* **Justification :** sépare sauvegarde tolérante, vérification lisible et finalisation sûre.
* **Alternatives :** mêmes champs obligatoires à toutes les étapes ; facture sans client ; numéro réservé dès le brouillon.
* **Conséquences produit :** reprise possible sans bloquer la collecte.
* **Conséquences techniques :** validateurs par étape et recalcul systématique des montants.
* **Conséquences financières :** aucun coût avant rendu, quote et confirmation.
* **Risques :** exigences réglementaires locales à confirmer avant génération.
* **Éléments existants concernés :** drafts facture, `kadiInvoiceCartService.js`, `kadiDynamicInvoiceContract.js`, calculateurs et PDF facture.
* **Décision du fondateur requise :** oui.
* **Lot bloqué :** LOT 1 et LOT 5.

### KFD-103 — Minimum métier et validité d'un devis

* **Question :** quelles règles distinguent le devis de la facture ?
* **État :** `PROPOSED`.
* **Recommandation :** reprendre les lignes et calculs de la facture, afficher clairement « Devis », conserver des conditions d'offre, gérer `PROPOSED`, `ACCEPTED`, `REJECTED` et `EXPIRED`, et calculer une expiration depuis une durée centrale recommandée de 30 jours. Une conversion future crée une facture liée, sans transformer ni écraser le devis. Un devis n'atteste jamais un paiement.
* **Justification :** contrat commercial distinct, compatible avec le pipeline partagé.
* **Alternatives :** durée explicitement choisie à chaque devis ; aucune expiration automatique ; durée par secteur.
* **Conséquences produit :** offre compréhensible et convertible ultérieurement.
* **Conséquences techniques :** date d'expiration dérivée, états spécifiques et lien de conversion.
* **Conséquences financières :** faible coût direct ; stockage d'états et de versions supplémentaires.
* **Risques :** durée par défaut ou valeur juridique non validée ; acceptation future à spécifier.
* **Éléments existants concernés :** `kadiProductFlow.js`, `kadiNaturalFlow.js`, `pdf/kadiPdfDevis.js`.
* **Décision du fondateur requise :** oui.
* **Lot bloqué :** LOT 1 et LOT 5.

### KFD-104 — Minimum métier d'un reçu

* **Question :** que prouve exactement un reçu Kadi ?
* **État :** `PROPOSED`.
* **Recommandation :** attester un paiement déclaré comme reçu en identifiant payeur, bénéficiaire, montant positif, motif, devise, date serveur et numéro serveur ; mode et référence de paiement sont facultatifs mais recommandés. Le texte doit préciser la source déclarative lorsque Kadi n'a pas vérifié le paiement externe.
* **Justification :** évite la confusion avec une facture à payer ou une validation bancaire.
* **Alternatives :** mode de paiement obligatoire ; reçu exclusivement lié à une facture Kadi ; modèle à lignes obligatoire.
* **Conséquences produit :** reçu simple utilisable sans fausse preuve de vérification externe.
* **Conséquences techniques :** modèle partagé avec validation sémantique propre et éventuellement lien vers une facture.
* **Conséquences financières :** génération facturée selon la politique par pages ; aucune écriture de paiement créée par le document seul.
* **Risques :** formulation pouvant être interprétée comme confirmation d'un paiement non vérifié.
* **Éléments existants concernés :** `kadiProductFlow.js`, `kadiNaturalFlow.js`, PDF reçu A4 et compact.
* **Décision du fondateur requise :** oui.
* **Lot bloqué :** LOT 1 et LOT 5.

### KFD-105 — Minimum métier d'une décharge

* **Question :** quelles données et attestations sont requises en V1 ?
* **État :** `PROPOSED`.
* **Recommandation :** exiger remettant, receveur, sujet typé (montant, bien ou document), motif, date serveur et numéro serveur ; quantité seulement lorsqu'elle a un sens et observations facultatives. Différer pièce d'identité, signature et témoin jusqu'à validation produit et juridique ; ne jamais les présenter comme obligation légale sans preuve.
* **Justification :** couvre l'usage essentiel sans collecte sensible excessive.
* **Alternatives :** identité renforcée obligatoire ; signature/témoin optionnels dès V1 ; motif facultatif.
* **Conséquences produit :** parcours court et adapté à la remise attestée.
* **Conséquences techniques :** agrégat et Flow spécifiques, composants de génération partagés.
* **Conséquences financières :** pas de coût d'identité ou signature en V1 ; coût documentaire par pages.
* **Risques :** besoins légaux ou sectoriels non encore validés.
* **Éléments existants concernés :** `kadiDecharge.js`, `kadiProductFlow.js`, `pdf/kadiPdfDecharge.js`.
* **Décision du fondateur requise :** oui.
* **Lot bloqué :** LOT 1 et LOT 6.

### KFD-106 — Numérotation serveur des documents

* **Question :** quelle portée et quel cycle utiliser pour les numéros ?
* **État :** `PROPOSED`.
* **Recommandation :** préfixe par type (`FAC`, `DEV`, `REC`, `DEC`), année serveur et séquence non réutilisable, par émetteur et par type : `FAC-2026-000001`, par exemple. Attribuer le numéro à la finalisation, sous verrou transactionnel ; une annulation ne libère jamais le numéro.
* **Justification :** lisibilité pour chaque entreprise, collisions évitées et séries séparées par document.
* **Alternatives :** séquence globale Kadi ; séquence continue sans année ; séquence par type mais globale à tous les utilisateurs.
* **Conséquences produit :** séries compréhensibles propres à chaque émetteur.
* **Conséquences techniques :** compteur atomique par portée, unicité en base, gestion de concurrence et audit des trous.
* **Conséquences financières :** coût technique faible à moyen ; support simplifié.
* **Risques :** incompatibilité avec les numéros historiques ou exigences comptables non confirmées.
* **Éléments existants concernés :** `kadiRepo.js`, `kadiHistoryRepo.js`, documents historiques et futurs compteurs.
* **Décision du fondateur requise :** oui.
* **Lot bloqué :** LOT 1, LOT 2 et LOT 8.

### KFD-107 — Correction après génération

* **Question :** comment corriger un document final sans altérer le PDF livré ?
* **État :** `PROPOSED`.
* **Recommandation :** garder le brouillon modifiable ; invalider aperçu, rendu et quote après chaque modification ; après génération, créer une version corrective explicitement liée, conserver ancien fichier et historique, puis générer un nouveau fichier après les mêmes contrôles.
* **Justification :** respecte KFD-007 tout en offrant une correction traçable.
* **Alternatives :** annuler puis créer un nouveau document ; dupliquer l'ancien comme nouveau brouillon ; interdire toute correction.
* **Conséquences produit :** correction compréhensible, sans remplacement invisible.
* **Conséquences techniques :** liens entre versions, statuts de correction et historique des fichiers.
* **Conséquences financières :** décision ultérieure nécessaire sur le coût d'une correction générée.
* **Risques :** ambiguïté juridique entre version, duplicata et document correctif.
* **Éléments existants concernés :** historique, PDF, stockage, futur domaine et machine d'états.
* **Décision du fondateur requise :** oui.
* **Lot bloqué :** LOT 1 et LOT 8.

### KFD-108 — Transaction crédits, génération et livraison

* **Question :** comment éviter double débit, fichier perdu ou double génération ?
* **État :** `PROPOSED`.
* **Recommandation :** adopter l'option B : après quote valide et confirmation explicite, réserver atomiquement les crédits avec une clé idempotente, produire l'artefact dans une zone non livrable, vérifier et stocker, capturer une seule fois le débit, puis promouvoir le fichier comme final immuable et le livrer. Libérer la réservation si la génération ou le stockage échoue avant capture. Après capture, une livraison échouée est reprise sans redébit ni régénération.
* **Justification :** sépare fonds disponibles, production et livraison tout en respectant l'interdiction de créer un PDF final avant confirmation et débit réussi : l'artefact pré-capture reste temporaire et non livrable.
* **Alternatives :** A, débit définitif avant génération avec compensation ; C, rendu temporaire puis débit et promotion directe, sans réservation explicite.
* **Conséquences produit :** confirmation unique, reprise transparente et pas de double débit.
* **Conséquences techniques :** réservation/capture/libération dans le ledger, quote expirante, état d'opération, stockage temporaire, promotion atomique ou logique et tentatives de livraison séparées.
* **Conséquences financières :** crédits immobilisés brièvement ; moins de remboursements et de litiges.
* **Risques :** réservation abandonnée, capture réussie mais promotion échouée, expiration concurrente et complexité du RPC wallet.
* **Éléments existants concernés :** `kadiCreditsRepo.js`, `billingRepo.js`, `kadiInvoicePageQuote.js`, `kadiInvoicePdfDryRun.js`, `kadiPdfFlow.js`, `kadiRepo.js`, stockage et livraison WhatsApp.
* **Décision du fondateur requise :** oui.
* **Lot bloqué :** LOT 2, LOT 7, LOT 8 et LOT 9.

#### Comparaison des stratégies transactionnelles

| Option | Atout principal | Échec critique à traiter | Appréciation V1 |
|---|---|---|---|
| A — débit puis compensation | s'appuie plus facilement sur un débit existant | remboursement après génération/stockage échoué et états financiers intermédiaires | simple en apparence, plus risqué pour la confiance |
| B — réservation puis capture | empêche la dépense concurrente sans débiter définitivement trop tôt | réservation expirée ou orpheline | recommandée, avec artefact non livrable avant capture |
| C — rendu puis débit et promotion | peu d'argent immobilisé | promotion après débit, concurrence sur le solde, gestion du fichier candidat | acceptable si la réservation est impossible, mais moins robuste seule |

## Tableau des décisions encore à valider

| ID | Question simple | Recommandation | Alternative principale | Impact | Urgence | Décision du fondateur |
|---|---|---|---|---|---|---|
| KFD-101 | Que demander avant de laisser commencer ? | profil technique minimal, enrichi avant génération | nom obligatoire dès l'accueil | friction et qualité du profil | avant LOT 2 | À renseigner |
| KFD-102 | Quelles données rendent une facture finalisable ? | client, émetteur, une ligne valide et calculs serveur | mêmes obligations dès le brouillon | conformité et reprise | avant LOT 1 | À renseigner |
| KFD-103 | Combien de temps un devis reste-t-il valable ? | 30 jours configurables | date choisie ou aucune expiration | clarté commerciale | avant LOT 5 | À renseigner |
| KFD-104 | Que doit obligatoirement contenir un reçu ? | payeur, bénéficiaire, montant et motif | mode/référence obligatoires | sens du reçu | avant LOT 5 | À renseigner |
| KFD-105 | Faut-il identité, signature ou témoin pour une décharge V1 ? | les différer jusqu'à validation | les rendre optionnels dès V1 | données sensibles et conformité | avant LOT 6 | À renseigner |
| KFD-106 | Les numéros sont-ils propres à chaque entreprise ? | séquence annuelle par émetteur et type | séquence globale Kadi | historique et concurrence | avant LOT 2 | À renseigner |
| KFD-107 | Comment corriger un PDF déjà livré ? | version corrective liée | annulation et nouveau document | confiance et coût | avant LOT 8 | À renseigner |
| KFD-108 | Comment sécuriser crédits et génération ? | réservation, capture puis promotion/livraison | débit puis compensation | risque financier majeur | avant LOT 2 | À renseigner |

## Gouvernance

Toute décision du tableau final doit être datée, attribuée au fondateur et reflétée dans les documents canoniques concernés avant migration ou code. Une décision partielle ne débloque que les lots explicitement couverts.
