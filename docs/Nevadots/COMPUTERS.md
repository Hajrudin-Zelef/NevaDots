# Un ordinateur par Dot

NevaDots connecte chaque spécialiste à son propre conteneur via le service computer/supervisor d'[OpenBot](https://github.com/CopilotKit/OpenBot). L'identifiant du Dot détermine son conteneur et ses volumes persistants. Fichiers et profils navigateur survivent au stop/start ; ils sont séparés des pages d'espaces et de l'historique de conversation.

Les outils computer exposés au même agent que le chat web, les tâches planifiées et la délégation de calcul vocale obéissent à des permissions **par Dot** (navigateur, fichiers, terminal), sauvegardées côté serveur et vérifiées par le serveur. Elles démarrent désactivées. Aucune action ne retombe sur l'hôte applicatif quand le service computer est indisponible.

## Démarrage en développement local

Docker Engine + Compose v2 + BuildKit requis. Application sur Node.js 24 (voir [SETUP.md](SETUP.md)). Deux secrets aléatoires distincts (24+ caractères) dans `.env` :

```dotenv
COMPUTER_SUPERVISOR_URL=http://127.0.0.1:4312
COMPUTER_SUPERVISOR_TOKEN=REMPLACER_PAR_UN_SECRET_ALÉATOIRE
COMPUTER_TOKEN=REMPLACER_PAR_UN_AUTRE_SECRET_ALÉATOIRE
COMPUTER_NAMESPACE=nevadots
```

Le token superviseur autorise les requêtes de cycle de vie. Le token computer est une clé maîtresse dont un credential **par Dot** est dérivé (HMAC) — la maîtresse reste dans l'app et le superviseur ; aucun conteneur ne la reçoit.

```sh
docker compose -f compose.computers.yml build computer-image computer-supervisor
docker compose -f compose.computers.yml up -d computer-supervisor
npm run dev
```

Le service `computer-image` est une cible de build, pas un conteneur à faire tourner. Le superviseur crée le conteneur d'un Dot au démarrage de son ordinateur. L'overlay `compose.computers-app.yml` relie une app conteneurisée au réseau du superviseur ; seul le superviseur monte le socket Docker.

## Utiliser l'ordinateur

- **Navigateur** : navigation et inspection de la page courante (captures, snapshots d'éléments). Les profils gardent cookies et connexions.
- **Contrôle** : pausez l'agent pour cliquer, taper, scroller ; l'agent reprend avec un snapshot frais.
- **Fichiers** : navigateur de lignes cliquables (`..`, tri), lecture/écriture dans le workspace, accusé + `append` + confirmation d'écrasement. Chemins relatifs au workspace uniquement. Distinct des pièces jointes du chat.
- **Terminal** : commandes bornées (plafond 10 min) dans le conteneur, flux d'activité exec en direct. La sortie n'exécute jamais sur l'hôte applicatif.
- **Activité** : noms d'actions, demandeur, succès/échec — les valeurs saisies, contenus de fichiers et commandes complètes en sont délibérément exclus.

## Bornes

- **CPU 2 cœurs / RAM 4 GiB** par conteneur (plafond, configurable via `COMPUTER_CPUS` / `COMPUTER_MEMORY_BYTES`).
- **Disque** : pas de quota dur ; les logs sont bornés (30 Mo) et l'usage disque est visible dans l'onglet Fichiers.
- **Clone git** : hôte public validé, `--depth 1 --single-branch`, transfert borné (500 Mo, kill du groupe au dépassement), `.git/config` neutralisé après usage.
- **Isolation** : isolation Docker standard (noyau partagé). `COMPUTER_RUNTIME=runsc` sélectionne un runtime gVisor **déjà installé** sur l'hôte — le template ne l'installe pas. Accès shell = programmes et réseau dans le conteneur ; c'est le niveau de confiance à accepter.

## Vérifier

Deux Dots, capacités testées : fichier écrit par le premier invisible pour le second ; persistance stop/start ; session navigateur après redémarrage ; prise/reprise de contrôle ; permissions désactivées ; comportement en pause. Un statut « indisponible » peut signifier daemon Docker arrêté, image non buildée, credentials divergents ou adresse computer injoignable — ce n'est jamais un prétexte à retomber sur l'hôte.

Changement de token maîtresse ou d'image : le superviseur remplace les conteneurs qu'il possède à leur prochaine requête ensure (volumes profil/workspace conservés, activité en cours terminée) — coordinatez avec le travail actif.
