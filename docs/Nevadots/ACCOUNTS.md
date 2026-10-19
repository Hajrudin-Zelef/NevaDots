# Comptes multi-utilisateurs (NevaDots)

Chaque personne a **son propre compte** : son monde (espaces, Dots, conversations, pages, mémoire, pièces jointes), ses providers/modèles autorisés, ses limites. Un compte ne voit jamais les données d'un autre — une ressource d'autrui répond **404**, comme si elle n'existait pas.

## Rôles

| Rôle            | Droits                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------- |
| **Admin**       | Tout : gérer les comptes (Paramètres → Comptes), tous les providers/modèles, pas de limite. |
| **Utilisateur** | Son monde uniquement, avec les providers/modèles et les limites que l'Admin lui a assignés. |

## Premier compte (bootstrap)

1. Le serveur exige `ADMIN_MASTER_PASSWORD` (variable d'environnement, fail-closed au boot : sans elle, le serveur refuse de démarrer).
2. Ouvrir `https://nevadots.neva-ci.pro/bootstrap`, entrer le **mot de passe maître**, un nom d'utilisateur et un mot de passe (12 caractères minimum).
3. Le premier compte est Admin. Au bootstrap, **toutes les données existantes** (monde, conversations, pièces jointes, ordinateurs, consommation) sont rattachées à ce compte, et la plus ancienne conversation devient la « Discussion principale ».

Il n'y a **pas** de page de connexion par jeton, ni de break-glass : si la base comptes est cassée, voir « Récupération directe dans SQLite » ci-dessous.

## Créer / gérer un compte (Admin)

Paramètres → **Comptes** (onglet visible pour les Admins uniquement) :

- **Créer** : nom, mot de passe (12+), rôle, profil de tâches (Code / Recherche / Rédaction / Polyvalent / Personnalisé — des raccourcis qui pré-cochent providers et modèles, seule la liste finale est enregistrée), providers (cases), modèles (cases, filtrés par providers), **limite mensuelle ($)** et **nombre max de Dots**. Pour un Utilisateur, au moins un provider et un modèle sont obligatoires. Un Admin n'a jamais de restriction (listes forcées à NULL).
- **Modifier** : rôle, providers/modèles, limites.
- **Changer le mot de passe** d'un autre compte → toutes ses sessions sont révoquées.
- **Supprimer** : confirmation + mot de passe maître. **Toutes les données du compte sont effacées** (Dots, conversations, mémoire, fichiers, ordinateurs, consommation) — **irréversible**. Le journal d'audit est conservé (trace de sécurité). Impossible de supprimer son propre compte, ni le dernier Admin.
- **Journal d'audit** : les 100 derniers événements (connexion, création, suppression, échecs…) sans données sensibles.

## Sessions

- Cookie `nevadots-session` : `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` en HTTPS. Le cookie ne contient qu'un id aléatoire ; la session vit côté serveur (id stocké haché en SHA-256).
- **24 h d'inactivité** ou **7 jours maximum** — après, reconnexion.
- **Déconnexion** : la session est révoquée côté serveur (le cookie ne marche plus).
- **Rate-limit** : 5 tentatives / minute / IP sur login, reset, bootstrap et suppression de compte. Pas de verrouillage de compte. XFF pris en compte uniquement si `TRUST_PROXY=true`, sinon adresse socket.

## Mot de passe oublié (hors ligne, zéro mail)

1. L'utilisateur demande à un Admin un **code de réinitialisation**.
2. L'Admin génère le code (256 bits, stocké haché, expire en 1 h) et le transmet **hors ligne** (de vive voix, messagerie…).
3. L'utilisateur ouvre `/reset`, entre le code + son nouveau mot de passe (12+).
4. Le code est détruit, **toutes les sessions de l'utilisateur sont révoquées**, il se reconnecte avec le nouveau mot de passe.

## Limites (enforcement)

- **Max Dots** : la création d'un Dot au-delà du max est refusée.
- **Providers / modèles** : un Dot ne peut utiliser que les providers/modèles autorisés (vérifié à la création, au changement de modèle, et sur le modèle résolu avant chaque tour). Hors liste → refus. Le catalogue et la liste des providers sont filtrés (provider hors liste → 404).
- **Limite mensuelle (DURE)** : quand le coût du mois calendaire (UTC) atteint la limite, les **nouveaux tours sont refusés** (« Monthly usage limit reached. »). Les lectures (conversations, mémoire) ne sont pas bloquées.

## Sessions maître et parallèles

La **première conversation** du compte est la « Discussion principale » (session maître). Les autres sont des « Discussions parallèles ». Si la maître est fermée, la prochaine conversation créée devient la nouvelle maître. La mémoire est **unifiée par compte** (partagée par tous ses Dots).

## Récupération directe dans SQLite (base comptes cassée)

Pas de break-glass : on répare **en direct dans la base**. Base : `data/opendots.sqlite` (ou `$DATABASE_PATH`).

**Avant tout : arrêter le service et sauvegarder la base.**

```sh
sudo systemctl stop opendots
cp data/opendots.sqlite data/opendots.sqlite.bak
```

**Attention :** le hash argon2id contient des `$` — ne jamais le coller dans une commande shell (`sqlite3 "…'$hash'…"` le mangerait). On passe par un script Node qui écrit dans la base sans interpolation shell.

Créer `recovery.mjs` (dans le dossier du serveur) :

```js
// recovery.mjs — réinitialise un mot de passe ou crée un Admin directement.
// Usage : node recovery.mjs reset <username> <nouveau-mot-de-passe>
//         node recovery.mjs create-admin <username> <mot-de-passe>
import { DatabaseSync } from 'node:sqlite';
import { argon2id } from 'hash-wasm';
import { randomBytes, randomUUID } from 'node:crypto';

const [mode, username, password] = process.argv.slice(2);
if (!username || !password || password.length < 12) {
  console.error(
    'Usage : node recovery.mjs <reset|create-admin> <username> <mot-de-passe-12+>',
  );
  process.exit(1);
}
const db = new DatabaseSync(
  process.env.DATABASE_PATH ?? 'data/opendots.sqlite',
);
const hash = await argon2id({
  password,
  salt: randomBytes(16),
  parallelism: 1,
  iterations: 3,
  memorySize: 65536, // 64 MiB — mêmes paramètres que le serveur
  hashLength: 32,
  outputType: 'encoded',
});
if (mode === 'reset') {
  const { changes } = db
    .prepare('UPDATE users SET passwordHash=? WHERE username=?')
    .run(hash, username);
  if (!changes) {
    console.error(`Compte introuvable : ${username}`);
    process.exit(1);
  }
  // Révoquer les sessions de ce compte (sinon l'ancienne session reste valide).
  db.prepare(
    'DELETE FROM sessions WHERE userId = (SELECT id FROM users WHERE username=?)',
  ).run(username);
  console.log(
    `Mot de passe réinitialisé pour ${username} (sessions révoquées).`,
  );
} else if (mode === 'create-admin') {
  db.prepare(
    "INSERT INTO users (id, username, passwordHash, role, disabled, createdAt, lastLoginAt, allowedProviders, allowedModels, monthlyLimitUsd, maxDots) VALUES (?, ?, ?, 'admin', 0, ?, NULL, NULL, NULL, NULL, NULL)",
  ).run(randomUUID(), username, hash, Date.now());
  console.log(`Compte Admin créé : ${username}.`);
} else {
  console.error('Mode inconnu : reset ou create-admin.');
  process.exit(1);
}
db.close();
```

**Réinitialiser un mot de passe :**

```sh
node recovery.mjs reset marie 'nouveau-mot-de-passe-12+'
```

**Créer un Admin directement** (si aucun compte n'existe) :

```sh
node recovery.mjs create-admin admin 'mot-de-passe-admin-12+'
```

**Lister les comptes :**

```sh
sqlite3 data/opendots.sqlite "SELECT id, username, role, disabled, datetime(createdAt/1000, 'unixepoch') AS cree FROM users;"
```

**Débloquer un compte / supprimer une session bloquée :**

```sh
sqlite3 data/opendots.sqlite "UPDATE users SET disabled = 0 WHERE username='marie';"
sqlite3 data/opendots.sqlite "DELETE FROM sessions WHERE userId = (SELECT id FROM users WHERE username='marie');"
```

**Consulter le journal d'audit :**

```sh
sqlite3 data/opendots.sqlite "SELECT action, username, ip, datetime(at/1000, 'unixepoch') AS quand FROM auth_audit ORDER BY at DESC LIMIT 20;"
```

Puis redémarrer le service : `sudo systemctl start opendots`.
