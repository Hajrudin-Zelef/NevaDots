# Application Android (TWA)

L'app Android est une **TWA** (Trusted Web Activity) : une coquille Android
autour de `https://nevadots.neva-ci.pro`, sans barre d'URL. Elle ne contient
pas le serveur — elle a besoin du site en ligne.

- Package : `pro.neva_ci.nevadots`
- Nom : NevaDots
- Icône : `public/app-icon-512.png` (le « N »), variante maskable pour les
  lanceurs qui rognent.
- Build : GitHub Actions (`.github/workflows/android.yml`) → APK signé + AAB.

## 1. Secrets GitHub (obligatoire)

`Settings → Secrets and variables → Actions`, trois secrets :

| Secret                      | Valeur                                             |
| --------------------------- | -------------------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | `base64 -w0 OffLineFork/android/nevadots.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | voir `OffLineFork/android/KEYSTORE_PASSWORD.txt`   |
| `ANDROID_KEY_PASSWORD`      | le même mot de passe (clé et keystore identiques)  |

**Sauvegarde le keystore et son mot de passe hors du dépôt.** Sans eux, plus
aucune mise à jour possible sur le Play Store (l'empreinte change).

## 2. Vérification du domaine (obligatoire)

Chrome vérifie `https://nevadots.neva-ci.pro/.well-known/assetlinks.json`
**sans session**. Deux conditions :

1. Le serveur le sert publiquement — c'est le cas (porte statique, fichier
   `public/.well-known/assetlinks.json`).
2. Le reverse-proxy ne bloque pas les chemins commençant par un point. Si
   nginx renvoie `403` (règle `location ~ /\. { deny all; }`), ajouter
   **avant** cette règle :

   ```nginx
   location ^~ /.well-known/ {
       proxy_pass http://<cible-du-site>;   # même cible que le reste du site
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

   puis `sudo nginx -t && sudo systemctl reload nginx`.

Contrôle : `curl -s https://nevadots.neva-ci.pro/.well-known/assetlinks.json`
doit renvoyer le JSON (pas de redirection, pas de 403).

## 3. Construire l'APK

`Actions → Android (TWA) → Run workflow`. À la fin, l'artefact
`nevadots-android` contient :

- `app-release-signed.apk` — à installer (sideload) ;
- `app-release-bundle.aab` — pour le Play Store.

Rebuild nécessaire uniquement si le nom, l'icône, le package ou la version
changent : le contenu de l'app, lui, suit le site.

## 4. Installer

Transférer l'APK sur le téléphone, autoriser « Installer des applications
inconnues » pour le gestionnaire de fichiers, puis ouvrir le fichier.
Au premier lancement, se connecter : la session est partagée avec Chrome et
persiste.

## 5. Play Store (plus tard, 25 $)

1. Créer un compte développeur, puis une app avec le package
   `pro.neva_ci.nevadots`.
2. Téléverser l'AAB.
3. Récupérer l'empreinte SHA-256 de la **Play App Signing key** et l'ajouter
   au tableau `sha256_cert_fingerprints` de `assetlinks.json` (garder celle
   du keystore local pour le sideload), puis redéployer.
4. Compte personnel récent : test fermé avec 12 testeurs pendant 14 jours
   avant la publication.

## Mise à jour des icônes

Les sources sont générées depuis `OffLineFork` (script local) :
`app-icon-512.png` (84 % de la surface), `app-icon-maskable-512.png` (68 %,
zone de sécurité), `app-icon-192.png`. Fond `#000016`.
