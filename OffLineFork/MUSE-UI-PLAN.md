---
description: Target design for the Muse.ia-style UI in NevaDots — the right-hand Activity panel (avatar header, segmented tabs, day-grouped cards expandable to tools) and the Browser panel (browser chrome, take control, auto-open, chat card).
read_if: Building or changing the NevaDots Activity panel or the Dot browser panel; anything aiming to match Muse.ia.
---

# Muse-like panels (Activity + Browser)

Reference: Muse.ia (screenshots shown by the user, 2026-10-12). Two goals, delivered as **Phase A**
(Activity panel) then **Phase B** (Browser panel), one commit each.

## Phase A — Activity panel (Muse style)

Target: a right-hand panel whose header is the dot avatar + name + green "Connecté", a **segmented
icon tab bar**, and a **day-grouped timeline** of cards. Each card = a **conversation** (icon, title,
one-line outcome summary, time); clicking opens the conversation; expanding reveals the **tools used**
(the existing activity-event rendering).

Data constraint: `thread_bindings` stores only `title`/`dotId`/`createdAt`; the transcript lives on
CopilotKit Intelligence. So Muse-style "title + outcome + expandable tools" needs a **small local
addition**:

- `thread_bindings` gains `updatedAt INTEGER` and `summary TEXT`.
- New table `thread_activity(threadId TEXT PRIMARY KEY, value TEXT NOT NULL)` = JSON of derived
  activity events.
- `Conversation` (shared) gains `updatedAt?`, `summary?`, returned by `/api/workspace`; new route
  `GET /api/conversations/:id/activity`.
- `deriveActivity` moves from `client/activity.ts` to a **shared** module so the server can persist it
  and the client can render it.
- Written at the end of each turn (server-side in the Dot agent) so it also covers scheduled/voice.

Tabs mapping: **Activité** (the timeline), **Sécurité** (computer permissions), **Tâches** (scheduled
tasks, Phase D), **Profil** (avatar / model / reasoning). Security/Tasks/Profile reuse existing pieces.

## Phase B — Browser panel (Muse style, L1)

The Dot's computer is a real headless Chromium (OpenBot). Today `ResultPane`'s "Computer" tab renders
`ComputerPanel` (URL form, ~3 s screenshot polling, take/return control, files, terminal). Muse shows a
browser with chrome and a "Prendre le contrôle du navigateur" button.

- Restyle that tab as **"Navigateur"**: tab label, editable URL bar, ←/⟳, "Prendre le contrôle",
  close.
- **Auto-open** the panel when the agent starts using the browser (a browser tool call).
- The inline chat card becomes **"Navigateur · Terminé · Ouvrir l'aperçu"** with a thumbnail
  (francisation of `ComputerToolCard`).
- **L1 = screenshot polling** (current). **L2** (OpenBot WebSocket `/stream`, CDP screencast, live input
  via a server-side WS proxy + canvas) is deferred until L1 proves insufficient.

## Delivery
A → typecheck/lint/build/tests + e2e → commit; then B → same → commit. Brain + `DOCUMENTATION/05-journal.md`
kept current; no merge to `main` without the user's go-ahead.
