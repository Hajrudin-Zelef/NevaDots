import { afterEach, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import { computerRoutes } from '../src/server/computer-routes.js';
import { mountScoped } from './scoped-mount.js';
import type { ComputerActivityEvent } from '../src/shared/computer-types.js';
import {
  appendActivityRun,
  parseActivityChunk,
} from '../src/client/computer-activity';

const stores: WorkspaceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const LONG = 'x'.repeat(20000);

function fixture() {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  workspace.ensureSeed();
  stores.push(workspace);
  const id = workspace.dots()[0].id;
  workspace.computers.patch(id, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });
  const shellResult = {
    command: 'echo hi',
    exitCode: 0,
    stdout: `hi\n${LONG}`,
    stderr: '',
    truncated: false,
    timedOut: false,
    elapsedMs: 12,
  };
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/computers'))
      return Response.json({
        computers: [
          {
            botId: id,
            container: `opendots-computer-${id}`,
            status: 'running',
            url: `http://opendots-computer-${id}:4100`,
          },
        ],
      });
    if (url.endsWith('/control'))
      return Response.json({
        holder: 'bot',
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
      });
    if (url.endsWith('/exec')) return Response.json(shellResult);
    if (url.endsWith('/files/list'))
      return Response.json({ path: '', entries: [], truncated: false });
    throw new Error(`unexpected ${url}`);
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
    () => false,
    transport,
    1000,
  );
  return { workspace, id, service, shellResult };
}

it('émet start puis end borné pour un exec agent', async () => {
  const f = fixture();
  const seen: ComputerActivityEvent[] = [];
  const stop = f.service.subscribeActivity(f.id, (event) => seen.push(event));
  await f.service.action(f.id, 'exec', { command: 'echo hi' }, 'agent');
  stop();
  expect(seen).toHaveLength(2);
  expect(seen[0]).toMatchObject({
    dotId: f.id,
    action: 'exec',
    actor: 'agent',
    phase: 'start',
    command: 'echo hi',
  });
  expect(seen[1]).toMatchObject({
    phase: 'end',
    exitCode: 0,
    elapsedMs: 12,
  });
  expect(seen[1].stdout).toContain('hi');
  expect(seen[1].stdout!.length).toBeLessThan(LONG.length);
  expect(seen[1].stdout).toContain('[tronqué]');
  // Un autre Dot ne reçoit rien.
  const other: ComputerActivityEvent[] = [];
  const stopOther = f.service.subscribeActivity('nope', (event) =>
    other.push(event),
  );
  await f.service.action(f.id, 'exec', { command: 'echo hi' }, 'owner');
  stopOther();
  expect(other).toHaveLength(0);
});

it('n’émet rien pour les actions non-exec et isole les abonnés', async () => {
  const f = fixture();
  const seen: ComputerActivityEvent[] = [];
  f.service.subscribeActivity(f.id, () => {
    throw new Error('abonné cassé');
  });
  const stop = f.service.subscribeActivity(f.id, (event) => seen.push(event));
  // L'abonné cassé ne fait pas échouer l'action.
  await f.service.action(f.id, 'files_list', { path: '' }, 'owner');
  stop();
  expect(seen).toHaveLength(0);
});

it('émet end avec erreur quand la commande est refusée', async () => {
  const f = fixture();
  // Refus de permission : start émis, puis end avec error.
  f.workspace.computers.patch(f.id, { shell: false });
  const denied: ComputerActivityEvent[] = [];
  const stopDenied = f.service.subscribeActivity(f.id, (event) =>
    denied.push(event),
  );
  await expect(
    f.service.action(f.id, 'exec', { command: 'boom' }, 'owner'),
  ).rejects.toThrow('permission');
  stopDenied();
  expect(denied.map((event) => event.phase)).toEqual(['start', 'end']);
  expect(denied[1].error).toContain('permission');
});

it('le helper fusionne start/end et borne le journal', () => {
  const start: ComputerActivityEvent = {
    dotId: 'd',
    action: 'exec',
    actor: 'agent',
    phase: 'start',
    at: 1,
    command: 'sleep 30',
  };
  let runs = appendActivityRun([], start);
  expect(runs).toHaveLength(1);
  expect(runs[0].running).toBe(true);
  const end: ComputerActivityEvent = {
    ...start,
    phase: 'end',
    at: 2,
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
  };
  runs = appendActivityRun(runs, end);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ running: false, stdout: 'ok' });
  // Fin sans début (client connecté en cours de route) : run fermé.
  const orphan = appendActivityRun([], { ...end, command: 'ls' });
  expect(orphan).toHaveLength(1);
  expect(orphan[0].running).toBe(false);
  // Lignes NDJSON : ignore le vide, le padding SSE et le JSON invalide.
  const parsed = parseActivityChunk(
    '',
    `: padding\n\n${JSON.stringify(start)}\n{incomplet`,
  );
  expect(parsed.events).toHaveLength(1);
  expect(parsed.events[0].command).toBe('sleep 30');
  expect(parsed.carry).toBe('{incomplet');
});

it('la route /activity diffuse les événements en NDJSON', async () => {
  const f = fixture();
  const routes = mountScoped(computerRoutes(), {
    userId: 'owner',
    workspace: f.workspace,
    computers: f.service.forUser('owner', () => false),
  });
  const response = await routes.request(`/dots/${f.id}/computer/activity`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain(
    'application/x-ndjson',
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: ComputerActivityEvent[] = [];
  const pump = (async () => {
    let carry = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const parsed = parseActivityChunk(carry, decoder.decode(value));
      carry = parsed.carry;
      events.push(...parsed.events);
      if (events.length >= 2) return;
    }
  })();
  // Le padding arrive avant la souscription : attendre le 1er chunk,
  // puis lancer la commande (sinon `start` peut être émis trop tôt).
  await new Promise((resolve) => setTimeout(resolve, 50));
  const run = f.service.action(f.id, 'exec', { command: 'echo hi' }, 'agent');
  await run;
  await pump;
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ phase: 'start', command: 'echo hi' });
  expect(events[1]).toMatchObject({ phase: 'end', exitCode: 0 });
  await reader.cancel();
});
