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

it('pied de réponse : agent · modèle · durée · tok/s depuis /reasoning-stats', () => {
  const { renderer } = renderActions({
    agentName: 'Nev',
    stats: {
      model: 'glm-5.3',
      resolvedModel: 'glm-5.3-flash',
      durationMs: 12400,
      promptTokens: 100,
      cachedTokens: 10,
      completionTokens: 250,
      tokensPerSecond: 20.4,
      costUsd: 0.001,
    },
  });
  const meta = renderer.root.findByProps({ className: 'message-meta' });
  expect(meta.children.join('')).toBe(
    'Nev · glm-5.3-flash · 12 s · 20,4 tok/s',
  );
});

it('pied de réponse : modèle demandé quand le servi est inconnu, métriques absentes omises', () => {
  const { renderer } = renderActions({
    agentName: 'Nev',
    stats: {
      model: 'glm-5.3',
      resolvedModel: null,
      durationMs: 65000,
      promptTokens: null,
      cachedTokens: null,
      completionTokens: null,
      tokensPerSecond: null,
      costUsd: null,
    },
  });
  const meta = renderer.root.findByProps({ className: 'message-meta' });
  expect(meta.children.join('')).toBe('Nev · glm-5.3 · 1 min 5 s');
});

it('pied de réponse : sans stats, pas de pied — rien d’inventé', () => {
  const { renderer } = renderActions({ agentName: 'Nev' });
  expect(
    renderer.root.findAllByProps({ className: 'message-meta' }),
  ).toHaveLength(0);
});

it('pied de réponse : tour interrompu porte « Interrompu »', () => {
  const { renderer } = renderActions({
    agentName: 'Nev',
    interrupted: true,
    stats: {
      model: 'glm-5.3',
      resolvedModel: null,
      durationMs: 3000,
      promptTokens: 10,
      cachedTokens: 0,
      completionTokens: 40,
      tokensPerSecond: 13.3,
      costUsd: null,
    },
  });
  const meta = renderer.root.findByProps({ className: 'message-meta' });
  expect(meta.children.join('')).toBe(
    'Nev · glm-5.3 · 3 s · 13,3 tok/s · Interrompu',
  );
});

it('format de durée du pied : ms, secondes, minutes, heures', async () => {
  const { formatResponseDuration, formatTokensPerSecond } =
    await import('../src/client/response-stats');
  expect(formatResponseDuration(450)).toBe('450 ms');
  expect(formatResponseDuration(12000)).toBe('12 s');
  expect(formatResponseDuration(60000)).toBe('1 min');
  expect(formatResponseDuration(65000)).toBe('1 min 5 s');
  expect(formatResponseDuration(3720000)).toBe('1 h 2 min');
  expect(formatResponseDuration(-1)).toBe('');
  expect(formatTokensPerSecond(20.4)).toBe('20,4 tok/s');
  expect(formatTokensPerSecond(null)).toBeNull();
  expect(formatTokensPerSecond(undefined)).toBeNull();
});
