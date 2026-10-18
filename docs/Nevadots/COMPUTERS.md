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
- **Isolation** : isolation Docker standard (noyau partagé). `COMPUTER_RUNTIME=runsc` sélectionne un runtime gVisor — voir « Durcir avec gVisor (runsc) » ci-dessous. Accès shell = programmes et réseau dans le conteneur ; c'est le niveau de confiance à accepter.

### Durcir avec gVisor (runsc)

Par défaut, les conteneurs des Dots tournent avec le runtime Docker standard (`runc`, noyau partagé avec l'hôte). `COMPUTER_RUNTIME=runsc` les fait tourner sous gVisor : un noyau virtuel qui intercepte les appels système du conteneur et réduit la surface d'évasion vers l'hôte. C'est la voie d'attaque la plus probable qui est durcie (un Dot qui s'échappe de son conteneur). runsc ne protège pas le superviseur lui-même (il tourne toujours sous `runc`) et ne remplace pas le proxy socket (voir « Risque accepté ») — le montage du socket reste en place.

**Installer (Debian/Ubuntu, méthode recommandée, paquet apt).** D'après la [doc d'installation gVisor](https://gvisor.dev/docs/user_guide/install/) :

```sh
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null
sudo apt-get update && sudo apt-get install -y runsc
```

Le paquet configure Docker automatiquement quand Docker est installé. Vérifier : `runsc --version`, puis `docker info` doit lister `runsc` parmi les runtimes, et `docker run --rm --runtime=runsc hello-world` doit réussir.

**Activer.** Dans `.env` : `COMPUTER_RUNTIME=runsc`, puis redémarrer le superviseur (`docker compose -f compose.computers.yml up -d computer-supervisor`). Les conteneurs déjà créés gardent leur runtime ; seuls les nouveaux conteneurs (ou recréés) tournent sous runsc.

**Vérifier.** Démarrer l'ordinateur d'un Dot, puis inspecter son conteneur : `docker inspect <conteneur>` doit afficher `"Runtime": "runsc"` sous `HostConfig`. Si ce n'est pas le cas, le superviseur n'a pas pris la variable (vérifier le `.env` et le redémarrage du superviseur).

gVisor peut refuser certains appels système exotiques et ralentir les charges lourdes — si un Dot se comporte bizarrement sous runsc, tester sans pour isoler.

## Risque accepté : socket Docker du superviseur

Le superviseur monte le socket Docker de l'hôte (`compose.computers.yml:47` : `${ENGINE_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock`). C'est volontaire — c'est comme ça qu'il crée les conteneurs des Dots — mais c'est le plus gros risque unitaire du système.

**Blast radius.** Le socket Docker est la télécommande de Docker : qui le contrôle peut créer n'importe quel conteneur, y compris privilégié, et monter n'importe quel dossier de l'hôte. Une compromission du superviseur = root sur la machine hôte. Les conteneurs des Dots, eux, ne montent pas le socket : un Dot qui s'échappe de son conteneur n'obtient pas le socket.

**Ce qui est trusted (et pourquoi le risque est accepté pour l'instant).** Déploiement mono-utilisateur ; le port du superviseur n'écoute qu'en loopback ; les requêtes de cycle de vie exigent le token superviseur ; les conteneurs des Dots sont non privilégiés, bornés (2 CPU / 4 Go), et peuvent tourner sous gVisor (voir ci-dessus). Le vrai correctif — un proxy socket qui ne laisserait passer que les appels de cycle de vie nécessaires et refuserait les montages de chemins hôte — est un chantier à part, différé (un composant de plus à maintenir, du coût opérationnel).

**Ce qui changerait la décision.** Déploiement multi-utilisateur, superviseur exposé au-delà du loopback, ou compromission avérée du superviseur → le proxy socket devient obligatoire, et le montage direct du socket doit être retiré.

## Vérifier

Deux Dots, capacités testées : fichier écrit par le premier invisible pour le second ; persistance stop/start ; session navigateur après redémarrage ; prise/reprise de contrôle ; permissions désactivées ; comportement en pause. Un statut « indisponible » peut signifier daemon Docker arrêté, image non buildée, credentials divergents ou adresse computer injoignable — ce n'est jamais un prétexte à retomber sur l'hôte.

Changement de token maîtresse ou d'image : le superviseur remplace les conteneurs qu'il possède à leur prochaine requête ensure (volumes profil/workspace conservés, activité en cours terminée) — coordinatez avec le travail actif.
