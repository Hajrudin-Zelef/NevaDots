import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  groupBlocksForApi,
  listFrenchVoices,
  pickFrenchVoice,
  playAudioQueue,
  prepareSpeechBlocks,
  speakBrowser,
} from '../src/client/speech-engine';

const PAUSES = { sentenceMs: 300, paragraphMs: 600 };

class FakeUtterance {
  static instances: FakeUtterance[] = [];
  lang = '';
  rate = 1;
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(readonly text: string) {
    FakeUtterance.instances.push(this);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeUtterance.instances = [];
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});
afterEach(() => {
  vi.useRealTimers();
});

it('annonce les titres et sépare les paragraphes', () => {
  const blocks = prepareSpeechBlocks('# Salut\n\nÇa va ?', PAUSES);
  expect(blocks.map((b) => b.text)).toEqual(['Titre : Salut', 'Ça va ?']);
  expect(blocks[0].pauseAfterMs).toBe(600);
  expect(blocks[1].pauseAfterMs).toBe(300);
});

it('lit chaque item de liste avec une pause de phrase', () => {
  const blocks = prepareSpeechBlocks('- pommes\n- poires', PAUSES);
  expect(blocks.map((b) => b.text)).toEqual(['pommes', 'poires']);
  expect(blocks.every((b) => b.pauseAfterMs === 300)).toBe(true);
});

it('résume les tableaux et lit les lignes', () => {
  const blocks = prepareSpeechBlocks(
    '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
    PAUSES,
  );
  expect(blocks[0].text).toBe('Tableau de 2 lignes.');
  expect(blocks[1].text).toContain('Ligne 1');
  expect(blocks[1].text).toContain('A : 1');
});

it('neutralise code, liens, emojis et étend les abréviations', () => {
  const blocks = prepareSpeechBlocks(
    'Voir [le site](https://example.com/x) 😀\n\n```py\nprint(1)\n```\n\nM. Dupont, ex. concret',
    PAUSES,
  );
  const text = blocks.map((b) => b.text).join(' ');
  expect(text).not.toContain('https://');
  expect(text).not.toContain('😀');
  expect(text).toContain('le site');
  expect(text).toContain('Monsieur Dupont, exemple concret');
  expect(blocks.some((b) => b.text.startsWith('Bloc de code'))).toBe(true);
});

it('trie les voix FR : Google > Microsoft > génériques', () => {
  const voices = [
    {
      name: 'eSpeak FR',
      lang: 'fr-fr',
      voiceURI: 'espeak',
      localService: true,
    },
    {
      name: 'Microsoft Hortense',
      lang: 'fr-FR',
      voiceURI: 'hortense',
      localService: true,
    },
    {
      name: 'Google français',
      lang: 'fr-FR',
      voiceURI: 'google',
      localService: false,
    },
    { name: 'Alex', lang: 'en-US', voiceURI: 'alex', localService: true },
  ];
  expect(pickFrenchVoice(voices)).toBe('google');
  expect(pickFrenchVoice(voices, 'hortense')).toBe('hortense');
  expect(pickFrenchVoice(voices, 'inconnue')).toBe('google');
  expect(listFrenchVoices(voices).map((v) => v.uri)).toEqual([
    'google',
    'hortense',
    'espeak',
  ]);
});

it('regroupe les blocs en requêtes API bornées', () => {
  const groups = groupBlocksForApi(
    [
      { text: 'a'.repeat(2500), pauseAfterMs: 300 },
      { text: 'b'.repeat(2500), pauseAfterMs: 300 },
    ],
    3000,
  );
  expect(groups).toHaveLength(2);
  const single = groupBlocksForApi(
    [
      { text: 'bonjour', pauseAfterMs: 300 },
      { text: 'le monde', pauseAfterMs: 600 },
    ],
    3000,
  );
  expect(single).toEqual(['bonjour le monde']);
});

it('speakBrowser enchaîne les phrases avec pauses, pause/reprise/arrêt', async () => {
  const spoken: string[] = [];
  const synth = {
    speak: vi.fn((utterance: FakeUtterance) => {
      spoken.push(utterance.text);
    }),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    paused: false,
  };
  const ended = vi.fn();
  const control = speakBrowser(
    [
      { text: 'Bonjour.', pauseAfterMs: 300 },
      { text: 'Ça va ?', pauseAfterMs: 600 },
    ],
    {
      synth: synth as unknown as SpeechSynthesis,
      rate: 1.1,
      onend: ended,
    },
  );
  expect(spoken).toEqual(['Bonjour.']);
  // Fin du 1er énoncé → pause calibrée → phrase suivante.
  FakeUtterance.instances[0].onend!();
  await vi.advanceTimersByTimeAsync(300);
  expect(spoken).toEqual(['Bonjour.', 'Ça va ?']);
  // Pause manuelle puis reprise.
  control.pause();
  expect(synth.pause).toHaveBeenCalled();
  control.resume();
  // Arrêt : cancel, plus rien ne suit.
  control.stop();
  expect(synth.cancel).toHaveBeenCalled();
});

it('playAudioQueue enchaîne les blobs et gère pause/reprise/arrêt', async () => {
  const played: string[] = [];
  const audio = {
    src: '',
    playbackRate: 1,
    onended: null as (() => void) | null,
    onerror: null as (() => void) | null,
    play: vi.fn(async () => {
      played.push(audio.src);
    }),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
  };
  const ended = vi.fn();
  const control = playAudioQueue(
    [
      new Blob(['a'], { type: 'audio/mpeg' }),
      new Blob(['b'], { type: 'audio/mpeg' }),
    ],
    { audio: audio as unknown as HTMLAudioElement, onend: ended },
  );
  expect(played).toHaveLength(1);
  await audio.onended!();
  expect(played).toHaveLength(2);
  control.pause();
  expect(audio.pause).toHaveBeenCalled();
  control.resume();
  await audio.onended!();
  expect(ended).toHaveBeenCalled();
  control.stop();
});
