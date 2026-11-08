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

it('lecture vocale navigateur : lire, pause, reprise, arrêt', async () => {
  const utterances: Array<{
    text: string;
    onend: (() => void) | null;
    rate: number;
  }> = [];
  const synth = {
    speak: vi.fn(
      (u: { text: string; onend: (() => void) | null; rate: number }) => {
        utterances.push(u);
      },
    ),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    getVoices: () => [
      { name: 'Google français', lang: 'fr-FR', voiceURI: 'g' },
    ],
    paused: false,
  };
  vi.stubGlobal('window', {
    speechSynthesis: synth,
    setTimeout: (fn: (...args: unknown[]) => void, ms?: number) =>
      setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as never),
  });
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      lang = '';
      rate = 1;
      voice: unknown = null;
      onend: (() => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      constructor(public text: string) {
        utterances.push(this as never);
      }
    },
  );
  try {
    const { renderer } = renderActions({
      text: 'Bonjour. Ça va ?',
      tts: {
        mode: 'browser',
        voice: '',
        rate: 1,
        pauseSentenceMs: 300,
        pauseParagraphMs: 600,
        provider: null,
        model: null,
      },
    });
    act(() => {
      renderer.root
        .findAllByType('button')
        .find((b) => b.props['aria-label'] === 'Lire à voix haute')!
        .props.onClick();
    });
    expect(synth.speak).toHaveBeenCalledTimes(1);
    // Pause puis reprise.
    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Mettre la lecture en pause' })
        .props.onClick();
    });
    expect(synth.pause).toHaveBeenCalled();
    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Reprendre la lecture' })
        .props.onClick();
    });
    // Arrêt.
    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Arrêter la lecture' })
        .props.onClick();
    });
    expect(synth.cancel).toHaveBeenCalled();
    expect(
      renderer.root.findAllByProps({ 'aria-label': 'Lire à voix haute' }),
    ).toHaveLength(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
