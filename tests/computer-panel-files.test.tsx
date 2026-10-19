import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({
  api,
  authHeaders: () => ({}),
  hasToken: () => false,
}));
import { ComputerPanel } from '../src/client/ComputerPanel';
import type { Dot } from '../src/shared/types';
import {
  fileBasename,
  formatFileSize,
  isFileDir,
  parentDir,
  sortFileEntries,
  summarizeFiles,
} from '../src/client/computer-files';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
vi.stubGlobal('document', { hidden: false });
vi.stubGlobal('location', { protocol: 'http:', host: 'test.invalid' });
vi.stubGlobal(
  'WebSocket',
  class {
    static OPEN = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: unknown) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close() {}
    send() {}
  },
);
const confirm = vi.hoisted(() => vi.fn(() => true));
vi.stubGlobal('window', { confirm });

const STATUS = {
  configured: true,
  state: 'running',
  permissions: { enabled: true, browser: false, files: true, shell: false },
  audit: [],
};

const ROOT_LIST = {
  path: '',
  entries: [
    { path: 'notes.txt', kind: 'file', bytes: 1115 },
    { path: 'docs', kind: 'folder' },
    { path: 'a.txt', kind: 'file', bytes: 7 },
  ],
  truncated: false,
};

const calls: Array<{ action: string; input: Record<string, unknown> }> = [];

beforeEach(() => {
  calls.length = 0;
  confirm.mockReset();
  confirm.mockReturnValue(true);
  api.mockReset();
  api.mockImplementation(
    async (url: string, method = 'GET', body?: unknown) => {
      if (url.endsWith('/computer') && method === 'GET') return STATUS;
      if (url.endsWith('/actions') && body && typeof body === 'object') {
        const { action, input } = body as {
          action: string;
          input: Record<string, unknown>;
        };
        calls.push({ action, input });
        if (action === 'files_list')
          return input.path === 'docs'
            ? {
                path: 'docs',
                entries: [{ path: 'docs/inner.txt', kind: 'file', bytes: 5 }],
                truncated: true,
              }
            : ROOT_LIST;
        if (action === 'files_read')
          return { path: input.path, text: 'bonjour' };
        if (action === 'files_write') return { path: input.path };
      }
      return {};
    },
  );
});

const roots: ReactTestRenderer[] = [];
afterEach(() => {
  while (roots.length) roots.pop()?.unmount();
  vi.unstubAllGlobals();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', { hidden: false });
  vi.stubGlobal('location', { protocol: 'http:', host: 'test.invalid' });
  vi.stubGlobal('window', { confirm });
});

function textOf(node: { children?: unknown }): string {
  const c = node.children;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => typeof x === 'string').join('');
  return '';
}

async function mountAndOpenFiles() {
  const dot = { id: 'd1', name: 'Test' } as unknown as Dot;
  await act(async () => {
    roots.push(create(createElement(ComputerPanel, { dot })));
  });
  await act(async () => {});
  const root = roots[roots.length - 1].root;
  const filesTab = root
    .findAllByType('button')
    .find((b) => textOf(b) === 'Fichiers');
  expect(filesTab).toBeTruthy();
  await act(async () => {
    filesTab!.props.onClick();
  });
  return root;
}

async function clickButton(root: never, label: string) {
  const btn = (
    root as unknown as {
      findAllByType(
        t: string,
      ): Array<{ props: { onClick?: () => void }; children?: unknown }>;
    }
  )
    .findAllByType('button')
    .find((b) => textOf(b as never) === label);
  expect(btn).toBeTruthy();
  await act(async () => {
    btn!.props.onClick?.();
  });
  await act(async () => {});
  await act(async () => {});
}

it('trie dossiers-d’abord, basename et tailles FR', () => {
  expect(sortFileEntries(ROOT_LIST.entries).map((e) => e.path)).toEqual([
    'docs',
    'a.txt',
    'notes.txt',
  ]);
  expect(fileBasename('docs/inner.txt')).toBe('inner.txt');
  expect(fileBasename('notes.txt')).toBe('notes.txt');
  expect(formatFileSize(7)).toBe('7 o');
  expect(formatFileSize(1115)).toBe('1,1 Ko');
  expect(formatFileSize(undefined)).toBe('—');
  expect(parentDir('a/b')).toBe('a');
  expect(parentDir('a')).toBe('');
  expect(parentDir('')).toBe('');
  // Le conteneur renvoie kind:'folder' (l'UI historique disait 'dir').
  expect(summarizeFiles(ROOT_LIST.entries).files).toBe(2);
  expect(summarizeFiles(ROOT_LIST.entries).bytes).toBe(1115 + 7);
  expect(summarizeFiles(ROOT_LIST.entries).sized).toBe(true);
  expect(isFileDir({ kind: 'folder' })).toBe(true);
  expect(isFileDir({ kind: 'dir' })).toBe(true);
  expect(isFileDir({ kind: 'file' })).toBe(false);
});

it('liste cliquable sans JSON brut, clic dossier et fichier', async () => {
  const root = await mountAndOpenFiles();
  await clickButton(root as never, 'Lister');
  const r = root as unknown as {
    findAllByType(
      t: string,
    ): Array<{ props: Record<string, unknown>; children?: unknown }>;
    findAllByProps(
      p: Record<string, unknown>,
    ): Array<{ props: Record<string, unknown> }>;
  };
  // Dossier d'abord, pas de JSON brut dans la Sortie.
  const fileButtons = r
    .findAllByType('button')
    .map((b) => b.props.title)
    .filter((t) => typeof t === 'string');
  expect(fileButtons).toContain('docs');
  expect(fileButtons.indexOf('docs')).toBeLessThan(
    fileButtons.indexOf('a.txt'),
  );
  expect(fileButtons.indexOf('a.txt')).toBeLessThan(
    fileButtons.indexOf('notes.txt'),
  );
  expect(r.findAllByType('pre').length).toBe(0);
  // Usage disque affiché (somme client-side des tailles listées).
  const usage = r.findAllByProps({ className: 'computer-files-usage' });
  expect(usage).toHaveLength(1);
  // Clic dossier → descend avec le bon path + bandeau troncature.
  const docsBtn = r.findAllByProps({ title: 'docs' })[0];
  await act(async () => {
    (docsBtn.props.onClick as () => void)();
  });
  await act(async () => {});
  await act(async () => {});
  expect(calls.map((c) => JSON.stringify([c.action, c.input]))).toContain(
    JSON.stringify(['files_list', { path: 'docs' }]),
  );
  // Clic fichier → ouvre le modal lecture seule (plus de remplissage
  // du textarea d'édition).
  await act(async () => {
    r.findAllByProps({ title: 'docs' });
  });
  const innerBtn = r.findAllByProps({ title: 'docs/inner.txt' })[0];
  await act(async () => {
    (innerBtn.props.onClick as () => void)();
  });
  await act(async () => {});
  await act(async () => {});
  expect(calls).toContainEqual({
    action: 'files_read',
    input: { path: 'docs/inner.txt' },
  });
  const dialog = r.findAllByProps({ role: 'dialog' })[0];
  expect(dialog.props['aria-label']).toContain('docs/inner.txt');
  const modalText = (
    dialog as unknown as {
      findAllByType(t: string): Array<{ props: Record<string, unknown> }>;
    }
  )
    .findAllByType('textarea')
    .map((t) => t.props.value);
  expect(modalText).toContain('bonjour');
  const pathInput = r.findAllByProps({ placeholder: 'notes.txt' })[0];
  expect(pathInput.props.value).toBe('docs/inner.txt');
});

it('append → append:true, écrasement confirmé puis rafraîchi', async () => {
  const root = await mountAndOpenFiles();
  await clickButton(root as never, 'Lister');
  const r = root as unknown as {
    findAllByType(
      t: string,
    ): Array<{ props: Record<string, unknown>; children?: unknown }>;
    findAllByProps(
      p: Record<string, unknown>,
    ): Array<{ props: Record<string, unknown> }>;
  };
  // Coche « Ajouter à la fin ».
  const box = r.findAllByType('input').find((i) => i.props.type === 'checkbox');
  await act(async () => {
    (box!.props.onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
  });
  // Remplit chemin + contenu via les contrôles.
  const pathInput = r.findAllByProps({ placeholder: 'notes.txt' })[0];
  await act(async () => {
    (pathInput.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'notes.txt' },
    });
  });
  const area = r.findAllByProps({ 'aria-label': 'Contenu à enregistrer' })[0];
  await act(async () => {
    (area.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'hello' },
    });
  });
  const before = calls.filter((c) => c.action === 'files_list').length;
  await clickButton(root as never, 'Ajouter à la fin');
  expect(calls).toContainEqual({
    action: 'files_write',
    input: { path: 'notes.txt', contents: 'hello', append: true },
  });
  // Liste rafraîchie après écriture + accusé visible.
  expect(calls.filter((c) => c.action === 'files_list').length).toBeGreaterThan(
    before,
  );
  expect(confirm).not.toHaveBeenCalled();
  // Mode remplacer sur un fichier listé → confirmation exigée.
  await act(async () => {
    (box!.props.onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: false },
    });
  });
  confirm.mockReturnValueOnce(false);
  const writes = calls.filter((c) => c.action === 'files_write').length;
  await clickButton(root as never, 'Enregistrer (remplacer)');
  expect(confirm).toHaveBeenCalledWith('Écraser « notes.txt » ?');
  expect(calls.filter((c) => c.action === 'files_write').length).toBe(writes);
});

it('le journal terminal affiche la commande live puis sa sortie', async () => {
  const encoder = new TextEncoder();
  const start = {
    dotId: 'd1',
    action: 'exec',
    actor: 'agent',
    phase: 'start',
    at: 1,
    command: 'echo hi',
  };
  const end = {
    ...start,
    phase: 'end',
    at: 2,
    exitCode: 0,
    stdout: 'hi\n',
    stderr: '',
    truncated: false,
    timedOut: false,
    elapsedMs: 120,
  };
  // Flux laissé ouvert : pas de close → pas de reconnexion pendant le test.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify(start)}\n`));
      controller.enqueue(encoder.encode(`${JSON.stringify(end)}\n`));
    },
  });
  const fetchMock = vi.fn(
    async () =>
      new Response(stream, {
        headers: { 'content-type': 'application/x-ndjson' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const dot = { id: 'd1', name: 'Test' } as unknown as Dot;
  await act(async () => {
    roots.push(create(createElement(ComputerPanel, { dot })));
  });
  await act(async () => {});
  const root = roots[roots.length - 1].root;
  const termTab = root
    .findAllByType('button')
    .find((b) => textOf(b) === 'Terminal');
  expect(termTab).toBeTruthy();
  await act(async () => {
    termTab!.props.onClick();
  });
  await act(async () => {});
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/dots/d1/computer/activity'),
    expect.anything(),
  );
  const codes = root
    .findAllByType('code')
    .map((c) => (Array.isArray(c.children) ? c.children.join('') : ''));
  expect(codes).toContain('$ echo hi');
  const badge = root.findAllByProps({
    className: 'computer-terminal-actor agent',
  });
  expect(badge).toHaveLength(1);
  const meta = root.findAllByProps({ className: 'computer-terminal-meta' });
  expect(
    (Array.isArray(meta[0].children) ? meta[0].children.join('') : '').replace(
      /\s+/g,
      ' ',
    ),
  ).toContain('Sortie 0');
  const pres = root
    .findAllByType('pre')
    .map((p) => (Array.isArray(p.children) ? p.children.join('') : ''));
  expect(pres).toContain('hi\n');
});
