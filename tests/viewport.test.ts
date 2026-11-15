import { expect, it, vi } from 'vitest';
import {
  MOBILE_VIEWPORT_QUERY,
  isMobileViewport,
  panelsMayAutoOpen,
} from '../src/client/viewport';

function stubMatchMedia(matches: boolean) {
  const seen: string[] = [];
  vi.stubGlobal('window', {
    matchMedia: (query: string) => {
      seen.push(query);
      return {
        matches,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
    },
  });
  return seen;
}

it('utilise le palier mobile de l’interface (767 px)', () => {
  expect(MOBILE_VIEWPORT_QUERY).toBe('(max-width: 767px)');
});

it('reconnaît un téléphone et refuse l’ouverture automatique des panneaux', () => {
  const seen = stubMatchMedia(true);
  try {
    expect(isMobileViewport()).toBe(true);
    expect(panelsMayAutoOpen()).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((query) => query === MOBILE_VIEWPORT_QUERY)).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('laisse l’ouverture automatique sur tablette et bureau', () => {
  stubMatchMedia(false);
  try {
    expect(isMobileViewport()).toBe(false);
    expect(panelsMayAutoOpen()).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('sans `window` (rendu serveur, tests) : comportement bureau', () => {
  // Aucun effet ne tourne côté serveur : répondre « bureau » évite de
  // dépendre d'un DOM absent sans changer le rendu.
  expect(isMobileViewport()).toBe(false);
  expect(panelsMayAutoOpen()).toBe(true);
});
