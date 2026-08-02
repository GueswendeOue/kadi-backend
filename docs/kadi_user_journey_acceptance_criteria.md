# Kadi — Critères d'acceptation de l'expérience V1

## Utilisation

Ces critères constituent le gate produit avant publication. Ils décrivent des résultats observables, sans imposer un outil de test. Un critère obligatoire échoué bloque la publication des Flows concernés et le lancement cohérent de la V1.

Statuts de preuve recommandés : `PASS`, `FAIL`, `BLOCKED` et `NOT_RUN`, accompagnés du canal, de la taille d'écran, du type de document et de la version testée.

## Critères transverses de langage

| ID | Critère testable | Attendu |
|---|---|---|
| COPY-001 | parcourir tous les messages, cartes et écrans publiés | aucun texte anglais Meta de test |
| COPY-002 | rechercher « Créer guidé » | aucune occurrence visible |
| COPY-003 | rechercher « Vérifier le client » | aucune occurrence visible |
| COPY-004 | rechercher Flow, payload, session, OCR, OpenAI, Gemini, endpoint, brouillon technique, commande non reconnue | aucune occurrence visible |
| COPY-005 | examiner chaque réponse | une information principale et une prochaine action claire |
| COPY-006 | examiner les questions de collecte | au maximum une question utile à la fois |
| COPY-007 | comparer le contexte du document | aucun texte de facture incohérent dans reçu ou décharge |
| COPY-008 | mesurer les options concernées | aucun libellé supérieur à 30 caractères |
| COPY-009 | tester plusieurs tailles d'écran | titres, options et boutons restent lisibles sans ambiguïté |
| COPY-010 | fermer chaque étape réussie | une seule confirmation humaine, aucun doublon |

## Onboarding, accueil et menu

| ID | Scénario | Attendu |
|---|---|---|
| START-001 | nouvel utilisateur ouvre Kadi | valeur comprise avant toute collecte longue |
| START-002 | utilisateur veut créer immédiatement un document | onboarding ne bloque pas le parcours inutilement |
| START-003 | utilisateur écrit une intention claire | Kadi entre dans le document sans imposer le menu |
| START-004 | utilisateur demande les raccourcis | quatre actions : Préparer un document, Retrouver un document, Mon solde, Aide |
| START-005 | utilisateur envoie texte, vocal ou photo | aucune modalité n'est présentée comme un produit séparé |
| START-006 | onboarding interrompu | valeurs validées conservées et reprise au prochain manque |
| START-007 | préférence vocale modifiée | modification effective sans recommencer l'onboarding |
| START-008 | nouvel utilisateur éligible | exactement 5 crédits et une seule écriture `WELCOME_CREDITS` |
| START-009 | deux webhooks identiques ou double clic | une seule attribution avec `welcome_credits:<wa_id>` |
| START-010 | onboarding rouvert ou repris | solde inchangé et aucun nouveau bonus |
| START-011 | cinq crédits consommés | utilisateur jamais rendu éligible à nouveau |
| START-012 | message de bienvenue | bonus annoncé seulement après attribution serveur réussie |
| START-013 | premier accueil | texte, court vocal fidèle et action unique « Commencer » |
| START-014 | fournisseur vocal indisponible | texte et onboarding continuent, profil et crédits conservés |
| START-015 | retry du vocal | clé audio indépendante et aucun nouveau crédit |
| START-016 | utilisateur existant | aucun crédit automatique sans migration historique auditée |
| START-017 | comparer texte et vocal d'accueil | mêmes informations métier et même valeur de 5 crédits |
| START-018 | solde nul d'un utilisateur existant | aucune déduction d'éligibilité depuis le seul solde |
| START-019 | préférence vocale modifiée | aucun changement du marqueur ni nouvelle attribution |

## Compréhension naturelle et informations manquantes

| ID | Scénario | Attendu |
|---|---|---|
| NLP-001 | demande complète en une phrase | toutes les données claires sont reprises, sans redemande |
| NLP-002 | type ambigu | question facture/devis/reçu/décharge, sans jargon |
| NLP-003 | une donnée manque | question ciblée uniquement sur cette donnée |
| NLP-004 | plusieurs données manquent | questions successives, une à la fois |
| NLP-005 | deux valeurs se contredisent | contradiction signalée et choix demandé |
| NLP-006 | une valeur est incertaine | valeur non persistée comme confirmée |
| NLP-007 | prix incertain | aucun total final calculé avant confirmation |
| NLP-008 | sortie IA hors contrat | rejet contrôlé, aucune donnée métier corrompue |

## Entrée texte

| ID | Scénario | Attendu |
|---|---|---|
| TXT-001 | toutes les données sont écrites naturellement | extraction et synthèse correctes |
| TXT-002 | correction dans un message suivant | seule la donnée visée change |
| TXT-003 | message très court | contexte courant conservé sans retour au menu |
| TXT-004 | information non pertinente | aucune mutation du document sans confirmation |

## Entrée vocale

| ID | Scénario | Attendu |
|---|---|---|
| VOC-001 | vocal clair | transcription, compréhension et reformulation fidèle |
| VOC-002 | montant ambigu | question écrite ciblée, aucun montant inventé |
| VOC-003 | transcription indisponible | proposition d'écrire ou de renvoyer le vocal |
| VOC-004 | préférence `TEXT_ONLY` | aucune réponse audio automatique |
| VOC-005 | préférence `TEXT_AND_VOICE` et contenu autorisé | texte envoyé et audio fidèle au même texte |
| VOC-006 | `VOICE_WHEN_HELPFUL` avec confirmation courte | texte seul sauf justification de politique |
| VOC-007 | donnée sensible dans la réponse | aucune lecture automatique complète |
| VOC-008 | fournisseur vocal indisponible | texte envoyé sans blocage du parcours |
| VOC-009 | comparer texte et audio | aucun nom, montant, date ou statut différent |
| VOC-010 | interaction vocale | aucun débit décidé par l'IA ou le moteur vocal |

## Entrée photo et document

| ID | Scénario | Attendu |
|---|---|---|
| IMG-001 | photo lisible | extraction structurée présentée pour vérification |
| IMG-002 | prix difficile à lire | question « Quel est le montant exact ? » adaptée au champ |
| IMG-003 | champ absent | champ marqué manquant, jamais inventé |
| IMG-004 | valeurs contradictoires | contradiction présentée avant persistance |
| IMG-005 | tableau complexe | lignes proposées avec provenance/incertitude disponible |
| IMG-006 | PDF ou document | type, parties, contenu et références candidats extraits |
| IMG-007 | montants extraits | sous-total, taxes, remise et total recalculés par le backend |
| IMG-008 | média invalide | rejet humain, aucune trace technique visible |
| IMG-009 | traitement interrompu | candidats non confirmés exclus de la vérité métier |

## Client et contenu commun

| ID | Scénario | Attendu |
|---|---|---|
| DOC-001 | client absent | bouton « Ajouter le client » |
| DOC-002 | client compris | bouton « Voir le client » |
| DOC-003 | correction client | bouton « Modifier le client » et autres données conservées |
| DOC-004 | écran client | titre « Informations du client » et aide canonique |
| DOC-005 | nouvel article | champs frais, quantité par défaut approuvée, aucune valeur précédente |
| DOC-006 | retry d'article | aucune ligne dupliquée |
| DOC-007 | correction d'article | cible par `item_id` serveur, aucun append |
| DOC-008 | compteur | égal à `items.length` |
| DOC-009 | sous-total | recalculé depuis les lignes sauvegardées |
| DOC-010 | correction des détails | client et contenu conservés |
| DOC-011 | session expirée | aucune mutation et reprise depuis la version serveur |

## Facture

| ID | Scénario | Attendu |
|---|---|---|
| INV-001 | demande de facture | vocabulaire de paiement à recevoir |
| INV-002 | client, lignes et détails complets | passage à vérification sans champ facture oublié |
| INV-003 | échéance applicable | formulation claire, date gérée selon règle approuvée |
| INV-004 | total affiché | total serveur conforme aux lignes, taxes et remise |
| INV-005 | correction | nouvelle vérification puis nouvel aperçu |

## Devis

| ID | Scénario | Attendu |
|---|---|---|
| QUO-001 | demande de devis | vocabulaire de proposition commerciale, jamais paiement déjà dû |
| QUO-002 | validité applicable | durée ou date selon décision produit validée |
| QUO-003 | conditions | distinctes des conditions d'un reçu |
| QUO-004 | génération | document nommé devis dans carte, aperçu, fichier et historique |
| QUO-005 | acceptation future non implémentée | aucune promesse ou action silencieuse |

## Reçu

| ID | Scénario | Attendu |
|---|---|---|
| REC-001 | demande de reçu | Kadi comprend qu'un paiement a déjà été reçu |
| REC-002 | partie | « Payeur » ou « bénéficiaire » selon contexte validé |
| REC-003 | montant | montant versé distinct d'un paiement à recevoir |
| REC-004 | mode/référence | demandés seulement si nécessaires |
| REC-005 | textes | aucune échéance de facture affichée |

## Décharge

| ID | Scénario | Attendu |
|---|---|---|
| DIS-001 | création | remettant et receveur clairement distingués |
| DIS-002 | sujet somme | montant et motif cohérents |
| DIS-003 | sujet bien | désignation et quantité éventuelle cohérentes |
| DIS-004 | sujet document | référence et motif présentés sans panier artificiel |
| DIS-005 | contenu | aucune terminologie client/articles imposée si incohérente |
| DIS-006 | attestations futures | aucune signature promise avant spécification approuvée |

## Vérification, corrections et aperçu

| ID | Scénario | Attendu |
|---|---|---|
| REV-001 | ouvrir la vérification | parties, contenu, options et totaux visibles |
| REV-002 | corriger le client | contenu/options conservés, retour à vérification |
| REV-003 | corriger les articles | ligne modifiée une fois, total recalculé |
| REV-004 | corriger les détails | autres données conservées |
| REV-005 | confirmer | version inchangée exigée |
| PRE-001 | ouvrir l'aperçu | type, émetteur, partie, contenu, montants, notes, date et numéro disponible |
| PRE-002 | actions | Modifier, Préparer le PDF, Enregistrer pour plus tard |
| PRE-003 | aperçu | aucun débit et aucun PDF final |
| PRE-004 | modification après aperçu | aperçu, rendu et coût antérieurs invalidés |
| PRE-005 | libellé | aucune occurrence « Vérifier l'aperçu » |

## Coût, confirmation et génération

| ID | Scénario | Attendu |
|---|---|---|
| COST-001 | Préparer le PDF | rendu temporaire non livré |
| COST-002 | plusieurs pages | pages réelles issues du rendu, pas du nombre d'articles |
| COST-003 | coût | règle centrale et nombre réel de pages utilisés |
| COST-004 | affichage | pages, coût et solde lisibles |
| COST-005 | avant confirmation | aucun débit |
| COST-006 | mode `DRAFT` | aucun débit et aucun PDF final |
| GEN-001 | confirmation explicite | débit idempotent unique |
| GEN-002 | retry de confirmation | aucun second débit ni second document |
| GEN-003 | version modifiée | coût invalidé et recalcul obligatoire |
| GEN-004 | génération réussie | fichier lié à une version immuable |
| GEN-005 | interruption après débit | reprise avec même clé, sans redébiter |
| GEN-006 | date et numéro | produits uniquement par le serveur |
| GEN-007 | tampon | aucune génération, application ou facturation de tampon |

## Recharge

| ID | Scénario | Attendu |
|---|---|---|
| TOP-001 | solde insuffisant | brouillon conservé et aucun débit |
| TOP-002 | packs | noms et prix depuis configuration centrale |
| TOP-003 | paiement en attente | aucun crédit ajouté |
| TOP-004 | webhook confirmé | crédit ajouté une fois |
| TOP-005 | webhook dupliqué | aucun double crédit |
| TOP-006 | retour après recharge | même document et même étape de confirmation |
| TOP-007 | version changée pendant recharge | nouveau rendu et nouveau coût |
| TOP-008 | recharge réussie | aucune génération automatique sans confirmation |

## Livraison, historique et recherche

| ID | Scénario | Attendu |
|---|---|---|
| DEL-001 | fichier généré | message et document envoyés une fois |
| DEL-002 | livraison échouée | fichier conservé et retry sans débit |
| DEL-003 | historique | document final et brouillon autorisés retrouvables |
| HIS-001 | liste | uniquement documents du propriétaire |
| HIS-002 | pagination | aucun document perdu ou dupliqué entre pages |
| HIS-003 | recherche par type/client/numéro/période | critères combinables selon contrat validé |
| HIS-004 | aucun résultat | message humain et possibilité d'ajuster |
| HIS-005 | document non autorisé | aucune donnée exposée |
| HIS-006 | reprendre un brouillon | état et version serveur restaurés |

## Annulation, expiration et erreurs

| ID | Scénario | Attendu |
|---|---|---|
| ERR-001 | annulation avant débit | aucun débit, brouillon conservé selon décision V1 |
| ERR-002 | session expirée | message canonique et nouvelle session au même point |
| ERR-003 | erreur récupérable | une seule prochaine action, aucun détail technique |
| ERR-004 | service indisponible | données validées conservées |
| ERR-005 | complétion reconnue invalide | absorbée avant MENU et IA, aucune double réponse |
| ERR-006 | retry réseau | idempotence de la mutation et du message |
| ERR-007 | reprise | aucune donnée déjà confirmée redemandée sans raison |

## Sécurité et confidentialité

| ID | Critère | Attendu |
|---|---|---|
| SEC-001 | logs et rapports | aucun secret, token, clé ou donnée personnelle complète |
| SEC-002 | audio | téléphone, IFU, compte, code et paiement sensible non lus automatiquement |
| SEC-003 | média | propriété et type validés avant traitement |
| SEC-004 | fournisseur IA | aucune sortie utilisée comme autorité métier |
| SEC-005 | calculs | aucun total faisant autorité calculé par l'IA |
| SEC-006 | voix clonée | impossible sans consentement explicite et procédure approuvée |
| SEC-007 | erreur fournisseur | objet brut et identifiants sensibles non exposés |

## Matrice de test mobile

Chaque parcours obligatoire est exécuté au minimum sur :

* petit écran Android ;
* écran Android courant ;
* iPhone de taille courante si supporté ;
* taille de police augmentée ;
* réseau stable puis réseau lent/interrompu ;
* texte français avec noms locaux et montants en francs CFA.

Vérifier lisibilité, troncature, ordre des actions, clavier adapté, retour, fermeture, reprise et absence de libellé ambigu.

## Critères de sortie V1

La release peut être proposée seulement si :

* tous les critères obligatoires applicables sont `PASS` ;
* aucun `FAIL` sécurité, paiement, débit, génération, propriété ou confidentialité n'est accepté ;
* tout `BLOCKED` possède une décision produit explicite et ne masque pas une capacité annoncée comme obligatoire ;
* les quatre types de documents passent en texte ;
* vocal et photo passent les scénarios d'incertitude et de reprise ;
* aucun texte Meta de test ou terme interne ne reste visible ;
* les textes et limites sont validés sur le contrat Meta réellement ciblé ;
* aucune publication partielle ne précède la validation coordonnée du parcours complet.

## Décisions à valider avant exécution finale

| Sujet | Recommandation | Alternative 1 | Alternative 2 |
|---|---|---|---|
| Terme contenu | conversation « produits ou services », écran « article » | « élément » | vocabulaire par type uniquement |
| Durée vocale | seuil issu du benchmark | limite fixe | segmentation automatique |
| Historique | pagination configurable | cinq derniers | dix derniers |
| Annulation | conserver pour plus tard | état annulé | suppression future confirmée |
| Recharge | retour à confirmation | retour à aperçu | choix utilisateur après recharge |

La validation de ces décisions met à jour le catalogue avant publication ; elle ne se fait pas implicitement pendant l'implémentation.
