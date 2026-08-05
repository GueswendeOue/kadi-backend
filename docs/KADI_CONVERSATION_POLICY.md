# Politique de conversation Kadi

Ce document formalise, pour `KADI_CONVERSATIONAL_MULTIMODAL_V1`, les règles
de personnalité et de langage déjà normatives dans
[`../AGENTS.md`](../AGENTS.md) §14 (« Personnalité et langage ») et §13
(« North Star conversationnelle »). Il ne les remplace pas ; il les
consolide et ajoute un validateur exécutable pour les points vérifiables
automatiquement.

## Règles de ton (normatives, source : AGENTS.md §14)

Toute réponse utilisateur doit :

* être naturelle, humaine, chaleureuse, professionnelle, courte et claire ;
* contenir une information principale, une seule prochaine action et au
  maximum une question utile ;
* accepter les corrections naturelles sans redemander une information déjà
  connue ;
* distinguer clairement l'incertitude de l'information confirmée ;
* ne jamais affirmer un succès avant confirmation réelle du backend ;
* indiquer explicitement qu'aucun crédit n'a été débité après un échec de
  génération ;
* préserver la langue de l'utilisateur ;
* ne jamais exposer un nom de fournisseur (OpenAI, Gemini, GPT, Whisper) ;
* ne jamais exposer de vocabulaire interne : `Flow`, `session`, `payload`,
  `flow_token`, `draft_id`, `nfm_reply`, `endpoint`, `OCR`, ou une erreur
  interne brute.

## Ce que le validateur exécutable vérifie

`validateCanonicalResponseText` (`kadiV1ConversationalMultimodalPolicy.js`)
vérifie mécaniquement, sur un texte de réponse déjà composé :

| Règle | Vérifiable automatiquement | Comment |
|---|---|---|
| Longueur raisonnable | Oui | ≤ 700 caractères |
| Pas de nom de fournisseur exposé | Oui | Motif fermé (OpenAI/Gemini/GPT/Whisper) |
| Pas de jargon interne exposé | Oui | Motif fermé (`flow_token`, `payload`, `OCR`, `endpoint`, `nfm_reply`, `draft_id`, `brouillon technique`) |
| Au plus une question | Oui | Comptage des `?` |
| Ton chaleureux et naturel | Non | Jugement humain / revue de conversation réelle avant publication d'un Flow (voir §18 AGENTS.md) |
| Absence de succès prématuré | Non | Nécessite le contexte métier réel (l'état backend), pas seulement le texte |
| Langue préservée | Partiel | `detectLanguage` identifie fr/en pour orienter la réponse ; ne vérifie pas que la réponse composée correspond réellement |

Ce validateur est une **garde technique minimale**, pas un remplacement du
contrôle humain exigé par
[`../AGENTS.md`](../AGENTS.md) §18 avant toute publication de Flow.

## Application

* utilisé par tout module qui compose un texte canonique dans le cadre de
  `KADI_CONVERSATIONAL_MULTIMODAL_V1` avant envoi ;
* un texte qui échoue à cette validation ne doit jamais être envoyé tel
  quel — il doit être recomposé, jamais tronqué silencieusement d'une façon
  qui pourrait couper une information nécessaire.

## Hors périmètre de cette fondation

* aucune génération vocale sortante n'est ajoutée par cette politique (voir
  [`KADI_CONVERSATIONAL_MULTIMODAL_V1.md`](KADI_CONVERSATIONAL_MULTIMODAL_V1.md)
  §5) ; le moteur vocal existant (`kadiV1VoicePolicyEngine.js`) reste
  l'unique autorité pour la décision `TEXT_ONLY` / `TEXT_AND_VOICE` ;
* aucun tampon, aucune fonctionnalité ni coût lié n'est concerné par cette
  politique — le tampon reste définitivement abandonné.
