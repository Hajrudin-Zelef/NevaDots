import { beforeEach, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Children, createElement } from 'react';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import { api } from '../src/client/api';
import { VoicePanel } from '../src/client/VoicePanel';
import type { Settings } from '../src/shared/types';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const settings: Settings = {
  name: 'Dot',
  paused: false,
  researchAllowed: true,
  memoryAllowed: true,
  replyStyle: 'standard',
  replyLanguage: 'fr',
  ttsMode: 'browser',
  ttsVoice: '',
  ttsRate: 1,
  ttsPauseSentenceMs: 300,
  ttsPauseParagraphMs: 600,
  ttsProvider: null,
  ttsModel: null,
};

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({ providers: [] });
});

function renderPanel() {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(VoicePanel, { settings }));
  });
  return renderer!;
}

it('affiche les deux moteurs et les réglages navigateur', () => {
  const renderer = renderPanel();
  const radios = renderer.root.findAllByProps({ name: 'tts-mode' });
  expect(radios).toHaveLength(2);
  expect(renderer.root.findByProps({ 'aria-label': 'Vitesse' })).toBeTruthy();
  expect(
    renderer.root.findByProps({ 'aria-label': 'Pause entre phrases' }),
  ).toBeTruthy();
  expect(
    renderer.root
      .findAllByType('button')
      .some((b) =>
        Children.toArray(b.props.children).includes('Écouter un extrait'),
      ),
  ).toBe(true);
});

it('enregistre les 7 champs voix via PATCH /settings', async () => {
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === '/tts/providers') return { providers: [] };
    return { ok: true };
  });
  const renderer = renderPanel();
  await act(async () => {
    await renderer.root
      .findByProps({ children: 'Enregistrer' })
      .props.onClick();
  });
  expect(vi.mocked(api)).toHaveBeenCalledWith('/settings', 'PATCH', {
    ttsMode: 'browser',
    ttsVoice: '',
    ttsRate: 1,
    ttsPauseSentenceMs: 300,
    ttsPauseParagraphMs: 600,
    ttsProvider: null,
    ttsModel: null,
  });
});

it('propose Recharger + Toutes langues, et l’aide quand ≤ 1 voix FR', async () => {
  vi.mocked(api).mockResolvedValue({ providers: [] });
  const speech = {
    getVoices: () => [
      { name: 'Google français', lang: 'fr-FR', voiceURI: 'g' },
    ],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('window', { speechSynthesis: speech });
  const renderer = renderPanel();
  await act(async () => {});
  expect(
    renderer.root
      .findAllByType('button')
      .some((b) =>
        Children.toArray(b.props.children).includes('Recharger les voix'),
      ),
  ).toBe(true);
  const checkbox = renderer.root.findAllByProps({ type: 'checkbox' })[0];
  expect(checkbox).toBeTruthy();
  // Aide visible : une seule voix FR.
  expect(
    renderer.root
      .findAllByType('p')
      .some((p) =>
        Children.toArray(p.props.children)
          .join('')
          .includes('Pour obtenir plus de voix'),
      ),
  ).toBe(true);
  // Opt-in : les voix non-FR apparaissent après rechargement.
  speech.getVoices = () => [
    { name: 'Google français', lang: 'fr-FR', voiceURI: 'g' },
    { name: 'Zoe', lang: 'en-US', voiceURI: 'zoe' },
  ];
  act(() => {
    checkbox.props.onChange({ target: { checked: true } });
  });
  const options = renderer.root
    .findAllByType('option')
    .map((o) => Children.toArray(o.props.children).join(''));
  expect(options.some((label) => label.includes('Zoe (en-US)'))).toBe(true);
  vi.unstubAllGlobals();
});

it('signale l’absence de synthèse pour l’extrait navigateur', async () => {
  vi.mocked(api).mockResolvedValue({ providers: [] });
  const renderer = renderPanel();
  await act(async () => {
    await renderer.root
      .findByProps({ children: 'Écouter un extrait' })
      .props.onClick();
  });
  const alerts = renderer.root.findAllByProps({ role: 'alert' });
  expect(alerts.length).toBeGreaterThan(0);
});
