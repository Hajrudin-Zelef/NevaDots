# Installation de NevaDots

NevaDots est un fork self-hosted d'OpenDots : une SPA React + un serveur Node (Hono). Les conversations sont persistées **localement** dans SQLite par un runtime SSE durable (`SqliteAgentRunner`) — aucune dépendance à un service hébergé tiers. Pages, configuration d'espaces/Dots et transcrits vivent dans le même fichier SQLite.

## Développement local

Prérequis : Node.js 24 (obligatoire — `node:sqlite`) et npm.

```sh
npm ci
cp .env.example .env
npm run dev
```

L'UI répond sur http://127.0.0.1:5173 ; l'API tourne sur le port 4310 (proxy Vite `/api`). Sans identifiants de modèles, l'app affiche son écran de configuration — elle ne simule jamais de réponses.

`APP_ORIGIN` remplace les origines de dev par défaut (une origine exacte ou une liste séparée par virgules, scheme+host+port exacts, sans chemin ni slash final). Hors dev, laisser `APP_ORIGIN` vide exige que l'origine du navigateur soit identique à l'origine de la requête — le blocage cross-site reste actif.

Pour une build locale :

```sh
npm run build
npm start
```

L'API répond alors sur http://127.0.0.1:4310. Gardez le serveur lancé pour les tâches planifiées.

## Configuration

Éditez `.env` puis **redémarrez le serveur** après tout changement :

| Variable                         | Rôle                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Credential et identifiant de modèle (provider par défaut)          |
| `OPENAI_BASE_URL`                | Endpoint compatible OpenAI (provider direct ou passerelle locale)  |
| `OPENAI_MODELS`                  | Liste des modèles proposés au sélecteur (virgules)                 |
| `OWNER_ID`                       | Identité stable de ce déploiement (conversations persistantes)     |
| `DATABASE_PATH`                  | Fichier SQLite (pages, espace, métadonnées, transcrits)            |
| `OWNER_TOKEN`                    | Jeton d'accès à l'app ; **requis** si `HOST` n'est pas en loopback |
| `APP_ORIGIN`                     | Origines navigateur exactes derrière un proxy ou domaine custom    |
| `SECRETS_KEY`                    | Clé de chiffrement au repos des secrets (voir ci-dessous)          |
| `DATABASE_PATH`                  | Sauvegardez ce fichier : il contient tout le contenu               |

Les clés de modèles peuvent aussi être saisies dans **Réglages → API et Modèles** : elles sont chiffrées au repos (AES-256-GCM, sel par valeur) et jamais renvoyées au navigateur.

### Jeton d'accès et liaisons externes

- `OWNER_TOKEN` (24 caractères minimum) est exigé par défaut, même en loopback : sans jeton, le serveur refuse de démarrer.
- `REQUIRE_OWNER_TOKEN=false` désactive cette exigence (dev local uniquement) ; sans jeton, tout processus local peut appeler l'API (vérifications host/origin seulement) — un warning le signale au démarrage.

### Clé de chiffrement au repos

`SECRETS_KEY` est la **seule** clé de scellage des secrets au repos (clés de providers, tokens MCP, credentials de connecteurs) :

- Sans `SECRETS_KEY`, stocker un secret est **refusé** (jamais de repli en clair).
- `OWNER_TOKEN` n'est accepté qu'en **lecture legacy** pour les valeurs scellées avant cette règle — jamais pour en sceller de nouvelles.
- Faire tourner `SECRETS_KEY` rend les secrets stockés illisibles → ré-entrer les clés.

### Rate-limit

Limite par IP sur `/api/*` : `RATE_LIMIT_PER_MIN` (défaut 1000, `0` désactive). Derrière un reverse-proxy de confiance uniquement, `TRUST_PROXY=true` lit `X-Forwarded-For` ; sinon l'adresse du socket est utilisée (un client ne peut pas forger l'en-tête pour faire tourner les buckets).

## Pièces jointes

Upload immédiat dès la sélection (50 Mo/fichier, aperçu ≤ 5 Mo), brouillon persistant, sweep des orphelines après 7 jours. Le texte est injecté dans le message, les images en parties multimodales, les PDF passent par les outils agent.

### Outils PDF (host-only)

`read_pdf`, `pdf_edit` et `pdf_ocr` s'appuient sur deux binaires externes installés **sur l'hôte** :

- `pdfcraft-cli` (extraction/édition) — chemin via `PDFCRAFT_CLI_PATH` ;
- `ocrmypdf` + ghostscript + tesseract (OCR, langues `fra+eng`) — chemin via `OCRMYPDF_PATH`.

S'ils sont absents (par ex. image Docker sans ces binaires), les outils ne se branchent pas : dégradation propre, pas de crash. Les PDF restent lisibles par le modèle via leur texte natif.

## Recherche web

`WEB_SEARCH_PROVIDER=parallel` (défaut) envoie les requêtes/URLs à un service tiers (clé `PARALLEL_API_KEY` optionnelle pour plus de quota) ; `browser` utilise le lecteur de pages isolé (`BROWSER_URL` + `BROWSER_SECRET`, service séparé, navigation read-only sans JS) ; `disabled` coupe les outils de recherche.

## Ordinateurs persistants par Dot

Un conteneur par Dot avec navigateur, fichiers et shell optionnel : voir [COMPUTERS.md](COMPUTERS.md).

## Connexions MCP

Outils distants (email, calendrier, GitHub…) avec approbation humaine : voir [CONNECTIONS.md](CONNECTIONS.md).

## Voix

Adaptateur Realtime (`VOICE_API_KEY`, `VOICE_MODEL`, `VOICE_NAME`). Appels via micro navigateur + WebRTC ; HTTPS requis en déploiement distant. Une clé configurée ne prouve pas un appel réussi — vérifiez micro, lecture, délégation, interruption, raccroché et reçu.

## Slack

Le module Slack amont (`@copilotkit/channels`) est **dormant dans ce fork** (pas câblé). Variables `SLACK_*` présentes dans `.env.example` pour référence uniquement.

## Conteneurs

```sh
docker compose up --build -d
```

L'API est exposée en loopback ; le service navigateur est optionnel (`--profile browser`). Les données vivent dans le volume `opendots-data`. **L'image app n'embarque pas les binaires PDF** (voir plus haut) — en Docker, `read_pdf`/`pdf_edit`/`pdf_ocr` sont absents.

## Sauvegarde

Sauvegardez le fichier SQLite (`DATABASE_PATH`) **et** le dossier de pièces jointes (`ATTACHMENTS_DIR`, défaut `data/attachments`) : le premier contient pages, espace, liens et transcrits ; le second les fichiers joints et générés.

## Vérifications

```sh
npm run check-format
npm run lint
npm run typecheck
npm test
npm run build
```

Les tests automatisés utilisent des fixtures de service. La vérification live (modèle, computers, voix) exige vos propres services configurés.
