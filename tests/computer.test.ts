import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import { computerInputs } from '../src/shared/computer-types.js';
import { computerTools } from '../src/server/computer-tools.js';
// No real DNS in tests: public example hosts pass, private IPs fail.
vi.mock('../src/server/net-security.js', () => ({
  validateUrl: async (input: string) => {
    const url = new URL(input);
    if (/169\.254|127\.|^(10|192\.168)\.|localhost/i.test(url.hostname))
      throw new Error('Private or special network addresses are blocked.');
    return { url, address: '93.184.216.34', family: 4 };
  },
}));
const stores: WorkspaceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture(deadline = 1000) {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const id = workspace.dots()[0].id;
  const calls: { url: string; init?: RequestInit }[] = [];
  let paused = false;
  let endpoint: string | undefined;
  let actionHandler: (
    url: string,
    init?: RequestInit,
  ) => Promise<Response> = async () => Response.json({ text: 'result' });
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/computers'))
      return Response.json({
        computers: workspace.dots().map((dot) => ({
          botId: dot.id,
          container: `opendots-computer-${dot.id}`,
          status: 'running',
          ...(endpoint ? { url: endpoint } : {}),
        })),
      });
    if (url.endsWith('/ensure'))
      return Response.json({
        botId: id,
        container: `opendots-computer-${id}`,
        status: 'running',
        url: `http://opendots-computer-${id}:4100`,
      });
    if (url.endsWith('/stop'))
      return Response.json({
        botId: id,
        container: `opendots-computer-${id}`,
        status: 'stopped',
      });
    if (url.endsWith('/control'))
      return Response.json({
        holder: 'human',
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
        request: { id: 'request', status: 'taken' },
      });
    return actionHandler(url, init);
  };
  const config = {
    baseUrl: 'https://example.com',
    voiceName: 'voice',
    slackUsers: [],
    runtimeUrl: 'http://localhost',
    computerSupervisorUrl: 'http://127.0.0.1:4312',
    computerSupervisorToken: 'supervisor-secret',
    computerToken: 'master-secret',
  };
  const service = new ComputerService(
    workspace,
    config,
    () => paused,
    transport,
    deadline,
  );
  workspace.computers.patch(id, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });
  return {
    workspace,
    id,
    service,
    calls,
    config,
    transport,
    setPaused: (value: boolean) => {
      paused = value;
    },
    setEndpoint: (value: string) => {
      endpoint = value;
    },
    handle: (fn: typeof actionHandler) => {
      actionHandler = fn;
    },
  };
}
it('defaults every permission off and persists policy and metadata-only audit across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'computers-'));
  const path = join(dir, 'db');
  let workspace = new WorkspaceStore(path, 'owner');
  const id = workspace.dots()[0].id;
  expect(workspace.computers.permissions(id)).toEqual({
    enabled: false,
    browser: false,
    files: false,
    shell: false,
  });
  workspace.computers.patch(id, { enabled: true, files: true });
  const audit = workspace.computers.begin(id, 'files_write', 'agent');
  workspace.computers.finish(audit, 'succeeded');
  workspace.close();
  workspace = new WorkspaceStore(path, 'owner');
  expect(workspace.computers.permissions(id).files).toBe(true);
  expect(workspace.computers.audit(id)[0]).toMatchObject({
    action: 'files_write',
    outcome: 'succeeded',
  });
  workspace.close();
  rmSync(dir, { recursive: true });
});
it('status never provisions and actions use per-Dot derived credentials with audit before dispatch', async () => {
  const f = fixture();
  f.config.computerToken = '  master-secret  ';
  await f.service.status(f.id);
  expect(f.calls.every((call) => !call.url.endsWith('/ensure'))).toBe(true);
  f.handle(async () => {
    expect(f.workspace.computers.audit(f.id)[0].outcome).toBe('pending');
    return Response.json({ text: f.config.computerToken.trim() });
  });
  expect(
    await f.service.action(f.id, 'files_read', { path: 'note.txt' }, 'agent'),
  ).toEqual({ text: '[redacted]', sha: expect.any(String) });
  const request = f.calls.find((call) => call.url.endsWith('/files/read'))!;
  expect(new Headers(request.init?.headers).get('authorization')).toBe(
    `Bearer ${createHmac('sha256', 'master-secret').update(`opendots-computer:${f.id}`).digest('hex')}`,
  );
  expect(new Headers(request.init?.headers).get('x-openbot-bot-id')).toBe(f.id);
  expect(request.init?.redirect).toBe('error');
  f.handle(async () => Response.json({ text: 'result' }));
  const other = f.workspace.createDot(
    f.workspace.spaces()[0].id,
    'Other',
    '',
    true,
    true,
  );
  f.workspace.computers.patch(other.id, { enabled: true, files: true });
  await f.service.action(other.id, 'files_read', { path: 'note.txt' });
  const last = f.calls.at(-1)!;
  expect(new Headers(last.init?.headers).get('authorization')).not.toBe(
    new Headers(request.init?.headers).get('authorization'),
  );
  expect(last.url).toContain(other.id);
});
it('rejects foreign targets, nonexistent Dots, traversal, unexpected inputs and agent human controls', async () => {
  const f = fixture();
  f.setEndpoint('http://attacker.test:4100');
  await expect(f.service.action(f.id, 'read', {})).rejects.toThrow('endpoint');
  expect(f.calls).toHaveLength(1);
  await expect(f.service.action('missing', 'read', {})).rejects.toThrow(
    'Dot not found',
  );
  for (const path of [
    '../secret',
    'a/../../secret',
    '/etc/passwd',
    'a\\secret',
    'a\0b',
  ])
    expect(computerInputs.files_read.safeParse({ path }).success).toBe(false);
  expect(
    computerInputs.exec.safeParse({ command: 'pwd', timeoutMs: 600001 })
      .success,
  ).toBe(false);
  expect(
    computerInputs.read.safeParse({ url: 'http://elsewhere' }).success,
  ).toBe(false);
  await expect(
    f.service.action(f.id, 'human_type', { text: 'secret' }, 'agent'),
  ).rejects.toThrow('owner-only');
});
it('checks current permissions and global pause and records failure without sensitive inputs', async () => {
  const f = fixture();
  f.workspace.computers.patch(f.id, { shell: false });
  await expect(
    f.service.action(f.id, 'exec', { command: 'sensitive command' }, 'agent'),
  ).rejects.toThrow('permission');
  f.setPaused(true);
  await expect(f.service.action(f.id, 'read', {}, 'agent')).rejects.toThrow(
    'paused',
  );
  expect(f.calls).toHaveLength(0);
  expect(JSON.stringify(f.workspace.computers.audit(f.id))).not.toContain(
    'sensitive',
  );
  expect(
    f.workspace.computers.audit(f.id).every((a) => a.outcome === 'failed'),
  ).toBe(true);
});
it('cancels in-flight actions on revocation and bounds upstream deadlines', async () => {
  const f = fixture(200);
  f.handle(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        );
      }),
  );
  const run = f.service.action(f.id, 'exec', { command: 'wait' }, 'agent');
  setTimeout(() => f.workspace.computers.patch(f.id, { shell: false }), 20);
  await expect(run).rejects.toThrow('cancelled or timed out');
  // A browser action that hits our deadline is a wedged computer: the watchdog
  // resets it once and retries, then rethrows the timeout when it still fails.
  await expect(f.service.action(f.id, 'read', {})).rejects.toThrow(/timed out/);
  expect(
    f.workspace.computers.audit(f.id).every((a) => a.outcome === 'failed'),
  ).toBe(true);
});
it('preserves recovery handback after permissions are revoked; upstream failures are sanitized', async () => {
  const f = fixture();
  f.workspace.computers.patch(f.id, { enabled: false, browser: false });
  await f.service.control(f.id, 'release');
  expect(f.calls.some((call) => call.url.endsWith('/control/release'))).toBe(
    true,
  );
  f.workspace.computers.patch(f.id, { enabled: true, browser: true });
  f.handle(async () =>
    Response.json({ error: 'secret upstream detail' }, { status: 500 }),
  );
  await expect(f.service.action(f.id, 'read', {})).rejects.toThrow('HTTP 500');
  f.handle(async () => new Response('x'.repeat(4_000_001)));
  await expect(f.service.action(f.id, 'read', {})).rejects.toThrow(
    'size limit',
  );
});
it('binds tools to the current Dot without exposing human or policy controls', async () => {
  const f = fixture();
  const check = vi.fn();
  const tools = computerTools(
    f.service,
    f.id,
    check,
    new AbortController().signal,
  );
  expect(
    tools.some(
      (t) => t.name.includes('human') || t.name.includes('permission'),
    ),
  ).toBe(false);
  const read = tools.find((t) => t.name === 'computer_files_read')!;
  await read.execute?.({ path: 'notes.txt' });
  expect(check).toHaveBeenCalled();
  expect(f.calls.at(-1)?.url).toContain(f.id);
});
it('bounds completed audit storage while preserving pending work', () => {
  const f = fixture();
  const pending = f.workspace.computers.begin(f.id, 'exec', 'agent');
  for (let i = 0; i < 1010; i++)
    f.workspace.computers.finish(
      f.workspace.computers.begin(f.id, 'read', 'owner'),
      'succeeded',
    );
  f.workspace.computers.finish(pending, 'failed');
  expect(f.workspace.computers.audit(f.id)).toHaveLength(50);
});

it('accepts an uppercase namespace while preserving exact container identity', async () => {
  const f = fixture();
  const config = { ...f.config, computerNamespace: 'MyDots' };
  const transport: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/computers'))
      return Response.json({
        computers: [
          {
            botId: f.id,
            container: `MyDots-computer-${f.id}`,
            status: 'running',
            url: `http://MyDots-computer-${f.id}:4100`,
          },
        ],
      });
    return f.transport(input, init);
  };
  const service = new ComputerService(
    f.workspace,
    config,
    () => false,
    transport,
  );
  await expect(service.action(f.id, 'read', {})).resolves.toEqual({
    text: 'result',
  });
  expect(f.calls.at(-1)?.url).toBe(`http://mydots-computer-${f.id}:4100/read`);
});

it('blocks navigation to private hosts before proxying (SSRF)', async () => {
  const f = fixture();
  await expect(
    f.service.action(
      f.id,
      'navigate',
      { url: 'http://169.254.169.254/latest/meta-data/' },
      'agent',
    ),
  ).rejects.toThrow('blocked');
  // The container was never contacted.
  expect(f.calls).toHaveLength(0);
});

it('gives agents a safe recovery instruction for stale browser or control conflicts', async () => {
  const f = fixture();
  f.handle(async () =>
    Response.json({ error: f.config.computerToken }, { status: 409 }),
  );
  await expect(
    f.service.action(f.id, 'navigate', { url: 'https://example.com' }, 'agent'),
  ).rejects.toThrow('computer_snapshot');
  await expect(
    f.service.action(f.id, 'navigate', { url: 'https://example.com' }, 'agent'),
  ).rejects.not.toThrow(f.config.computerToken);
  expect(f.workspace.computers.audit(f.id)[0].outcome).toBe('failed');
});

it('recovers from a snapshot-required conflict by snapshotting and retrying', async () => {
  const f = fixture();
  let navigations = 0;
  f.handle(async (url) => {
    if (url.endsWith('/snapshot'))
      return Response.json({ snapshotId: 1, elements: [] });
    if (url.endsWith('/navigate')) {
      navigations += 1;
      if (navigations === 1)
        return Response.json(
          {
            error: 'Take a new snapshot.',
            stale: true,
            snapshotRequired: true,
          },
          { status: 409 },
        );
      return Response.json({ url: 'https://example.com/', title: 'Example' });
    }
    return Response.json({ text: 'result' });
  });
  await expect(
    f.service.action(f.id, 'navigate', { url: 'https://example.com' }, 'agent'),
  ).resolves.toEqual({ url: 'https://example.com/', title: 'Example' });
  expect(navigations).toBe(2);
  expect(f.calls.some((call) => call.url.endsWith('/snapshot'))).toBe(true);
});

it('tells the agent to wait when the owner holds control', async () => {
  const f = fixture();
  f.handle(async () =>
    Response.json(
      { error: 'Human has control.', humanHasControl: true },
      { status: 409 },
    ),
  );
  await expect(
    f.service.action(f.id, 'navigate', { url: 'https://example.com' }, 'agent'),
  ).rejects.toThrow(/owner currently has control/i);
});

it('recovers a wedged browser by resetting the computer and retrying once', async () => {
  const f = fixture(200);
  let screenshots = 0;
  f.handle(async (url, init) => {
    if (url.endsWith('/screenshot')) {
      screenshots += 1;
      // First call hangs past the deadline (a stuck Chromium relaunch); the
      // abort rejects it so the service sees a timeout.
      if (screenshots === 1)
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      return Response.json({ base64: 'ok' });
    }
    return Response.json({ text: 'result' });
  });
  await expect(
    f.service.action(f.id, 'screenshot', {}, 'agent'),
  ).resolves.toEqual({ base64: 'ok' });
  expect(screenshots).toBe(2);
  expect(f.calls.some((call) => call.url.endsWith('/stop'))).toBe(true);
  expect(f.calls.some((call) => call.url.endsWith('/ensure'))).toBe(true);
  expect(f.workspace.computers.audit(f.id)[0].outcome).toBe('succeeded');
});
it('lets exec outlive the short wedge-recovery deadline (P1)', async () => {
  expect(
    computerInputs.exec.safeParse({ command: 'make', timeoutMs: 600000 })
      .success,
  ).toBe(true);
  expect(
    computerInputs.exec.safeParse({ command: 'make', timeoutMs: 600001 })
      .success,
  ).toBe(false);
  const f = fixture(1000);
  // Superviseur rapide, ordinateur lent (1,5 s) : l'exec a son propre délai
  // long (600 s) alors que les fichiers gardent le plafond court (1 s ici).
  // Le transport respecte le signal, comme un vrai fetch avorté.
  f.handle(
    async (url, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(
            Response.json({
              exitCode: 0,
              stdout: 'done',
              stderr: '',
              truncated: false,
              timedOut: false,
              elapsedMs: 1500,
            }),
          );
        }, 1500);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted by test'));
          },
          { once: true },
        );
      }),
  );
  await expect(
    f.service.action(f.id, 'exec', { command: 'sleep 1.5' }, 'owner'),
  ).resolves.toMatchObject({ exitCode: 0, stdout: 'done' });
  await expect(
    f.service.action(f.id, 'files_list', { path: '' }, 'owner'),
  ).rejects.toThrow(/timed out/);
});
it('lit par plage et cherche côté serveur sans rien transmettre au conteneur (P3)', async () => {
  const f = fixture();
  const big = Array.from({ length: 20 }, (_, i) => `ligne ${i + 1}`).join('\n');
  f.handle(async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    if (String(url).endsWith('/files/list'))
      return Response.json({
        path: '',
        entries: [
          { path: 'a.txt', kind: 'file', bytes: 100 },
          { path: 'sub', kind: 'folder' },
          { path: 'sub/b.txt', kind: 'file', bytes: 50 },
        ],
        truncated: false,
      });
    if (String(url).endsWith('/files/read')) {
      if (body.path === 'a.txt')
        return Response.json({
          path: 'a.txt',
          text: big,
          truncated: false,
          bytes: big.length,
        });
      if (body.path === 'sub/b.txt')
        return Response.json({
          path: 'sub/b.txt',
          text: 'bonjour\nau revoir',
          truncated: false,
          bytes: 17,
        });
      return new Response('nope', { status: 404 });
    }
    throw new Error(`unexpected ${url}`);
  });
  // Plage de lignes (offset 1-based).
  await expect(
    f.service.action(
      f.id,
      'files_read',
      { path: 'a.txt', offset: 5, limit: 3 },
      'owner',
    ),
  ).resolves.toMatchObject({
    path: 'a.txt',
    text: 'ligne 5\nligne 6\nligne 7',
    from: 5,
    to: 7,
    totalLines: 20,
    truncated: true, // une plage n'est jamais le fichier entier
  });
  // Sans plage : fichier entier (comportement historique inchangé).
  await expect(
    f.service.action(f.id, 'files_read', { path: 'a.txt' }, 'owner'),
  ).resolves.toMatchObject({ path: 'a.txt', text: big });
  // Recherche bornée, dossiers ignorés.
  await expect(
    f.service.action(
      f.id,
      'files_search',
      { query: 'ligne (1|2)$', maxResults: 5 },
      'owner',
    ),
  ).resolves.toMatchObject({
    path: '',
    query: 'ligne (1|2)$',
    matches: [
      { path: 'a.txt', line: 1, text: 'ligne 1' },
      { path: 'a.txt', line: 2, text: 'ligne 2' },
    ],
    truncated: false,
  });
  // Regex invalide → erreur claire, pas de crash.
  await expect(
    f.service.action(f.id, 'files_search', { query: '([' }, 'owner'),
  ).rejects.toThrow('Regex');
  // Le conteneur ne reçoit que {path} : ni offset/limit ni query.
  const readBodies = f.calls
    .filter((c) => c.url.endsWith('/files/read'))
    .map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
  expect(readBodies.length).toBeGreaterThan(0);
  for (const body of readBodies) expect(Object.keys(body)).toEqual(['path']);
});
it('n’expose files_search que si la permission fichiers est active (mitigation)', () => {
  const f = fixture();
  const check = vi.fn();
  const signal = new AbortController().signal;
  const off = computerTools(f.service, f.id, check, signal, {
    enabled: true,
    browser: true,
    files: false,
    shell: true,
  });
  expect(off.some((t) => t.name === 'computer_files_search')).toBe(false);
  // Existants inchangés, avec ou sans permissions.
  expect(off.some((t) => t.name === 'computer_files_read')).toBe(true);
  const on = computerTools(f.service, f.id, check, signal, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });
  expect(on.some((t) => t.name === 'computer_files_search')).toBe(true);
  const legacy = computerTools(f.service, f.id, check, signal);
  expect(legacy.some((t) => t.name === 'computer_files_search')).toBe(true);
});
it('édite par remplacements uniques, fail-closed sinon (P2)', async () => {
  const f = fixture();
  let content = 'alpha\nbeta\ngamma\nbeta\n';
  let writes = 0;
  f.handle(async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    if (String(url).endsWith('/files/read'))
      return Response.json({
        path: body.path,
        text: content,
        truncated: false,
        bytes: content.length,
      });
    if (String(url).endsWith('/files/write')) {
      writes++;
      content = String(body.contents);
      return Response.json({ path: body.path, bytes: content.length });
    }
    throw new Error(`unexpected ${url}`);
  });
  // Match unique → appliqué.
  await expect(
    f.service.action(
      f.id,
      'files_edit',
      { path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] },
      'owner',
    ),
  ).resolves.toMatchObject({ path: 'a.txt', applied: 1 });
  expect(content.startsWith('ALPHA\n')).toBe(true);
  // Ambigu sans replaceAll → refusé, rien écrit.
  await expect(
    f.service.action(
      f.id,
      'files_edit',
      { path: 'a.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] },
      'owner',
    ),
  ).rejects.toThrow('occurrences');
  expect(content).not.toContain('BETA');
  // replaceAll explicite → toutes les occurrences.
  await expect(
    f.service.action(
      f.id,
      'files_edit',
      {
        path: 'a.txt',
        edits: [{ oldText: 'beta', newText: 'BETA', replaceAll: true }],
      },
      'owner',
    ),
  ).resolves.toMatchObject({ applied: 2 });
  expect(content).toBe('ALPHA\nBETA\ngamma\nBETA\n');
  // oldText absent → refusé, rien écrit.
  const before = content;
  await expect(
    f.service.action(
      f.id,
      'files_edit',
      { path: 'a.txt', edits: [{ oldText: 'zzz', newText: 'Z' }] },
      'owner',
    ),
  ).rejects.toThrow('introuvable');
  expect(content).toBe(before);
  // Le conteneur n'a vu que des read {path} et des write {path, contents}.
  const writeBodies = f.calls
    .filter((c) => c.url.endsWith('/files/write'))
    .map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
  expect(writes).toBe(2);
  for (const body of writeBodies)
    expect(Object.keys(body).sort()).toEqual(['contents', 'path']);
});
it('refuse d’éditer un fichier tronqué au read', async () => {
  const f = fixture();
  f.handle(async (url) => {
    if (String(url).endsWith('/files/read'))
      return Response.json({
        path: 'big.txt',
        text: 'début…',
        truncated: true,
        bytes: 64000,
      });
    throw new Error(`unexpected ${url}`);
  });
  await expect(
    f.service.action(
      f.id,
      'files_edit',
      { path: 'big.txt', edits: [{ oldText: 'début', newText: 'fin' }] },
      'owner',
    ),
  ).rejects.toThrow('tronqué');
});
it('git construit des commandes canoniques échappées, jamais de shell libre (P5)', async () => {
  const f = fixture();
  const execBodies: Array<Record<string, unknown>> = [];
  f.handle(async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    if (String(url).endsWith('/exec')) {
      execBodies.push(body);
      return Response.json({
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        truncated: false,
        timedOut: false,
        elapsedMs: 5,
      });
    }
    throw new Error(`unexpected ${url}`);
  });
  await expect(
    f.service.action(f.id, 'git', { op: 'status', path: 'proj' }, 'agent'),
  ).resolves.toMatchObject({ exitCode: 0 });
  expect(execBodies.at(-1)).toEqual({
    command: `git -C 'proj' status --porcelain=v1 -b`,
    timeoutMs: 300000,
  });
  // Message avec apostrophe échappé : pas d'injection, pas de split.
  await f.service.action(
    f.id,
    'git',
    { op: 'commit', message: `c'est "ok"; rm -rf /` },
    'agent',
  );
  expect(execBodies.at(-1)?.command).toBe(
    `git -C '.' add -A && git -C '.' commit -m 'c'\\''est "ok"; rm -rf /'`,
  );
  // Refs et URL validées par le schéma : rien ne part vers le conteneur.
  const before = execBodies.length;
  await expect(
    f.service.action(f.id, 'git', { op: 'checkout', ref: 'a; rm' }, 'agent'),
  ).rejects.toThrow();
  await expect(
    f.service.action(
      f.id,
      'git',
      { op: 'clone', url: 'http://evil/x.git' },
      'agent',
    ),
  ).rejects.toThrow();
  await expect(
    f.service.action(
      f.id,
      'git',
      { op: 'clone', url: 'https://user:pw@h/x.git' },
      'agent',
    ),
  ).rejects.toThrow();
  await expect(
    f.service.action(f.id, 'git', { op: 'commit' }, 'agent'),
  ).rejects.toThrow('message');
  expect(execBodies.length).toBe(before);
  // push/pull/fetch n'existent pas au contrat.
  expect(computerInputs.git.safeParse({ op: 'push' }).success).toBe(false);
  // Le conteneur n'a vu que des /exec canoniques.
  const nonExec = f.calls.filter(
    (c) => !c.url.endsWith('/exec') && !c.url.includes('/computers'),
  );
  expect(nonExec).toEqual([]);
});
it('n’expose computer_git que si la permission shell est active', () => {
  const f = fixture();
  const check = vi.fn();
  const signal = new AbortController().signal;
  const off = computerTools(f.service, f.id, check, signal, {
    enabled: true,
    browser: true,
    files: true,
    shell: false,
  });
  expect(off.some((t) => t.name === 'computer_git')).toBe(false);
  expect(off.some((t) => t.name === 'computer_exec')).toBe(true);
  const on = computerTools(f.service, f.id, check, signal, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });
  expect(on.some((t) => t.name === 'computer_git')).toBe(true);
});
it('clone : hôte privé refusé, shallow + neutralisation + cap taille', async () => {
  const f = fixture();
  await expect(
    f.service.action(
      f.id,
      'git',
      { op: 'clone', url: 'https://169.254.169.254/r.git', path: 'x' },
      'owner',
    ),
  ).rejects.toThrow('bloqué');
  // Le conteneur n'a jamais été contacté (seul le superviseur l'a été).
  expect(f.calls.filter((c) => c.url.endsWith('/exec'))).toHaveLength(0);
  // Clone nominal : --depth 1, neutralisation .git/config, du sous le cap.
  const commands: string[] = [];
  f.handle(async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    if (String(url).endsWith('/exec')) {
      commands.push(String((body as { command?: unknown }).command ?? ''));
      if (commands.length === 1)
        return Response.json({ exitCode: 0, stdout: '', stderr: '' });
      if (commands.length === 2)
        return Response.json({ exitCode: 0, stdout: '', stderr: '' });
      return Response.json({ exitCode: 0, stdout: '100\tnvclone\n' });
    }
    return Response.json({ text: 'result' });
  });
  await f.service.action(
    f.id,
    'git',
    { op: 'clone', url: 'https://example.com/r.git', path: 'nvclone' },
    'owner',
  );
  expect(commands[0]).toContain('--depth 1 --single-branch');
  expect(commands[0]).toContain('https://example.com/r.git');
  expect(commands[1]).toContain('core.pager');
  expect(commands[1]).toContain('core.hooksPath');
  expect(commands[2]).toContain('du -sb');
  // Dépassement : rm + erreur, pas de résultat.
  commands.length = 0;
  f.handle(async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    if (String(url).endsWith('/exec')) {
      commands.push(String((body as { command?: unknown }).command ?? ''));
      if (commands.length <= 2)
        return Response.json({ exitCode: 0, stdout: '', stderr: '' });
      return Response.json({ exitCode: 0, stdout: '999999999\tnvclone\n' });
    }
    return Response.json({ text: 'result' });
  });
  await expect(
    f.service.action(
      f.id,
      'git',
      { op: 'clone', url: 'https://example.com/big.git', path: 'nvclone' },
      'owner',
    ),
  ).rejects.toThrow('trop volumineux');
  expect(commands[3]).toContain('rm -rf');
});
it('search RE2 : motif malveillant rapide, syntaxe non supportée refusée', async () => {
  const f = fixture();
  const evil = `start\n${'a'.repeat(5000)}\nfin\n`;
  f.handle(async (url) => {
    if (String(url).endsWith('/files/list'))
      return Response.json({
        path: '',
        entries: [{ path: 'a.txt', kind: 'file' }],
        truncated: false,
      });
    return Response.json({ path: 'a.txt', text: evil, truncated: false });
  });
  const found = (await f.service.action(
    f.id,
    'files_search',
    { query: '(a+)+$', maxResults: 5 },
    'owner',
  )) as { matches: unknown[]; skipped: number };
  expect(found.matches).toHaveLength(1);
  expect(found.skipped).toBe(0);
  await expect(
    f.service.action(f.id, 'files_search', { query: '(a)\\1' }, 'owner'),
  ).rejects.toThrow('RE2');
});
it('read renvoie sha, edit refuse sur sha périmé (TOCTOU)', async () => {
  const f = fixture();
  let content = 'alpha\n';
  const writes: string[] = [];
  f.handle(async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    if (String(url).endsWith('/files/read'))
      return Response.json({ path: 'a.txt', text: content, truncated: false });
    if (String(url).endsWith('/files/write')) {
      writes.push(String(body.contents ?? ''));
      return Response.json({ path: 'a.txt', bytes: 1 });
    }
    return Response.json({ text: 'result' });
  });
  const read = (await f.service.action(
    f.id,
    'files_read',
    { path: 'a.txt' },
    'owner',
  )) as { sha: string; text: string };
  expect(read.sha).toMatch(/^[0-9a-f]{64}$/);
  // Fichier changé entre-temps (autre acteur) : refusé, rien écrit.
  content = 'alpha\nbeta\n';
  await expect(
    f.service.action(
      f.id,
      'files_edit',
      {
        path: 'a.txt',
        edits: [{ oldText: 'alpha', newText: 'ALPHA' }],
        expectedSha: read.sha,
      },
      'owner',
    ),
  ).rejects.toThrow('modifié');
  expect(writes).toHaveLength(0);
  // Sha frais : appliqué.
  const fresh = (await f.service.action(
    f.id,
    'files_read',
    { path: 'a.txt' },
    'owner',
  )) as { sha: string };
  await expect(
    f.service.action(
      f.id,
      'files_edit',
      {
        path: 'a.txt',
        edits: [{ oldText: 'alpha', newText: 'ALPHA' }],
        expectedSha: fresh.sha,
      },
      'owner',
    ),
  ).resolves.toMatchObject({ applied: 1 });
  expect(writes).toHaveLength(1);
});
it('exec borne stdout/stderr à 8000 car (constante unique)', async () => {
  const f = fixture();
  f.handle(async (url) => {
    if (String(url).endsWith('/exec'))
      return Response.json({
        exitCode: 0,
        stdout: 'x'.repeat(20000),
        stderr: 'e'.repeat(9000),
        truncated: false,
        timedOut: false,
        elapsedMs: 1,
      });
    return Response.json({ text: 'result' });
  });
  const out = (await f.service.action(
    f.id,
    'exec',
    { command: 'yes' },
    'owner',
  )) as { stdout: string; stderr: string; truncated: boolean };
  expect(out.stdout.length).toBeLessThanOrEqual(8000 + '…[tronqué]'.length);
  expect(out.stdout).toContain('[tronqué]');
  expect(out.stderr).toContain('[tronqué]');
  expect(out.truncated).toBe(true);
  expect(out).not.toHaveProperty('command');
});
it('search compte les fichiers illisibles dans skipped', async () => {
  const f = fixture();
  // ko.txt échoue : on le simule en refusant la 2e lecture via compteur.
  let reads = 0;
  f.handle(async (url) => {
    if (String(url).endsWith('/files/list'))
      return Response.json({
        path: '',
        entries: [
          { path: 'ok.txt', kind: 'file' },
          { path: 'ko.txt', kind: 'file' },
        ],
        truncated: false,
      });
    if (String(url).endsWith('/files/read')) {
      reads += 1;
      if (reads === 2) return Response.json({ error: 'gone' }, { status: 500 });
      return Response.json({
        path: 'ok.txt',
        text: 'hello\n',
        truncated: false,
      });
    }
    return Response.json({ text: 'result' });
  });
  const res = (await f.service.action(
    f.id,
    'files_search',
    { query: 'hello', maxResults: 5 },
    'owner',
  )) as { matches: unknown[]; skipped: number; truncated: boolean };
  expect(res.matches).toHaveLength(1);
  expect(res.skipped).toBe(1);
});
