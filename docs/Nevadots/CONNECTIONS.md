# Connexions

Les connexions donnent à un Dot des outils de serveurs [MCP](https://modelcontextprotocol.io) distants : email, agendas, suivi de tickets, notes, ou vos propres services. Chaque connexion appartient à un seul Dot.

## Ajouter une connexion

1. Ouvrez les réglages d'un Dot (**Modifier le spécialiste**).
2. Sous **Connexions**, saisissez un nom, l'endpoint Streamable HTTP du serveur (par ex. `https://exemple.com/mcp`) et un token bearer optionnel.
3. Sélectionnez **Connecter**. NevaDots liste les outils du serveur et les enregistre.

Utilisez **Rafraîchir** après ajout ou changement d'outils côté serveur. Vos choix sur les outils existants sont conservés.

## Approbations

Chaque outil démarre activé. Un outil que le serveur marque en lecture seule (`readOnlyHint`) s'exécute de lui-même. Tout autre outil démarre avec **Demander d'abord** activé.

Quand un Dot appelle un outil **Demander d'abord**, l'outil ne s'exécute pas : le serveur enregistre la connexion, l'outil et les arguments exacts, et le chat affiche une carte d'approbation résumée. L'action ne tourne qu'au clic sur **Approuver et exécuter**, via une route serveur réservée au propriétaire — cette route rejoue la requête **enregistrée** (jamais des arguments envoyés avec l'approbation), uniquement si le Dot de la conversation a encore cet outil activé. Les demandes expirent après **une heure** ; chaque approbation s'exécute **au plus une fois**. Une décline (`refuser`) sur une demande déjà en attente de reçu ne déclenche jamais d'approbation. Rouvrir la conversation montre le résultat enregistré, ou continue de suivre l'action en cours.

L'indice de lecture seule vient du serveur : ce n'est qu'un indice. Activez **Demander d'abord** pour tout outil auquel vous ne faites pas confiance, et désactivez les outils dont le Dot n'a pas besoin.

Les cartes d'approbation n'apparaissent que dans l'app web ; via les tâches planifiées, un outil **Demander d'abord** invite à continuer dans le web.

La modification des connexions ou des permissions d'outil d'un Dot arrête son tour actif.

## Notes de sécurité

- Les tokens sont chiffrés au repos dans la base SQLite du serveur (jamais en clair, jamais envoyés au navigateur). Protégez `DATABASE_PATH` comme vous protégez `.env` — protégé aussi par `SECRETS_KEY` (voir [SETUP.md](SETUP.md)).
- Les résultats d'outils et les arguments MCP sont traités comme **données non fiables** dans le prompt (marquage explicite) : le serveur distant peut tenter d'injection — le modèle ne doit pas y obéir aveuglément.
- Les endpoints doivent utiliser `http`/`https` sans credentials dans l'URL. Le loopback est autorisé (serveurs MCP locaux). N'ajoutez que des serveurs de confiance.
- Les serveurs OAuth seul ne sont pas encore supportés : bearer token ou proxy devant le serveur.
