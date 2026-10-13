# Plan — 7ᵉ avatar « robot » animé (NevaDots)

Statut : **v2 réalisé** (2026-10-13) — non committé. Branche `NevaDots-refont-UI`, base HEAD `5055c75`.
V1 : 7ᵉ avatar `robot`, sélecteurs, LEO réglé dessus. V2 : `robot.webp` ré-encodé (24 fps, 240 frames,
224 px, alpha adouci, ~980 KB) + badge circulaire Muse dans l'en-tête + cache rAF. Vérifié :
typecheck, lint, build, **340 tests**, restart `opendots`, captures Playwright (détourage net en clair
et sombre, badge Muse clair/sombre). `public/dots/robot.webp` (224 px) servi en `image/webp`.

## Objectif

Ajouter un avatar animé personnalisé (« robot », robot sarcelle aux yeux cyan) comme **7ᵉ
avatar sélectionnable** par n'importe quel Dot, sans perdre les 6 PNG existants, et régler LEO
dessus. Résultat attendu : visible dans le sélecteur d'avatar (Profil Muse + dialogue Dot), le
héros d'accueil, l'en-tête Muse, la barre de chat, la scène d'intervention, etc.

## v2 (2026-10-13) — fluidité + détoure Muse

Retour utilisateur : l'avatar « lag » et mériterait un détourage façon Muse.

- **Cause** : le WebP v1 était décimé à 6 fps (120→60). Une image animée est jouée à son taux
  encodé ; le navigateur n'ajoute pas de frames. La source n'a que **12 poses/s**.
- **v2** : ré-encodage Pillow → recadrage **plein cadre** (bbox alpha + marge), **alpha adouci**
  (flou ~0,8 px, fini l'escalier 1-bit), **matting teal** anti-frange, **blend 1 frame/2 → ~24 fps**
  (240 frames), **224 px**, WebP q~72. Résultat : fluide, bords doux.
- **Badge Muse** : disque circulaire (`::before`, tokens) derrière `.muse-head .mascot`
  (en-tête du panneau Activité seulement ; le héros d'accueil garde son halo vert).
- **rAF** : cache de `getBoundingClientRect()` dans la boucle de `Mascot.tsx`.
- **Limites assumées** : 60 fps réels impossibles (12 poses/s en source) → l'option « C » (flux
  optique, ffmpeg absent) a été écartée ; 24 fps perçus par fondu.

Statut v2 : voir « Statut » en tête de document.

## Découvertes (état du code)

- L'avatar d'un Dot est un **ID fermé** : `blue|pink|green|mint|orange|purple`.
  - Serveur : 2 enums zod dupliqués — `src/server/workspace-routes.ts:23` (create/maj) et `:281`
    (`PUT /api/dots/:id/avatar`) → 400 sur toute autre valeur.
  - Client : `Mascot.tsx:24` (`avatarFile()`) retombe sur un hash d'identité pour un ID inconnu ;
    `Mascot.tsx:187` code en dur `/dots/${character}.png` ; idem dans les 2 sélecteurs
    (`ActivityPanel.tsx:473`, `WorkspaceDialog.tsx:299`).
- Colonne DB `dots.avatar` = `TEXT` libre (aucune contrainte) ; `serveStatic` sert déjà les `.webp`
  (MIME correct, CSP `img-src 'self' data:` OK) ; **aucun endpoint d'upload** → l'asset passe par le dépôt.
- `Mascot.tsx` superpose ses propres anims (ressort pointeur, bob, hop) sur le `.dot-body`, et des
  metaballs bleus fixes en `listening`/`writing`. Sur les héros `.live`, les anims CSS d'état sont
  déjà neutralisées (`refonte.css:1861`) → un WebP auto-animé + ressort fonctionne sans conflit visuel.

## Assets

- Source : `/home/sam/avatar-robot-anime-transparent.gif` (256×256, 120 frames, 12 fps, boucle 10 s,
  vraie transparence). L'APNG fourni (`...apng`) pèse **9,4 MB** → rejeté (APNG compresse mal les dégradés).
- Conversion dans LXC 102 avec `/home/sam/venv-cetas` (Pillow 12.3, WebP OK) : → `robot.webp` animé,
  256×256, ~60 frames (6 fps), quality ~80, cible **< 200 KB**.
- Livré dans `public/dots/robot.webp`, versionné (déployé via `vite build` → `dist/client/dots/`).

## Modifications

1. **Source de vérité unique** `src/shared/` : exporter `AVATAR_IDS` + `AVATAR_FILES`
   (`blue→blue.png … robot→robot.webp`) et un helper `avatarSrc(id)`. *Piège connu : import entre
   fichiers `src/shared/` en `.js` (build serveur node16).*
2. **Serveur** `workspace-routes.ts:23` et `:281` : `z.enum(AVATAR_IDS)` importé du shared (fini la
   duplication).
3. **Client** :
   - `Mascot.tsx` : `avatarFile()` valide contre les IDs partagés ; `src` via `avatarSrc(id)`
     (plus de `.png` en dur). Le ressort reste actif sur le robot.
   - Sélecteurs `ActivityPanel.tsx` et `WorkspaceDialog.tsx` : src résolu via `avatarSrc` → le robot
     apparaît en 7ᵉ swatch.
4. **Réglage** : `PUT /api/dots/<LEO>/avatar {"avatar":"robot"}` avec l'OWNER_TOKEN.

## Vérification

- `npm run typecheck && npm run lint && npm run build && npm test` (336 tests attendus), restart
  `opendots`.
- Capture Playwright (en-tête Muse, héros, sélecteurs) avec le token injecté en sessionStorage.
- Commit/push **uniquement sur demande**.

## Brain

- Mettre à jour `specs/infra-neva-lxc.md` : registre d'avatars partagé + leçon poids (APNG/GIF → WebP).
