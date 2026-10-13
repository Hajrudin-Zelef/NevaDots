# Plan — Avatar animé par état (NevaDots)

Statut : **réalisé** (2026-10-13) — non committé. Branche `NevaDots-refont-UI`, base `5055c75`.
Suite de `ROBOT-AVATAR-PLAN.md` (le 7ᵉ avatar `robot`).
Vérifié : typecheck/lint/build, **342 tests**, restart `opendots` ; Playwright réel = clips observés
idle→working→thinking→searching avec fondu capturé, 0 erreur console ; badge Muse OK ; `/dots/*` en
`public, max-age=86400`. 7 clips (~5,4 Mo) : 208 px, 12 fps natif, alpha doux, bleu de bord.
Implémentation : le système ne s'active **que pour `robot`** (les 6 PNG restent inchangés).

## Objectif

L'avatar « robot » (LEO) change de clip animé selon l'état du Dot (réfléchit, écoute, recherche,
travaille, écrit, en pause, analyse) **de manière fluide et transparente** (fondu enchaîné, jamais
d'écran blanc ni de saut). Les clips sont fournis par l'utilisateur dans
`OffLineFork/AVATAR DOTS/LEO/` (APNG 320×320, 120 frames, 12 fps, boucle 10 s, alpha 8 bits, matte noir).

## États app → clip (nom de fichier identique à l'état)

`listening · thinking · analyzing · searching · working · writing · paused` → `robot-<état>.webp`.
`idle` = `robot.webp` (base existante). `complete`/`error` → `idle`. Repli : exact → `idle` → base.

## Modifications

1. **Conversion** (Pillow, `venv-cetas`) : pipeline v2 — matting teal (les APNG ont un matte noir),
   soft alpha (déjà 8 bits), blend 12→**24 fps** (240 frames), **224 px**, WebP q72/aq60. Crop =
   canvas complet 320 (les 7 clips partagent le même repère → aucun saut de cadrage entre états).
2. **`src/shared/avatars.ts`** : `AVATAR_STATE_FILES` (clé = état app) + `avatarStateSrc(id, state)`
   (exact → idle → base). Aucune modif serveur (l'ID `robot` ne change pas).
3. **`Mascot.tsx`** : wrapper `.dot-layers` (2 `<img>`) transformé par le ressort ; fondu ~350 ms après
   `decode()` ; coalescence anti-scintillement ~400 ms ; préchargement idle-time ; reduced-motion =
   swap sec ; petites surfaces statiques = base seule (token bar incluse dans l'animé).
4. **CSS** : ré-axer `.mascot > img` (imgs sous `.dot-layers`), transition opacité, `will-change` wrapper.
5. **Cache** : `/dots/*` `no-store` → `public, max-age=86400` (`src/server/index.ts`).
6. **Vérif** : tests mapping, typecheck/lint/build/340+, restart ; tour Playwright réel (journal des
   `src` du héros + capture à mi-fondu) ; spec cerveau + index ; aucun commit.

## Futur

ALICE/SAM : mêmes dossiers (`AVATAR DOTS/<DOT>/`) — seulement le PNG source pour l'instant ; le
système est prêt (manifeste par avatar). Dépôt APNG/GIF/WebP par état → ré-encodage + 1 ligne de manifeste.
