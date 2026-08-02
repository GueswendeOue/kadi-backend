# Kadi — Architecture canonique du cerveau IA multimodal

## Objet

Le cerveau Kadi utilise des capacités d'IA multimodales derrière une architecture contrôlée. L'IA comprend, extrait et propose ; le backend Kadi valide, décide et persiste. Aucun fournisseur n'est une autorité métier.

## Principes

* Le langage naturel est l'entrée principale ; texte, vocal, photo et document convergent vers le même pipeline.
* Les fournisseurs sont remplaçables et choisis par configuration, jamais codés en dur dans un parcours métier.
* Toute sortie IA est non fiable jusqu'à validation par un contrat déterministe et les règles serveur.
* Le texte validé est la source canonique de toute réponse, y compris vocale.
* Les calculs, crédits, paiements, états, numéros, dates, génération et livraison appartiennent exclusivement au backend.
* Un échec IA ne doit ni produire de débit, ni corrompre un brouillon, ni contourner une confirmation.

## Entrées

| Entrée | Prétraitement contrôlé | Résultat attendu |
|---|---|---|
| Texte | normalisation sûre, contexte autorisé | intention et données candidates |
| Vocal | validation du média puis transcription | texte transcrit, langue et incertitudes |
| Photo | validation, orientation et analyse visuelle | observations et champs candidats |
| Document | validation du type, extraction et segmentation | structure, texte et champs candidats |

Les fichiers et contenus restent soumis aux règles de taille, type, propriété, conservation et confidentialité. Les données sensibles envoyées à un fournisseur doivent être minimisées selon une politique approuvée.

## Capacités

Le cerveau peut fournir :

* compréhension conversationnelle ;
* transcription vocale ;
* extraction structurée ;
* OCR intelligent ;
* compréhension visuelle et documentaire ;
* détection des informations manquantes ;
* préparation d'une réponse structurée ;
* préparation du texte canonique sous contraintes de ton.

Il ne calcule pas un total faisant autorité, ne valide pas un paiement et ne décide pas seul d'un débit, d'un numéro, d'une date d'émission ou d'une génération finale.

## Architecture logique

```text
CANAL WHATSAPP
  -> INGESTION ET VALIDATION DU MÉDIA
  -> ROUTEUR MULTIMODAL CONFIGURÉ
       -> compréhension / transcription / vision / extraction
  -> VALIDATION DU SCHÉMA ET DE LA CONFIANCE
  -> MOTEUR MÉTIER KADI
       -> propriété, état, calculs, manques, action autorisée
  -> COMPOSEUR DE RÉPONSE TEXTE
  -> VALIDATION DU TEXTE CANONIQUE
  -> VOICE POLICY ENGINE
       -> TEXT_ONLY
       -> TEXT_AND_VOICE -> VoiceProvider configuré
  -> ENVOI CONTRÔLÉ ET IDEMPOTENT
```

## Rôles recommandés et configurables

| Acteur | Rôles possibles | Ne doit pas faire |
|---|---|---|
| OpenAI | compréhension conversationnelle, transcription, réponse sous contrat, synthèse vocale selon configuration | devenir source de vérité métier |
| Gemini | fournisseur principal prévu pour compréhension des images, OCR intelligent, lecture des photos WhatsApp, analyse des PDF et documents, compréhension des tableaux et mises en page, et extraction structurée depuis les contenus visuels | imposer un schéma, inventer une valeur ou devenir source de vérité métier |
| Backend Kadi | validation, calculs, crédits, paiements, états, numéros, dates, propriété, génération et livraison | déléguer son autorité à une sortie probabiliste |

Dans l'architecture cible actuelle, Gemini est donc le moteur principal prévu pour la vision, l'OCR intelligent, la compréhension documentaire et l'extraction structurée à partir des images et PDF. Ce choix reste derrière `VisionDocumentProvider`, remplaçable par configuration et révisable après évaluation. Aucun appel Gemini direct ne doit être dispersé dans les parcours métier.

Ces rôles sont des recommandations de capacité. Le fournisseur principal par capacité, le modèle et le fallback sont des paramètres de configuration validés. Un parcours ne contient pas de branche métier « si OpenAI » ou « si Gemini ». Toute sortie Gemini est validée par le backend avant persistance ou utilisation métier ; le backend recalcule notamment les sous-totaux, taxes, remises et totaux.

## Abstractions recommandées

Les noms sont conceptuels et ne prescrivent aucune implémentation immédiate :

```text
ConversationUnderstandingProvider
  understand(validated_input, allowed_context, output_schema)

TranscriptionProvider
  transcribe(validated_audio, locale_hints)

VisionDocumentProvider
  extract(validated_media, document_hint, output_schema)

VoiceProvider
  synthesize(validated_text, locale, voice_style, output_format)
```

Chaque adaptateur normalise erreurs, métriques et sortie, sans exposer les objets bruts du fournisseur au métier.

## Contrat d'une sortie IA

Une sortie exploitable contient :

* intention candidate ;
* champs structurés conformes à une liste autorisée ;
* provenance par champ lorsque utile ;
* indicateurs d'incertitude ;
* informations manquantes candidates ;
* proposition de réponse, séparée des données métier.

Le backend :

1. valide le schéma et les bornes ;
2. rejette les champs inconnus ;
3. recalcule tous les montants ;
4. applique propriété, version et machine d'états ;
5. choisit la seule prochaine action autorisée ;
6. compose ou valide le texte canonique ;
7. décide de l'audio avec la politique déterministe.

### Extraction visuelle structurée

Selon le contenu et le type de document, Gemini doit pouvoir proposer une structure contenant notamment :

* type du document ;
* émetteur ;
* client ou bénéficiaire ;
* articles ou objets ;
* quantités et prix unitaires ;
* taxes, remises et totaux lus ;
* dates lues et références ;
* notes ;
* champs absents ;
* champs incertains ou contradictoires.

Cette proposition n'est jamais une donnée métier confirmée par elle-même. Le backend valide types, bornes, propriété et cohérence, recalcule les montants et décide quels champs peuvent être persistés.

### Contrat fonctionnel des incertitudes

Un champ illisible, ambigu, contradictoire ou peu fiable ne doit jamais être inventé. La sortie doit distinguer explicitement :

* valeur confirmée ;
* valeur incertaine ;
* valeur absente ;
* valeur contradictoire.

Le contrat fonctionnel doit transporter un équivalent de `uncertainties[]`, `needs_confirmation`, `confidence` ou `confidence_level`, et `source_reference` lorsque disponible. Ces noms illustrent les informations requises sans imposer un schéma technique définitif.

Une valeur incertaine peut être proposée comme candidate, mais elle n'est ni persistée comme confirmée, ni utilisée pour calculer un total final. Kadi demande une confirmation ciblée ou ouvre une correction.

Exemple : si le prix de l'ordinateur est difficile à lire sur une photo, Gemini peut proposer une valeur en la marquant incertaine. Le backend la garde hors des données confirmées et Kadi demande : « J'ai du mal à lire le prix de l'ordinateur. Quel est le montant exact ? » Kadi ne choisit pas silencieusement entre deux valeurs et ne calcule pas un total définitif avant confirmation.

## Sélection des fournisseurs

Une capacité utilise un seul fournisseur principal par requête normale. Un second fournisseur est permis uniquement pour :

* benchmark hors production ou explicitement consenti ;
* shadow mode sans effet utilisateur ni écriture métier ;
* canary contrôlé avec critères d'arrêt ;
* fallback explicitement autorisé pour une erreur classée.

Le fallback ne doit pas doubler une opération, un message, un coût ou une écriture. Les appels concurrents systématiques aux deux fournisseurs sont interdits pour une réponse normale.

## Voice Policy Engine

Le moteur reçoit préférence utilisateur, modalité précédente, demande explicite, longueur, complexité, sensibilité, étape, disponibilité, budget et limites. Il retourne `TEXT_ONLY` ou `TEXT_AND_VOICE`.

La sensibilité et les interdictions dominent la préférence. Un fournisseur indisponible entraîne le texte seul. L'audio est généré uniquement depuis le texte validé et conserve sa version ou son empreinte.

## Sécurité et confidentialité

* Minimiser le contexte transmis et exclure secrets, tokens et configurations.
* Ne jamais journaliser contenu personnel complet, média brut, payload fournisseur complet ou en-têtes d'authentification.
* Assainir les erreurs par liste fermée, longueur et profondeur limitées.
* Vérifier propriété et consentement avant traitement d'un média.
* Appliquer une politique de rétention explicite aux fichiers source, transcriptions et audios générés.
* Ne jamais vocaliser automatiquement téléphone complet, identifiant fiscal, compte, secret, code ou donnée de paiement sensible.
* Une voix clonée exige un consentement explicite, vérifiable et conservé selon une procédure approuvée.

## Résilience

| Échec | Comportement sûr |
|---|---|
| transcription indisponible | demander une saisie écrite ou une nouvelle tentative, sans perdre le contexte |
| extraction incertaine | conserver les candidats séparément et poser une question précise |
| sortie hors schéma | rejeter la sortie et ne rien persister comme vérité |
| fournisseur principal indisponible | fallback autorisé ou réponse humaine de reprise ; jamais double appel implicite |
| synthèse vocale indisponible | envoyer le texte validé uniquement |
| timeout après réponse incertaine | dédupliquer par identifiant de requête avant retry |
| conflit de version | recharger l'état serveur et demander confirmation si nécessaire |

## Observabilité et évaluation

Mesurer par capacité : latence, disponibilité, coût, taux de sortie valide, corrections utilisateur, champs manquants, erreurs de langue et qualité perçue. Les métriques n'incluent pas de données personnelles en clair.

Les changements de modèle ou fournisseur passent par corpus fictif ou consenti, benchmark reproductible, shadow/canary autorisé, critères d'arrêt et comparaison avec la référence. Pour la voix, appliquer le protocole local défini dans `docs/kadi_voice_experience.md`.

## Décisions à arbitrer

* fournisseur et modèle principaux pour chaque capacité ;
* règles précises de fallback et délais ;
* langues et détection de langue ;
* seuils d'incertitude et niveau de revue humaine ;
* conservation des médias, transcriptions et sorties structurées ;
* budget par modalité et politique de quotas ;
* fournisseur vocal, voix exacte et format audio ;
* conditions d'un shadow mode avec données réelles ;
* gouvernance du consentement pour une voix personnalisée ;
* stratégie de tests de non-régression multimodale.

Aucune de ces décisions ne doit être codée silencieusement dans un parcours métier.
