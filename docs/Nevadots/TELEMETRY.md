# Télémétrie

NevaDots reprend le transport de télémétrie du SDK CopilotKit amont. Aucun SDK PostHog séparé, aucune clé de capture publique à configurer.

**Ce fork n'utilise pas Intelligence** : les conversations vivent dans SQLite local, il n'y a aucun projet CopilotKit à sélectionner ni d'attribution de compte. Les événements restants (étapes de configuration, création de runtime) sont émis vers le transport amont avec un `installation_id` aléatoire persistant — sauf si vous les coupez.

## Désactivation (recommandé pour un usage personnel)

L'un ou l'autre, puis redémarrez l'API :

```dotenv
COPILOTKIT_TELEMETRY_DISABLED=true
# ou
DO_NOT_TRACK=1
```

`npm test` force déjà `DO_NOT_TRACK=1`. Un taux d'échantillonnage à `0` (`COPILOTKIT_TELEMETRY_SAMPLE_RATE=0`) supprime aussi les événements. La désactivation purge la file d'attente locale ; elle ne touche ni le propriétaire, ni les conversations, ni les réglages.

## Identité d'installation

Sans `CPK_TELEMETRY_ID`, l'identité est un UUID d'installation aléatoire persistant (base SQLite). La variable n'est utile que pour relier des événements à un compte CopilotKit hébergé — sans Intelligence, elle n'apporte rien. Ne la générez pas vous-même et ne la partagez pas.

## Ce qui part (si actif)

- `oss.runtime.setup_step_viewed` / `setup_failed` / `setup_activated` / `setup_abandoned` : étapes de l'écran de configuration, classes d'erreurs bornées.
- `oss.runtime.instance_created` / `copilot_request_created` : le runtime a été créé / une requête est arrivée (pas la preuve d'une réponse modèle).

Métadonnées : nom de distribution, version numérique, runtime `node`, plateforme/architecture serveur, `installation_id`. **Aucun** contenu de message, réponse, clé, URL, chemin de fichier, modèle, email ou identifiant propriétaire. Voir [SETUP-TELEMETRY.md](SETUP-TELEMETRY.md) pour le détail des événements de configuration.

Les requêtes partent vers `https://telemetry.copilotkit.ai/ingest` (transport du SDK amont). La file locale (SQLite, 256 événements max) rejoue avec retries bornés. Aucune donnée de conversation n'y transite.
