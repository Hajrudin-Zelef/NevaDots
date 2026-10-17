import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
import { ThinkingOrb, orbKindForStepLabel } from '../src/client/ThinkingOrb';
import type { ThinkingKind } from '../src/client/ThinkingOrb';

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: (props: Record<string, unknown>) =>
    createElement('canvas', {
      'data-state': props.state,
      'data-size': props.size,
      'aria-label': props['aria-label'],
    }),
}));

const roots: ReturnType<typeof create>[] = [];
afterEach(() => {
  while (roots.length) roots.pop()?.unmount();
});

async function render(
  kind?: ThinkingKind,
  size?: 64 | 32 | 20,
  label?: string,
) {
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(ThinkingOrb, { kind, size, label }));
    roots.push(root!);
  });
  await act(async () => {});
  return roots[roots.length - 1].root.findByType('canvas');
}

it('mappe les kinds NevaDots sur les états orbs avec libellés FR', async () => {
  const cases: Array<[ThinkingKind | undefined, string, string]> = [
    [undefined, 'working', 'Travail en cours'],
    ['thinking', 'working', 'Réflexion en cours'],
    ['analyzing', 'solving', 'Analyse en cours'],
    ['writing', 'composing', 'Rédaction en cours'],
    ['searching', 'searching', 'Recherche en cours'],
    ['listening', 'listening', 'Écoute en cours'],
    ['connecting', 'connecting', 'Connexion en cours'],
    ['loading', 'breathing', 'Chargement en cours'],
  ];
  for (const [kind, state, label] of cases) {
    const canvas = await render(kind);
    expect(canvas.props['data-state']).toBe(state);
    expect(canvas.props['data-size']).toBe(20);
    expect(canvas.props['aria-label']).toBe(label);
  }
  const custom = await render('working', 32, 'Envoi en cours');
  expect(custom.props['data-size']).toBe(32);
  expect(custom.props['aria-label']).toBe('Envoi en cours');
});

it('orbKindForStepLabel classe les libellés FR des étapes', () => {
  expect(orbKindForStepLabel('Recherche web')).toBe('searching');
  expect(orbKindForStepLabel('Recherche dans la mémoire')).toBe('analyzing');
  expect(orbKindForStepLabel("Création d'une page")).toBe('writing');
  expect(orbKindForStepLabel('Ordinateur : exec')).toBe('writing');
  expect(orbKindForStepLabel("Lecture d'une page")).toBe('working');
  expect(orbKindForStepLabel('Truc inconnu')).toBe('thinking');
});
