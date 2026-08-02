# Kadi — Expérience vocale canonique

## Objet

La voix prolonge l'assistance conversationnelle de Kadi sans créer un second canal métier. Le texte validé reste la référence officielle ; l'audio est une restitution facultative, fidèle et supprimable.

## Identité vocale

La voix de Kadi doit être :

* féminine ;
* ouest-africaine dans son identité et son naturel ;
* chaleureuse et professionnelle ;
* claire, calme et rassurante ;
* non caricaturale ;
* sans accent artificiellement exagéré.

Elle doit prononcer correctement les noms locaux, les montants en francs CFA, IFU, RCCM, Mobile Money, WhatsApp et les termes administratifs courants.

Aucune voix ne peut être clonée ou reproduite à partir d'une personne réelle sans consentement explicite, vérifiable et conservé selon une procédure approuvée. La possibilité technique ne vaut jamais autorisation.

## Texte canonique

Pipeline obligatoire :

```text
MOTEUR MÉTIER KADI
  -> RÉPONSE TEXTE VALIDÉE
  -> VOICE POLICY ENGINE
  -> SYNTHÈSE VOCALE ÉVENTUELLE
  -> ENVOI TEXTE ET, SI AUTORISÉ, AUDIO
```

L'audio :

* ne crée aucune information ;
* ne modifie aucune donnée métier ;
* ne remplace jamais le texte ;
* ne change aucun nom, montant, quantité, date ou statut ;
* ne confirme aucun paiement, débit, génération ou envoi non validé par le backend ;
* peut être supprimé ou régénéré sans modifier le document.

L'empreinte ou la version du texte validé doit permettre de vérifier que l'audio correspond exactement à la réponse canonique.

## Politique d'utilisation

### Mode par défaut

La réponse texte est toujours envoyée. La préférence persistante `voice_response_mode` accepte :

* `TEXT_ONLY` ;
* `TEXT_AND_VOICE` ;
* `VOICE_WHEN_HELPFUL`.

La valeur recommandée par défaut est `VOICE_WHEN_HELPFUL`. Cette recommandation devra être validée lors des tests utilisateurs avant généralisation.

L'utilisateur peut changer sa préférence sans reprendre l'onboarding :

* « Réponds-moi par vocal. »
* « Explique-moi ça par vocal. »
* « Je préfère les réponses écrites. »
* « Ne m'envoie plus de vocal. »

### Cas favorables à l'audio

Kadi peut ajouter un vocal lorsque :

* l'utilisateur le demande explicitement ;
* son dernier message était vocal ;
* sa préférence autorise la voix ;
* une étape complexe mérite une explication ;
* l'onboarding gagne en accessibilité ;
* un résumé important doit être expliqué ;
* une recharge, un coût ou une génération demande une clarification ;
* un besoin d'accessibilité le justifie.

### Cas défavorables à l'audio automatique

Ne pas ajouter automatiquement de vocal pour :

* chaque confirmation courte ou bouton sélectionné ;
* une erreur purement technique ;
* une information sensible ;
* un long tableau, une longue liste ou des références difficiles à contrôler oralement ;
* une réponse dont le texte n'a pas encore été validé.

## Voice Policy Engine

Le `Voice Policy Engine` est déterministe. Il reçoit :

* préférence utilisateur ;
* type du dernier message ;
* demande explicite de vocal ;
* complexité et longueur de la réponse ;
* sensibilité des données ;
* étape du parcours ;
* disponibilité du fournisseur ;
* budget et limites techniques.

Il retourne uniquement `TEXT_ONLY` ou `TEXT_AND_VOICE`, avec un motif interne non sensible. L'IA peut produire des signaux de complexité ou de sensibilité, mais ne décide jamais seule de contourner la politique, de débiter des crédits ou de lire une donnée protégée.

Priorités recommandées : une interdiction de confidentialité domine toute préférence ; une demande explicite domine les heuristiques de confort si la confidentialité et la disponibilité le permettent ; tout échec du fournisseur revient à `TEXT_ONLY` sans bloquer la réponse.

## Confidentialité

Ne jamais lire automatiquement :

* un numéro de téléphone complet ;
* un identifiant fiscal complet ;
* un numéro de compte ;
* un secret, token ou code de validation ;
* une information de paiement sensible ;
* une donnée susceptible d'exposer l'utilisateur dans un lieu public.

Pour une donnée sensible, afficher un texte approprié et masqué. Une lecture détaillée exige une demande explicite, une confirmation adaptée et une politique approuvée. Certaines catégories, notamment secrets et codes de validation, doivent rester interdites à la lecture même après confirmation.

Les journaux ne contiennent ni texte vocal sensible, ni audio brut, ni données personnelles complètes. Les règles de conservation des fichiers audio restent à approuver.

## Fournisseurs de synthèse

L'abstraction commune cible :

```text
VoiceProvider
  synthesize(validated_text, locale, voice_style, output_format)
```

Implémentations possibles :

* `OpenAIVoiceProvider` ;
* `GeminiVoiceProvider`.

Le fournisseur principal est choisi par configuration. Aucun appel simultané aux deux fournisseurs pour une réponse normale. Un second fournisseur est permis uniquement dans un benchmark consenti, un shadow mode sans double envoi, un canary contrôlé ou un fallback explicitement autorisé. Aucune logique métier ne dépend directement du fournisseur.

## Format du message audio

Le vocal doit :

* être court et directement utile ;
* rester fidèle au texte validé ;
* lire naturellement les montants ;
* éviter les listes longues ;
* inviter à vérifier le texte pour les détails importants ;
* utiliser un format compatible avec WhatsApp ;
* rester un artefact dérivé, sans effet sur le document.

Les montants, sigles et noms peuvent utiliser une représentation de prononciation distincte uniquement si elle conserve strictement la même valeur sémantique.

## Scénarios de référence

### A. Onboarding

**Texte**

> Bienvenue chez Kadi
>
> Je vous aide à préparer vos factures, devis, reçus et décharges directement sur WhatsApp.
>
> Vous pouvez m'écrire, m'envoyer un vocal ou une photo.
>
> 5 crédits viennent de vous être offerts pour commencer.

**Audio**

Version courte, féminine, naturelle, chaleureuse et professionnelle, fidèle au même texte et sans ajout. Elle annonce exactement les 5 crédits après confirmation serveur de leur attribution et reste accompagnée du texte.

Ce vocal est envoyé automatiquement uniquement au premier accueil. Une reprise, un ré-onboarding ou une réactivation n'entraîne pas un nouvel envoi automatique ; l'utilisateur peut toutefois demander ensuite une explication vocale. Aucune donnée sensible n'est lue.

La tentative vocale ne bloque jamais le premier accueil. Si le fournisseur est indisponible, Kadi envoie le texte, conserve le profil et les crédits, enregistre un échec récupérable et poursuit l'onboarding. Un retry audio autorisé utilise une clé distincte, par exemple `welcome_voice:<wa_id>:v1`. Cette clé ne décide jamais de l'attribution des crédits et un retry audio ne peut pas recréditer le portefeuille.

Une formulation courte en mooré pourra être étudiée après benchmark et validation locale. La documentation ne promet ni disponibilité ni qualité avant cette validation.

### B. Résumé de facture

**Texte et contenu audio fidèle**

> J'ai préparé une facture pour Moussa avec deux portes à vingt-cinq mille francs chacune et une pose à cinquante mille francs. Le total est de cent mille francs CFA. Vérifiez les informations affichées.

### C. Information manquante

> J'ai presque tout. Quel est le prix de la pose ?

### D. Coût de génération

> Votre document fera deux pages et coûtera deux crédits. Aucun crédit ne sera débité avant votre confirmation.

L'audio ne vaut pas confirmation et ne déclenche aucun débit.

### E. Solde insuffisant

> Votre brouillon est conservé. Il vous manque deux crédits pour générer le document. Vous pourrez reprendre exactement ici après la recharge.

## Benchmark local OpenAI/Gemini

Ne sélectionner définitivement ni fournisseur ni voix avant une évaluation avec des utilisateurs locaux et des appareils représentatifs.

### Corpus

Inclure : noms burkinabè variés, français courant, montants simples et complexes en francs CFA, IFU, RCCM, Mobile Money, WhatsApp, adresses locales, résumé de facture, explication de coût et message de reprise. N'utiliser que des données fictives ou consenties.

### Protocole

1. Générer les mêmes textes validés avec chaque candidat, dans des conditions comparables.
2. Randomiser et anonymiser l'ordre d'écoute lorsque possible.
3. Évaluer sur téléphone, haut-parleur et écouteur avec réseau réaliste.
4. Recueillir notes et préférences sans révéler le fournisseur avant réponse.
5. Mesurer naturel, chaleur, professionnalisme, compréhension, noms locaux, montants, rythme, qualité téléphone, latence, coût, stabilité et préférence.
6. Vérifier séparément l'absence de caricature et la confiance perçue.
7. Documenter taille et limites de l'échantillon avant décision.

Un benchmark ne doit jamais envoyer deux réponses vocales à un utilisateur réel hors protocole explicitement consenti.

## Décisions à arbitrer

| Sujet | Recommandation | Alternatives |
|---|---|---|
| Fournisseur principal | choisir après benchmark local | OpenAI ou Gemini selon configuration |
| Voix exacte | retenir la mieux comprise et préférée, non caricaturale | plusieurs voix selon langue si cohérentes |
| Coût vocal | afficher une règle simple avant toute éventuelle facturation | inclus, quota séparé ou gratuit |
| Crédits | ne pas consommer les crédits documentaires sans décision explicite | crédits communs ou portefeuille séparé |
| Durée maximale | privilégier des messages courts et segmentables | limite fixe ou dynamique selon contenu |
| Conservation | suppression rapide par défaut | cache chiffré court ou historique opt-in |
| Langues | français d'abord, validation locale avant extension | mooré puis autres langues selon recherche |
| Fallback | texte seul toujours disponible | second fournisseur autorisé par politique |
| Données sensibles | texte masqué, audio bloqué par défaut | lecture confirmée pour catégories limitées |
| Voix personnalisée | seulement avec consentement vérifiable et procédure approuvée | aucune voix personnalisée |

Aucune ligne de ce tableau ne constitue une décision fournisseur, tarifaire ou de conservation.
