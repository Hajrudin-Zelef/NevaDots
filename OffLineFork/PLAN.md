# NevaDots × ajean — Plan de refonte (optimisations agent, fluidité, avatar)

> Référence analysée : `nathaninline/ajean` (Go, binaire unique, IA locale). Patterns transposés
> vers NevaDots (React/Vite + Hono/CopilotKit + LiteLLM). Mécanique reprise, identité NevaDots
> conservée (avatars bleu/rose/vert/menthe/orange/violet).

## Ordre d'exécution

A → B → C → D. Chaque phase : implémenter → tester (typecheck/lint/build + tests + run réel) →
déployer → documenter. Commit/push uniquement sur demande.

## Statut

- **Phase A — TERMINÉE (2026-10-11)**. A1 page-cache, A2/A3 tool-archive+recall, A4 compaction,
  A5 erreurs classées, A6 toggle Réflexion. 322 tests OK. Détails dans le spec infra
  (`~/.operator/specs/infra-neva-lxc.md`) et `DOCUMENTATION/05-journal.md`.
- **Phase B — à venir** (fluidité streaming ; reco B6 à produire à ce moment).

Objectif ressenti : première token < 2 s, pas de 403, tokens d'entrée < 3 k sur un « salut »,
plus de « The current turn returned no response ».

---

## Phase A — Économie du loop agent + UX erreurs (backend, LXC 102)

**A1. Plan de page web au lieu du dump** (`dot-agent.ts`, `parallel.ts`)
- `read_public_page` renvoie : titre, plan (headings + numéros de lignes), taille/nb de lignes,
  extrait de tête ~1 500 car, + un `pageId`. Le texte complet est mis en cache serveur (TTL 10 min,
  par conversation).
- Nouveaux outils `read_page_slice(pageId, from, to)` et `grep_page(pageId, query)`.
- Toute troncature **s'annonce** (« N lignes restantes, relis par tranche »).
- Effet : le web cesse de peser ~10× dans le prompt.

**A2. Aperçu / archivage des grosses sorties d'outils**
- L'UI (rail d'activité) garde un aperçu ~1 600 car + un id ; le modèle reçoit l'aperçu ;
  « voir plus » récupère le complet à la demande.

**A3. Archive + rappel avant perte**
- Tout bloc historique > 800 car est archivé verbatim (store par conversation, ids `r<seq>`)
  avant tout résumé/troncature.
- Outils `recall(id)` / `recall_search(query)` **absents du schéma** tant qu'aucun archivage
  n'existe (≈200 tokens/turn sauvés). Marqueur « image perdue ».

**A4. Compaction automatique du contexte**
- Trigger ≥ 75 % de la fenêtre modèle : système en tête + 20 % de queue snapée sur frontière
  user/assistant ; torse → résumé (temp 0.2, thinking off si supporté, budget [700, 1600] tok)
  injecté comme message user `[CONTEXT COMPACTED]` ; **refus si < 20 % de gain** + marqueur
  anti-boucle + cooldown.
- Rescue réactif : HTTP 400 « context length » → compacte → retry → shrink des tool results.
- Event « compacte » dans le rail d'activité.

**A5. Échelle d'erreurs classée** (remplace « The current turn returned no response »)
- `no_credit` (402/403 LiteLLM/OpenRouter/DeepSeek) → « Ce modèle n'a pas de solde — choisis un
  modèle OpenCode » + action qui ouvre le sélecteur de modèle.
- `timeout`.
- `stream_cut` → reprise auto ≤5× (backoff 2/4/6 s) avec le texte déjà montré + « continue où tu
  t'es arrêté ».
- `empty_response` → 2 relances progressives (cause réelle du « ça ne répond pas »).
- Tool+args strictement dupliqué → `[déjà fait]`, 2ᵉ fois refus sec (bash/browser exclus).
- `context.Canceled` silencieux.

**A6. Toggle « Réflexion » dans le composer**
- Bouton à barres de signal (off/low ↔ haut) à côté du sélecteur de modèle ; passe
  `reasoning_effort` / `thinking` **dans le body** via forwarded props → LiteLLM.
- Capability détectée par probe, exposée dans `/api/models` (bouton masqué si non supporté).
- Préférence par Dot persistée.

---

## Phase B — Fluidité du streaming (client)

- **B1.** Re-render Markdown **adaptatif anti-O(n²)** : accumulation par concat, rendu coalescé
  `delay = clamp(dernierRendu×6, 16, 500 ms)`, flush à chaque frontière. (`ChatTranscript.tsx`)
- **B2.** Machine à écrire découplée : suiveur exponentiel rAF τ=260 ms, plancher 0,4 car/frame ;
  direct en rattrapage.
- **B3.** Fade des 16 derniers caractères via TreeWalker (pas d'animation CSS repartant à chaque repaint).
- **B4.** Auto-scroll safe : 1 write/rAF, gap min 150 ms, skip si ≤1 px, suspendu pendant le touch
  + grâce 350 ms ; `force` en fin de tour.
- **B5.** Ligne de stats par tour : chrono · tokens · **taux sur timestamps serveur (gaps >800 ms
  exclus)** · modèle — figée à `turn_done`.
- **B6. Queue/steer** (reco retenue : **file côté client**) : on envoie pendant une génération →
  bulle pending grise, promote in-place à l'écho ; la file part après `turn_done`. Boutons
  envoi/stop superposés en crossfade grid ; stop sur `pointerdown`.
  - *Reco : file client d'abord (simple, zéro risque de couplage CopilotKit). L'injection serveur
    à mi-tour est possible plus tard si le besoin d'interrompre en plein tool se confirme.*
- **B7.** Vérifier compression Hono (jamais sur SSE) + heartbeat 4 s via nginx 105.

---

## Phase C — Avatar animé + scène d'intervention

- **C1. Moteur ressorts** (réécriture `Mascot.tsx`) — physique Euler `{x,v,target,k,d}`, un seul rAF
  actif **seulement si visible**, dt clampé 50 ms, `prefers-reduced-motion` court-circuite.
  Corps (PNG entier) : flottement/respiration désynchronisés, inclinaison suivant la souris
  (distance normalisée 420 px + vélocité), hop+squash au clic, « gulp » à l'envoi (scale 0.04 vers
  l'avatar), sommeil après 90 s. **Wobble pendulaire de l'antenne** (ressort secondaire).
- **C2. Yeux repeints** — 6 variantes « visière clean » des PNG (masquage des 2 arcs ; originaux
  conservés pour listes/favicons) ; yeux SVG par-dessus : suivi du curseur borné à la visière
  (parallaxe visage < pupilles), clignements 2,2–6 s (18 % double), think (haut-droite oscillant,
  paupières 0,85), search (balayage), listen (bas), browsing (lit l'écran), loading (roue),
  talk (pulse 0,12/token, lueur de visière), happy (^ ^ 1,6 s), sleep (traits fermés).
- **C3. Champ `avatar` par Dot** — sélecteur des 6 têtes dans la dialog créer/modifier ; Dots
  existants gardent leur couleur actuelle (hash) donc LEO reste bleu.
- **C4. Emplacements** — petits (sidebar/threads) statiques ; animés : hero d'accueil, inline
  26–32 px dans l'en-tête du rail d'activité, scène.
- **C5. Scène d'intervention** — overlay plein écran piloté par nos états réels (`deriveActivity`) :
  dernier bloc assistant, avatar 150 px + 3 points en orbite CSS, capture navigateur live
  (`/dots/:id/computer`), légende = dernier event + stop inline, n'importe quelle touche ouvre le
  champ (focus synchrone dans le geste), retour par glissement FLIP ghost scène↔rail, gestion
  `visualViewport` clavier mobile.
- **C6. Web Push** — `sw.js` sans fetch handler ni cache, VAPID généré serveur, push **uniquement
  aux fins de tour user**, `tag + renotify`, interrupteur dans Réglages, indice PWA iOS.

---

## Phase D — Extras

- Tâches planifiées : tz du navigateur, `@once`, mode script pur, reprise du pause-master sans
  rafale, poll seulement si une tâche tourne, rapport → message dans le fil **et** rail d'activité.
- Mémoire : modes injectée / search / à-demande / off par Dot.
- Pré-chauffage MCP parallèle si serveurs branchés.

---

## Transverse (à chaque phase)

- LXC 102 : `typecheck`, `lint`, `build`, 308 tests, `git diff --check`.
- Captures Playwright (desktop 1440×900 + mobile 390×844, clair/sombre, console propre, 0 erreur).
- Un vrai run avec un modèle OpenCode fundé.
- Build/déploiement en `sam`, restart via root ; brain Operator à jour ; commit/push sur demande.

## Estimations

A ≈ 1 j · B ≈ ½ j · C ≈ 1 j · D ≈ ½ j.
