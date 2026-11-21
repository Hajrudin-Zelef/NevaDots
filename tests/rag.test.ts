import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRagCache, searchRag } from '../src/server/rag';

const config = { ragUrl: 'http://rag.test:4500' };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('rag client (fail-open)', () => {
  beforeEach(() => clearRagCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('ne fait aucun appel sans URL de service', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await searchRag('question', { ragUrl: '' });
    expect(result.covered).toBe(false);
    expect(result.hits).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mappe un résultat couvert et borne les extraits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          corpusVersion: 'v2026-11-18',
          covered: true,
          hits: [
            { title: 'Kimi K3', path: 'a/b.md', snippet: 'Un modèle.' },
            { title: 'Autre', path: 'c/d.md', snippet: 'Suite.' },
            { title: 'Ignoré', path: 'e/f.md', snippet: 'Quatrième.' },
            { title: 'Ignoré 2', path: 'g/h.md', snippet: 'Cinquième.' },
          ],
        }),
      ),
    );
    const result = await searchRag('Kimi K3', config);
    expect(result.covered).toBe(true);
    expect(result.corpusVersion).toBe('v2026-11-18');
    expect(result.hits).toHaveLength(3);
    expect(result.hits[0]).toEqual({
      title: 'Kimi K3',
      path: 'a/b.md',
      snippet: 'Un modèle.',
      dates: '',
    });
  });

  it('renvoie non couvert quand le service le dit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ corpusVersion: 'v1', covered: false, hits: [] }),
      ),
    );
    const result = await searchRag('hors sujet', config);
    expect(result.covered).toBe(false);
    expect(result.hits).toEqual([]);
  });

  it('échoue en silence sur une réponse non 2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ detail: 'nope' }, 500)),
    );
    const result = await searchRag('question', config);
    expect(result.covered).toBe(false);
    expect(result.hits).toEqual([]);
  });

  it('échoue en silence sur une erreur réseau', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const result = await searchRag('question', config);
    expect(result.covered).toBe(false);
  });

  it('échoue en silence sur un timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    const pending = searchRag('lent', { ...config, ragTimeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(300);
    const result = await pending;
    expect(result.covered).toBe(false);
  });

  it('présente la clé client en Bearer', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ corpusVersion: 'v1', covered: false, hits: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await searchRag('question', { ...config, ragKey: 'ws_secret' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer ws_secret',
    );
  });

  it('met en cache court une même question', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ corpusVersion: 'v1', covered: false, hits: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await searchRag('Question identique', config);
    await searchRag('  question identique ', config);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('ignore un signal déjà annulé', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    const result = await searchRag('question', config, controller.signal);
    expect(result.covered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('rag logs (aucune erreur silencieuse)', () => {
  beforeEach(() => clearRagCache());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('journalise un HTTP non 2xx', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ detail: 'nope' }, 500)),
    );
    await searchRag('question', config);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'));
  });

  it('journalise une erreur réseau', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    await searchRag('question', config);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('erreur réseau'));
  });

  it('journalise un timeout', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    const pending = searchRag('lent', { ...config, ragTimeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('timeout après 300 ms'),
    );
  });

  it('journalise une réponse inattendue', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ covered: 'oui', hits: [] })),
    );
    await searchRag('question', config);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('réponse inattendue'),
    );
  });

  it('journalise un succès couvert', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          corpusVersion: 'v1',
          covered: true,
          hits: [{ title: 'T', path: 'p', snippet: 'S' }],
        }),
      ),
    );
    await searchRag('question', config);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('couvert: 1 extrait'),
    );
  });
});
