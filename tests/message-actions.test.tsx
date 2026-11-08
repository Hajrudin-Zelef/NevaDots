import { beforeEach, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
import { MessageActions } from '../src/client/MessageActions';

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* DOM indisponible */
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

function renderActions(
  overrides?: Partial<Parameters<typeof MessageActions>[0]>,
) {
  let renderer: ReturnType<typeof create>;
  const props = {
    messageId: 'm1',
    text: 'Réponse **test**',
    isLast: true,
    running: false,
    onRetry: vi.fn(),
    ...overrides,
  };
  act(() => {
    renderer = create(createElement(MessageActions, props));
  });
  return { renderer: renderer!, props };
}

it('affiche copier, régénérer (dernière), avis et lecture', () => {
  const { renderer } = renderActions();
  const labels = renderer.root
    .findAllByType('button')
    .map((b) => b.props['aria-label']);
  expect(labels).toContain('Copier la réponse');
  expect(labels).toContain('Régénérer la réponse');
  expect(labels).toContain('Bonne réponse');
  expect(labels).toContain('Mauvaise réponse');
  expect(labels).toContain('Lire à voix haute');
});

it('masque régénérer sur les anciennes réponses', () => {
  const { renderer } = renderActions({ isLast: false });
  const labels = renderer.root
    .findAllByType('button')
    .map((b) => b.props['aria-label']);
  expect(labels).not.toContain('Régénérer la réponse');
  expect(labels).toContain('Copier la réponse');
});

it('désactive régénérer pendant un run', () => {
  const { renderer } = renderActions({ running: true });
  const retry = renderer.root
    .findAllByType('button')
    .find((b) => b.props['aria-label'] === 'Régénérer la réponse');
  expect(retry?.props.disabled).toBe(true);
});

it('appelle onRetry au clic régénérer', () => {
  const onRetry = vi.fn();
  const { renderer } = renderActions({ onRetry });
  act(() => {
    renderer.root
      .findAllByType('button')
      .find((b) => b.props['aria-label'] === 'Régénérer la réponse')!
      .props.onClick();
  });
  expect(onRetry).toHaveBeenCalledTimes(1);
});
