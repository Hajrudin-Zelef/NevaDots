import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

{
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  });
}

const api = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('../src/client/api', () => ({
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  api,
  authHeaders: () => ({}),
  authToken: () => '',
  setToken: () => {},
}));

import { useAttachments } from '../src/client/useAttachments';

type UseAttachments = ReturnType<typeof useAttachments>;

let latest: UseAttachments | null = null;

function Probe({ scope }: { scope: string }) {
  const attachments = useAttachments(scope);
  latest = attachments;
  return null;
}

const roots: ReturnType<typeof create>[] = [];
afterEach(() => {
  while (roots.length) roots.pop()?.unmount();
  vi.clearAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  latest = null;
  api.mockResolvedValue({});
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('crypto', crypto);
  (localStorage as Storage).clear();
});

async function mountScope(scope: string) {
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(createElement(Probe, { scope }));
    roots.push(root!);
  });
  await act(async () => {});
  return latest!;
}

const textFile = () =>
  new File(['contenu'], 'note.txt', { type: 'text/plain' });

it('timeout upload : erreur FR, brouillon conservé, rien vidé', async () => {
  vi.useFakeTimers();
  // Upload qui ne finit jamais.
  fetchMock.mockImplementation(() => new Promise(() => {}));
  const attachments = await mountScope('home:dot-timeout');
  await act(async () => {
    attachments.addFiles([textFile()]);
  });
  await act(async () => {});
  expect(latest!.items).toHaveLength(1);
  let error: unknown = null;
  const sending = latest!.prepareSend('brouillon').catch((e) => {
    error = e;
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(61_000);
  });
  await act(async () => {
    await sending;
  });
  expect(String((error as Error)?.message)).toContain(
    'Téléversement toujours en cours',
  );
  // Rien vidé : l'item est toujours là, le brouillon survit.
  expect(latest!.items).toHaveLength(1);
});

it('mark-attached en échec : erreur, brouillon conservé', async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      attachments: [
        {
          id: 'srv-1',
          name: 'note.txt',
          size: 8,
          mime: 'text/plain',
          category: 'text',
        },
      ],
    }),
  });
  api.mockImplementation(async (path: string) => {
    if (path === '/attachments/mark-attached') throw new Error('réseau coupé');
    return {};
  });
  const attachments = await mountScope('home:dot-mark');
  await act(async () => {
    attachments.addFiles([textFile()]);
  });
  await act(async () => {});
  expect(latest!.items[0]?.status).toBe('ready');
  await act(async () => {
    await expect(latest!.prepareSend('brouillon')).rejects.toThrow(
      'rattacher les fichiers',
    );
  });
  // Brouillon conservé : item toujours présent.
  expect(latest!.items).toHaveLength(1);
  expect(latest!.items[0]?.status).toBe('ready');
});

it('succès : texte construit, mark-attached confirmé, brouillon vidé', async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      attachments: [
        {
          id: 'srv-2',
          name: 'note.txt',
          size: 8,
          mime: 'text/plain',
          category: 'text',
        },
      ],
    }),
  });
  const attachments = await mountScope('home:dot-ok');
  await act(async () => {
    attachments.addFiles([textFile()]);
  });
  await act(async () => {});
  let text = '';
  await act(async () => {
    text = await latest!.prepareSend('résume-moi ça');
  });
  expect(text).toContain('résume-moi ça');
  expect(text).toContain('note.txt');
  expect(api).toHaveBeenCalledWith('/attachments/mark-attached', 'POST', {
    ids: ['srv-2'],
  });
  expect(latest!.items).toHaveLength(0);
});
