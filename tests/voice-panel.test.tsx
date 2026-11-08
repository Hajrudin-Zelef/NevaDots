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
