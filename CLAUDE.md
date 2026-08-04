@AGENTS.md

# État actuel de Kadi V1

- P0 à P7 sont déjà validés.
- Ne pas recommencer P0 à P7.
- Le rollout doit rester CANARY.
- Le seul numéro CANARY autorisé est 22670626055.
- Le problème de paiement Meta est déjà résolu.
- La priorité actuelle est le blocage de navigation de l’onboarding.
- Le parcours document et les bugs de décharge viennent après.

# Incident CANARY actuel

Le Flow de bienvenue s’ouvre correctement.

Lorsqu’on appuie sur « Commencer » :

- les questions de profil ne s’affichent pas ;
- à 04:00, le backend a envoyé un message d’échec ;
- à 04:28, le backend a envoyé « Votre profil est enregistré » ;
- aucun nom, prénom ou profil n’a été demandé ;
- une réponse vide ne doit jamais permettre de marquer le profil comme terminé.

# Restrictions

Sans autorisation explicite, ne jamais :

- modifier ou pousser directement sur main ;
- déployer sur Render ;
- modifier les variables Render ;
- modifier les Flows Meta distants ;
- envoyer des messages WhatsApp ;
- modifier le rollout CANARY ;
- ajouter un numéro CANARY ;
- exécuter une migration Supabase distante ;
- supprimer des données ;
- afficher des secrets ;
- effectuer une réécriture générale ;
- modifier les services kadi-beta-cleanup ou kadi-beta-notify.

Commencer chaque mission en lecture seule.
Présenter le diagnostic et le plan avant toute modification.
Ajouter un test qui reproduit le bug avant de le corriger.