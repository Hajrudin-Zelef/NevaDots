import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import { api } from '../src/client/api';
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
  expect(labels).toContain('Je n’aime pas cette réponse');
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

it('dislike ouvre le formulaire et envoie le commentaire au serveur', async () => {
  const mockedApi = vi.mocked(api);
  mockedApi.mockResolvedValue({ ok: true });
  const { renderer } = renderActions({
    threadId: 't1',
    dotId: 'd1',
    model: 'x',
  });
  act(() => {
    renderer.root
      .findAllByType('button')
      .find((b) => b.props['aria-label'] === 'Je n’aime pas cette réponse')!
      .props.onClick();
  });
  const area = renderer.root.findByType('textarea');
  act(() => {
    area.props.onChange({ target: { value: 'Trop vague.' } });
  });
  await act(async () => {
    await renderer.root
      .findByType('form')
      .props.onSubmit({ preventDefault: () => {} });
  });
  expect(mockedApi).toHaveBeenCalledWith('/feedback', 'POST', {
    messageId: 'm1',
    vote: -1,
    comment: 'Trop vague.',
    threadId: 't1',
    dotId: 'd1',
    model: 'x',
  });
});
