import { expect, it, vi } from 'vitest';
import {
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
