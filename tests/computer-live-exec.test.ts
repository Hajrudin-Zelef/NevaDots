import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService, utf8Split } from '../src/server/computer-service.js';
import type { ComputerActivityEvent } from '../src/shared/computer-types.js';

const stores: WorkspaceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/** Conteneur simulé : lancement en arrière-plan, polls, kill, lecture finale. */
function liveFixture(options?: {
  neverFinish?: boolean;
  classic?: boolean;
  zombie?: boolean;
}) {
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
  const calls: string[] = [];
  const polls = new Map<string, number>();
  const transport: typeof fetch = (async (input, init) => {
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
    if (url.endsWith('/exec')) {
      const body = JSON.parse(String((init as RequestInit)?.body ?? '{}')) as {
        command?: string;
      };
      const command = body.command ?? '';
      calls.push(command);
      const launch = /LIVE_PID_([0-9a-f]+):/.exec(command);
      if (launch && !options?.classic)
        return Response.json({ stdout: `LIVE_PID_${launch[1]}:4242\n` });
      if (command.includes('_S:') && command.includes('tail -c +')) {
        const tag = /LIVE_([0-9a-f]+)_S:/.exec(command)?.[1] ?? 'x';
        const n = (polls.get(tag) ?? 0) + 1;
        polls.set(tag, n);
        if (options?.neverFinish)
          return Response.json({
            stdout: `${b64('')}\n${b64('')}\nLIVE_${tag}_S:ALIVE\nLIVE_${tag}_C:NO\n`,
          });
        if (n < 3) {
          const delta = n === 1 ? 'hello\n' : 'world\n';
          return Response.json({
            stdout: `${b64(delta)}\n${b64('')}\nLIVE_${tag}_S:ALIVE\nLIVE_${tag}_C:NO\n`,
          });
        }
        const full = 'hello\nworld\n';
        return Response.json({
          stdout: [
            b64(''),
            b64(''),
            `LIVE_${tag}_S:${options?.zombie ? 'ALIVE' : 'GONE'}`,
            `LIVE_${tag}_C:0`,
            String(Buffer.byteLength(full)),
            '0',
            b64(full),
            b64(''),
            '',
          ].join('\n'),
        });
      }
      if (command.startsWith('kill -9')) return Response.json({ stdout: '' });
      if (command.includes('wc -c <')) {
        const full = 'partial\n';
        return Response.json({
          stdout: [
            String(Buffer.byteLength(full)),
            '0',
            b64(full),
            b64(''),
            '',
          ].join('\n'),
        });
      }
      // Repli classique : sortie complète immédiate.
      return Response.json({
        exitCode: 0,
        stdout: 'classic\n',
        stderr: '',
      });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const service = new ComputerService(
    workspace,
    {
      baseUrl: 'https://example.com',
      voiceName: 'voice',
      slackUsers: [],
      runtimeUrl: 'http://localhost',
      computerSupervisorUrl: 'http://127.0.0.1:4312',
      computerSupervisorToken: 'supervisor-secret',
      computerToken: 'master-secret',
    },
    () => false,
    transport,
    1000,
  );
  return { workspace, id, service, calls };
}

describe('exec live (défilement)', () => {
  it('diffuse des chunk puis une fin avec la queue', async () => {
    const f = liveFixture();
    const seen: ComputerActivityEvent[] = [];
    const stop = f.service.subscribeActivity(f.id, (event) => seen.push(event));
    const result = (await f.service.action(
      f.id,
      'exec',
      { command: 'sleep 2 && echo done', timeoutMs: 60000 },
      'agent',
    )) as Record<string, unknown>;
    stop();
    expect(seen[0]).toMatchObject({ phase: 'start' });
    const chunks = seen.filter((e) => e.phase === 'chunk');
    expect(chunks.map((e) => e.chunk).join('')).toBe('hello\nworld\n');
    const end = seen.find((e) => e.phase === 'end');
    expect(end).toMatchObject({ exitCode: 0 });
    expect(end?.stdout).toContain('world');
    // Sortie courte : pas de troncature (le bloc de fin a bien été lu).
    expect(end?.truncated).toBeFalsy();
    expect(result).toMatchObject({ exitCode: 0 });
    expect(String(result.stdout)).toContain('world');
    // Lancement + 3 polls (le dernier embarque queue + nettoyage).
    expect(f.calls.filter((c) => c.includes('echo LIVE_PID_'))).toHaveLength(1);
    expect(f.calls.filter((c) => c.includes('tail -c +'))).toHaveLength(3);
    expect(f.calls.some((c) => c.startsWith('kill -9'))).toBe(false);
  });

  it('termine malgré un zombie qui garde son PID vivant (kill -0)', async () => {
    // PID 1 (bun) ne reap pas : le processus devient un zombie et
    // `kill -0` réussit pour toujours. La fin se lit dans le fichier code.
    const f = liveFixture({ zombie: true });
    const seen: ComputerActivityEvent[] = [];
    const stop = f.service.subscribeActivity(f.id, (event) => seen.push(event));
    const result = (await f.service.action(
      f.id,
      'exec',
      { command: 'echo done', timeoutMs: 20000 },
      'agent',
    )) as Record<string, unknown>;
    stop();
    expect(result).toMatchObject({ exitCode: 0 });
    expect(seen.find((e) => e.phase === 'end')).toMatchObject({ exitCode: 0 });
  });

  it('rejoue les dernières commandes à un abonné qui arrive après coup', async () => {
    const f = liveFixture();
    const stop1 = f.service.subscribeActivity(f.id, () => {});
    await f.service.action(f.id, 'exec', { command: 'echo late' }, 'agent');
    stop1();
    const seen: ComputerActivityEvent[] = [];
    const stop2 = f.service.subscribeActivity(f.id, (event) =>
      seen.push(event),
    );
    stop2();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.find((e) => e.phase === 'start')?.command).toBe('echo late');
    expect(seen.find((e) => e.phase === 'end')).toBeTruthy();
  });

  it('repli classique quand le conteneur ne supporte pas l’arrière-plan', async () => {
    const f = liveFixture({ classic: true });
    const seen: ComputerActivityEvent[] = [];
    const stop = f.service.subscribeActivity(f.id, (event) => seen.push(event));
    const result = (await f.service.action(
      f.id,
      'exec',
      { command: 'echo hi' },
      'owner',
    )) as Record<string, unknown>;
    stop();
    expect(seen.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(result.stdout).toBe('classic\n');
  });

  it('dépassement de délai : tue le processus et marque timedOut', async () => {
    const f = liveFixture({ neverFinish: true });
    const seen: ComputerActivityEvent[] = [];
    const stop = f.service.subscribeActivity(f.id, (event) => seen.push(event));
    const result = (await f.service.action(
      f.id,
      'exec',
      { command: 'sleep 60', timeoutMs: 1500 },
      'agent',
    )) as Record<string, unknown>;
    stop();
    expect(result).toMatchObject({ timedOut: true });
    expect(String(result.stdout)).toContain('partial');
    expect(f.calls.some((c) => c.startsWith('kill -9 4242'))).toBe(true);
    expect(seen.find((e) => e.phase === 'end')).toMatchObject({
      timedOut: true,
    });
  });

  it('annulation : tue le processus distant et émet end en erreur', async () => {
    const f = liveFixture({ neverFinish: true });
    const seen: ComputerActivityEvent[] = [];
    const stop = f.service.subscribeActivity(f.id, (event) => seen.push(event));
    const controller = new AbortController();
    const run = f.service.action(
      f.id,
      'exec',
      { command: 'sleep 60', timeoutMs: 60000 },
      'agent',
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    await expect(run).rejects.toThrow();
    stop();
    expect(f.calls.some((c) => c.startsWith('kill -9 4242'))).toBe(true);
    const end = seen.find((e) => e.phase === 'end');
    expect(end?.error).toBeTruthy();
  });
});

describe('utf8Split', () => {
  it('retient une séquence multi-octets coupée', () => {
    // 'é' = 0xC3 0xA9 : coupé après le premier octet.
    const first = utf8Split(Buffer.from([0x68, 0xc3]));
    expect(first).toEqual({ text: 'h', held: 1 });
    const second = utf8Split(Buffer.from([0xa9]));
    // Octet de continuation isolé : indécodable seul, retenu (en pratique
    // les offsets ne coupent que des séquences complètes).
    expect(second).toEqual({ text: '', held: 1 });
    // Tampon complet : rien retenu.
    expect(utf8Split(Buffer.from('héllo', 'utf8'))).toEqual({
      text: 'héllo',
      held: 0,
    });
    // 3 octets (€ = 0xE2 0x82 0xAC), coupé après deux.
    const euro = utf8Split(Buffer.from([0xe2, 0x82]));
    expect(euro).toEqual({ text: '', held: 2 });
  });
});
