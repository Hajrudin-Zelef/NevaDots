import { expect, it, vi } from 'vitest';
import {
  createQueuedMessage,
  dequeueQueued,
  enqueueQueued,
  enqueueQueuedFront,
  removeQueued,
  routeComposerKeyDown,
  shouldSubmitComposerOnKeyDown,
  submitComposerOnEnter,
} from '../src/client/chat-composer';

// Entrée seule = saut de ligne (jamais d'envoi) ; Ctrl/⌘+Entrée = envoi.
function keyEvent({
  key = 'Enter',
  shiftKey = false,
  ctrlKey = false,
  metaKey = false,
  isComposing = false,
  keyCode,
}: {
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
} = {}) {
  return {
    key,
    shiftKey,
    ctrlKey,
    metaKey,
    nativeEvent: {
      isComposing,
      keyCode,
    },
  };
}

it('Entrée seule insère un saut de ligne, sans envoi', () => {
  expect(shouldSubmitComposerOnKeyDown(keyEvent())).toBe(false);
});

it('Maj+Entrée insère aussi un saut de ligne', () => {
  expect(shouldSubmitComposerOnKeyDown(keyEvent({ shiftKey: true }))).toBe(
    false,
  );
  expect(
    shouldSubmitComposerOnKeyDown(keyEvent({ shiftKey: true, ctrlKey: true })),
  ).toBe(false);
});

it('Ctrl+Entrée et ⌘+Entrée envoient', () => {
  expect(shouldSubmitComposerOnKeyDown(keyEvent({ ctrlKey: true }))).toBe(true);
  expect(shouldSubmitComposerOnKeyDown(keyEvent({ metaKey: true }))).toBe(true);
});

it('pas d’envoi pendant la composition IME', () => {
  expect(
    shouldSubmitComposerOnKeyDown(
      keyEvent({ ctrlKey: true, isComposing: true }),
    ),
  ).toBe(false);
});

it('pas d’envoi sur les événements IME legacy (keyCode 229)', () => {
  expect(
    shouldSubmitComposerOnKeyDown(keyEvent({ ctrlKey: true, keyCode: 229 })),
  ).toBe(false);
});

function enterEvent(init: Parameters<typeof keyEvent>[0] = {}) {
  const requestSubmit = vi.fn();
  const preventDefault = vi.fn();
  return {
    requestSubmit,
    preventDefault,
    event: {
      ...keyEvent(init),
      preventDefault,
      currentTarget: { form: { requestSubmit } },
    },
  };
}

it('soumet le formulaire sur Ctrl+Entrée (composer d’accueil)', () => {
  const { event, requestSubmit, preventDefault } = enterEvent({
    ctrlKey: true,
  });
  submitComposerOnEnter(event, true);
  expect(preventDefault).toHaveBeenCalled();
  expect(requestSubmit).toHaveBeenCalledTimes(1);
});

it('n’envoie pas sur Entrée seule (le textarea gère le saut de ligne)', () => {
  const { event, requestSubmit, preventDefault } = enterEvent();
  submitComposerOnEnter(event, true);
  expect(preventDefault).not.toHaveBeenCalled();
  expect(requestSubmit).not.toHaveBeenCalled();
});

it('n’envoie pas si le composer est vide ou occupé', () => {
  const { event, requestSubmit, preventDefault } = enterEvent({
    ctrlKey: true,
  });
  submitComposerOnEnter(event, false);
  expect(preventDefault).toHaveBeenCalled();
  expect(requestSubmit).not.toHaveBeenCalled();
});

// --- Routeur de raccourcis (Lot 5, étape 4) : la règle d'envoi reste
// verrouillée (Ctrl+Entrée envoie, Entrée seule = saut de ligne). ---
function routeEvent(init: {
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
} = {}) {
  return {
    key: init.key ?? 'Enter',
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    nativeEvent: {
      isComposing: init.isComposing ?? false,
      keyCode: init.keyCode,
    },
  };
}

it('routeur : Ctrl+Entrée → submit, Entrée seule → null', () => {
  expect(routeComposerKeyDown(routeEvent({ ctrlKey: true }))).toBe('submit');
  expect(routeComposerKeyDown(routeEvent({ metaKey: true }))).toBe('submit');
  expect(routeComposerKeyDown(routeEvent())).toBeNull();
  expect(routeComposerKeyDown(routeEvent({ shiftKey: true }))).toBeNull();
});

it('routeur : Alt+Entrée → queue-front (tête de file)', () => {
  expect(routeComposerKeyDown(routeEvent({ altKey: true }))).toBe(
    'queue-front',
  );
});

it('routeur : Mod+U → open-attachments, Mod+\' → toggle-source', () => {
  expect(routeComposerKeyDown(routeEvent({ key: 'u', ctrlKey: true }))).toBe(
    'open-attachments',
  );
  expect(routeComposerKeyDown(routeEvent({ key: 'U', metaKey: true }))).toBe(
    'open-attachments',
  );
  expect(routeComposerKeyDown(routeEvent({ key: "'", ctrlKey: true }))).toBe(
    'toggle-source',
  );
});

it('routeur : Mod+. → cycle-dot, Maj+Mod+. → cycle-dot-reverse', () => {
  expect(routeComposerKeyDown(routeEvent({ key: '.', ctrlKey: true }))).toBe(
    'cycle-dot',
  );
  expect(
    routeComposerKeyDown(
      routeEvent({ key: '.', metaKey: true, shiftKey: true }),
    ),
  ).toBe('cycle-dot-reverse');
});

it('routeur : Ctrl+G → toggle-menu, Échap → cancel', () => {
  expect(routeComposerKeyDown(routeEvent({ key: 'g', ctrlKey: true }))).toBe(
    'toggle-menu',
  );
  expect(routeComposerKeyDown(routeEvent({ key: 'Escape' }))).toBe('cancel');
  // ⌘+G n'est pas le raccourci menu (Ctrl+G littéral, cf. brief).
  expect(routeComposerKeyDown(routeEvent({ key: 'g', metaKey: true }))).toBe(
    null,
  );
});

it('routeur : rien pendant la composition IME', () => {
  expect(
    routeComposerKeyDown(routeEvent({ ctrlKey: true, isComposing: true })),
  ).toBeNull();
  expect(
    routeComposerKeyDown(routeEvent({ ctrlKey: true, keyCode: 229 })),
  ).toBeNull();
});

// --- File en objets (Lot 5, étape 3) ---
it('file : enqueue / dequeue / remove, ids stables et uniques', () => {
  const first = createQueuedMessage('a');
  const second = createQueuedMessage('b');
  expect(first.id).not.toBe(second.id);
  expect(first.text).toBe('a');
  let queue = enqueueQueued([], 'a');
  queue = enqueueQueued(queue, 'b');
  expect(queue.map((item) => item.text)).toEqual(['a', 'b']);
  queue = enqueueQueuedFront(queue, 'tête');
  expect(queue.map((item) => item.text)).toEqual(['tête', 'a', 'b']);
  const { next, rest } = dequeueQueued(queue);
  expect(next?.text).toBe('tête');
  expect(rest.map((item) => item.text)).toEqual(['a', 'b']);
  expect(removeQueued(rest, rest[0].id).map((item) => item.text)).toEqual([
    'b',
  ]);
  expect(dequeueQueued([]).next).toBeUndefined();
});

it('file : le snapshot (historique, pièces jointes, citation) voyage avec l’élément', () => {
  const meta = {
    historyPrompt: 'ma question\n\nmon commentaire',
    attachments: ['doc.pdf'],
    quote: { text: 'texte cité', comment: 'mon commentaire' },
  };
  const queue = enqueueQueued([], 'texte préparé [Citation : texte cité]', meta);
  expect(queue[0].historyPrompt).toBe('ma question\n\nmon commentaire');
  expect(queue[0].attachments).toEqual(['doc.pdf']);
  expect(queue[0].quote).toEqual({ text: 'texte cité', comment: 'mon commentaire' });
  const { next } = dequeueQueued(queue);
  expect(next?.historyPrompt).toBe(meta.historyPrompt);
  expect(next?.quote).toEqual(meta.quote);
  // Sans meta : comportement historique, champs absents.
  expect(createQueuedMessage('a').historyPrompt).toBeUndefined();
  expect(createQueuedMessage('a').quote).toBeUndefined();
});
