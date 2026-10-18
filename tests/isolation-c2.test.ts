import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { SqliteAgentRunner } from '../src/server/sqlite-runner.js';
import { ɵGLOBAL_STORE } from '@copilotkit/runtime/v2';

const dbPaths: string[] = [];
afterEach(() => {
  for (const path of dbPaths.splice(0)) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* déjà supprimé */
    }
  }
  vi.useRealTimers();
});
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nevadots-c2-'));
  const path = join(dir, 'test.sqlite');
  dbPaths.push(path);
  return path;
}
function dbOf(store: object) {
  return (store as { db: DatabaseSync }).db;
}

describe('C2 — messages des conversations (runner)', () => {
  it('migre une base legacy (sans user_id) sans perdre les lignes', () => {
    const path = tempDb();
    const setup = new DatabaseSync(path);
    setup.exec(
      'CREATE TABLE runner_threads (thread_id TEXT PRIMARY KEY, messages TEXT NOT NULL, created_at INTEGER NOT NULL);' +
        'CREATE TABLE runner_runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, agent_id TEXT, parent_run_id TEXT, events TEXT NOT NULL, created_at INTEGER NOT NULL);' +
        "INSERT INTO runner_threads VALUES ('t1', '[]', 1);",
    );
    setup.close();
    const runner = new SqliteAgentRunner(path);
    const row = dbOf(runner)
      .prepare(
        'SELECT thread_id, user_id FROM runner_threads WHERE thread_id=?',
      )
      .get('t1') as { thread_id: string; user_id: string | null };
    expect(row.thread_id).toBe('t1');
    expect(row.user_id).toBeNull();
    runner.close();
  });

  it('claimOrphans attribue les threads/runs legacy au premier compte', () => {
    const path = tempDb();
    const setup = new DatabaseSync(path);
    setup.exec(
      'CREATE TABLE runner_threads (thread_id TEXT PRIMARY KEY, messages TEXT NOT NULL, created_at INTEGER NOT NULL);' +
        'CREATE TABLE runner_runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, agent_id TEXT, parent_run_id TEXT, events TEXT NOT NULL, created_at INTEGER NOT NULL);' +
        "INSERT INTO runner_threads VALUES ('t1', '[]', 1);" +
        "INSERT INTO runner_runs (thread_id, run_id, agent_id, parent_run_id, events, created_at) VALUES ('t1', 'r1', NULL, NULL, '[]', 1);",
    );
    setup.close();
    const runner = new SqliteAgentRunner(path);
    runner.claimOrphans('user-1');
    const threads = dbOf(runner)
      .prepare('SELECT user_id FROM runner_threads')
      .all() as Array<{ user_id: string }>;
    const runs = dbOf(runner)
      .prepare('SELECT user_id FROM runner_runs')
      .all() as Array<{ user_id: string }>;
    expect(threads).toEqual([{ user_id: 'user-1' }]);
    expect(runs).toEqual([{ user_id: 'user-1' }]);
    runner.close();
  });

  it('persist écrit le propriétaire de la fiche (thread_bindings)', () => {
    const path = tempDb();
    const workspace = new WorkspaceStore(path, 'user-1');
    workspace.ensureSeed();
    const dot = workspace.dots()[0];
    workspace.bindThread('thread-a', dot.id, 'Conversation A');
    const runner = new SqliteAgentRunner(path);
    const globalStore = ɵGLOBAL_STORE as unknown as {
      getOrCreate: (threadId: string) => unknown;
    };
    globalStore.getOrCreate('thread-a');
    // persist est privé : on l'appelle via un cast (test du chemin réel).
    (runner as unknown as { persist: (threadId: string) => void }).persist(
      'thread-a',
    );
    const row = dbOf(runner)
      .prepare('SELECT user_id FROM runner_threads WHERE thread_id=?')
      .get('thread-a') as { user_id: string | null };
    expect(row.user_id).toBe('user-1');
    // Thread sans fiche → orphelin (NULL), réclamé au boot.
    globalStore.getOrCreate('thread-sans-fiche');
    (runner as unknown as { persist: (threadId: string) => void }).persist(
      'thread-sans-fiche',
    );
    const orphan = dbOf(runner)
      .prepare('SELECT user_id FROM runner_threads WHERE thread_id=?')
      .get('thread-sans-fiche') as { user_id: string | null };
    expect(orphan.user_id).toBeNull();
    runner.deleteThread('thread-a');
    runner.deleteThread('thread-sans-fiche');
    runner.close();
    workspace.close();
  });
});

describe('C2 — pièces jointes (Store)', () => {
  it('claimAttachment ne vole jamais une pièce déjà attribuée', () => {
    const store = new Store(':memory:');
    store.claimAttachment('att-1', 'user-1');
    store.claimAttachment('att-1', 'user-2');
    expect(store.attachmentOwnerAny('att-1')).toBe('user-1');
    store.close();
  });

  it('attachmentOwner est porté : B ne voit pas la pièce de A', () => {
    const db = new DatabaseSync(':memory:');
    const storeA = new Store(db).forUser('user-1');
    const storeB = new Store(db).forUser('user-2');
    storeA.claimAttachment('att-1', 'user-1');
    expect(storeA.attachmentOwner('att-1')).toBe('user-1');
    expect(storeB.attachmentOwner('att-1')).toBeUndefined();
    // B ne peut pas supprimer la ligne propriétaire de A.
    expect(storeB.deleteAttachmentOwner('att-1')).toBe(false);
    expect(storeA.attachmentOwner('att-1')).toBe('user-1');
    // A peut supprimer sa propre ligne.
    expect(storeA.deleteAttachmentOwner('att-1')).toBe(true);
    expect(storeA.attachmentOwner('att-1')).toBeUndefined();
    db.close();
  });
});

describe('C2 — ordinateurs (ComputerStore)', () => {
  it('permissions et audit sont filtrés par compte', () => {
    const db = new DatabaseSync(':memory:');
    const wsA = new WorkspaceStore(db, 'user-1');
    const wsB = new WorkspaceStore(db, 'user-2');
    wsA.ensureSeed();
    wsB.ensureSeed();
    const dotA = wsA.dots()[0];
    const computersA = wsA.computers;
    const computersB = wsB.computers;
    computersA.patch(dotA.id, { enabled: true, browser: true });
    expect(computersA.permissions(dotA.id)).toMatchObject({
      enabled: true,
      browser: true,
    });
    // B ne voit pas les permissions de A (défauts, jamais les valeurs de A).
    expect(computersB.permissions(dotA.id)).toMatchObject({
      enabled: false,
      browser: false,
    });
    // Journal d'audit filtré aussi.
    const receipt = computersA.begin(dotA.id, 'permissions', 'owner');
    computersA.finish(receipt, 'succeeded');
    expect(computersA.audit(dotA.id)).toHaveLength(1);
    expect(computersB.audit(dotA.id)).toHaveLength(0);
    // B ne peut pas écrire pour le Dot de A (requireDot bloque au service ;
    // au niveau store, la ligne serait lue comme inexistante pour B).
    db.close();
  });

  it('claimOrphans rattache chaque ligne au propriétaire de son Dot', () => {
    const db = new DatabaseSync(':memory:');
    const ws = new WorkspaceStore(db, 'user-1');
    ws.ensureSeed();
    const dot = ws.dots()[0];
    // Lignes legacy (user_id NULL) écrites en SQL direct.
    db.prepare(
      'INSERT INTO computer_permissions (dotId, value, user_id) VALUES (?, ?, NULL)',
    ).run(dot.id, JSON.stringify({ enabled: true }));
    db.prepare(
      'INSERT INTO computer_audit (id, dotId, action, actor, outcome, createdAt, user_id) VALUES (?, ?, ?, ?, ?, ?, NULL)',
    ).run('audit-1', dot.id, 'permissions', 'owner', 'succeeded', Date.now());
    ws.claimOrphans('user-1');
    const perm = db
      .prepare('SELECT user_id FROM computer_permissions WHERE dotId=?')
      .get(dot.id) as { user_id: string };
    const audit = db
      .prepare('SELECT user_id FROM computer_audit WHERE id=?')
      .get('audit-1') as { user_id: string };
    expect(perm.user_id).toBe('user-1');
    expect(audit.user_id).toBe('user-1');
    db.close();
  });
});

describe('C2 — pièces jointes inter-comptes (HTTP)', () => {
  it('B ne peut ni lire ni supprimer la pièce jointe de A (404)', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'app-att-c2-'));
    const origCwd = process.cwd();
    process.chdir(sandbox);
    try {
      const { createApp } = await import('../src/server/app.js');
      const { AuthStore } = await import('../src/server/auth-store.js');
      const { Runner } = await import('../src/server/runner.js');
      const { loginSession, directSession } = await import('./auth-helpers.js');
      const store = new Store(':memory:').forUser('owner');
      const auth = new AuthStore(':memory:');
      const runner = new Runner(store, {
        mode: 'sample',
        baseUrl: 'https://api.openai.com/v1',
      });
      const app = createApp({
        store,
        runner,
        config: { mode: 'sample', baseUrl: 'https://api.openai.com/v1' },
        auth,
      });
      // Utilisateur B (id différent de 'owner').
      await auth.createUser('bob', 'bob-password-123', 'user', 'bob-id');
      const cookieA = await loginSession(app, auth);
      const cookieB = await directSession(auth, 'bob');
      const form = new FormData();
      form.append(
        'files',
        new File(['bonjour'], 'note.txt', { type: 'text/plain' }),
      );
      const up = await app.request('/api/attachments', {
        method: 'POST',
        headers: { Cookie: cookieA },
        body: form,
      });
      expect(up.status).toBe(201);
      const { attachments } = (await up.json()) as {
        attachments: { id: string }[];
      };
      const id = attachments[0].id;
      // A lit sa pièce.
      expect(
        (
          await app.request(`/api/attachments/${id}/content`, {
            headers: { Cookie: cookieA },
          })
        ).status,
      ).toBe(200);
      // B : 404 partout (contenu, métadonnées, texte, suppression, mark-attached).
      expect(
        (
          await app.request(`/api/attachments/${id}/content`, {
            headers: { Cookie: cookieB },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await app.request(`/api/attachments/${id}`, {
            headers: { Cookie: cookieB },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await app.request(`/api/attachments/${id}/text`, {
            headers: { Cookie: cookieB },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await app.request(`/api/attachments/${id}`, {
            method: 'DELETE',
            headers: { Cookie: cookieB },
          })
        ).status,
      ).toBe(404);
      const marked = await app.request('/api/attachments/mark-attached', {
        method: 'POST',
        headers: { Cookie: cookieB, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
      expect(((await marked.json()) as { marked: number }).marked).toBe(0);
      // La pièce de A est toujours là (B ne l'a pas supprimée).
      expect(
        (
          await app.request(`/api/attachments/${id}/content`, {
            headers: { Cookie: cookieA },
          })
        ).status,
      ).toBe(200);
      // A la supprime.
      expect(
        (
          await app.request(`/api/attachments/${id}`, {
            method: 'DELETE',
            headers: { Cookie: cookieA },
          })
        ).status,
      ).toBe(200);
      store.close();
      auth.close();
    } finally {
      process.chdir(origCwd);
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('claimOrphanAttachments réclame les pièces sans propriétaire', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'app-att-claim-'));
    const origCwd = process.cwd();
    process.chdir(sandbox);
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { claimOrphanAttachments } =
        await import('../src/server/attachment-routes.js');
      const store = new Store(':memory:');
      // Pièce sans propriétaire (écrite à la main, comme avant C2).
      await mkdir(
        join(sandbox, 'data/attachments/11111111-1111-1111-1111-111111111111'),
        {
          recursive: true,
        },
      );
      await writeFile(
        join(
          sandbox,
          'data/attachments/11111111-1111-1111-1111-111111111111/meta.json',
        ),
        JSON.stringify({
          id: '11111111-1111-1111-1111-111111111111',
          name: 'legacy.txt',
          size: 1,
          mime: 'text/plain',
          category: 'text',
          createdAt: Date.now(),
        }),
      );
      await writeFile(
        join(
          sandbox,
          'data/attachments/11111111-1111-1111-1111-111111111111/file',
        ),
        'x',
      );
      // Pièce déjà attribuée à un autre compte.
      await mkdir(
        join(sandbox, 'data/attachments/22222222-2222-2222-2222-222222222222'),
        {
          recursive: true,
        },
      );
      await writeFile(
        join(
          sandbox,
          'data/attachments/22222222-2222-2222-2222-222222222222/meta.json',
        ),
        JSON.stringify({
          id: '22222222-2222-2222-2222-222222222222',
          name: 'autre.txt',
          size: 1,
          mime: 'text/plain',
          category: 'text',
          createdAt: Date.now(),
        }),
      );
      await writeFile(
        join(
          sandbox,
          'data/attachments/22222222-2222-2222-2222-222222222222/file',
        ),
        'y',
      );
      store.claimAttachment('22222222-2222-2222-2222-222222222222', 'user-2');
      const claimed = await claimOrphanAttachments(store, 'user-1');
      expect(claimed).toBe(1);
      expect(
        store.attachmentOwnerAny('11111111-1111-1111-1111-111111111111'),
      ).toBe('user-1');
      // Celle de user-2 n'a jamais été volée.
      expect(
        store.attachmentOwnerAny('22222222-2222-2222-2222-222222222222'),
      ).toBe('user-2');
      store.close();
    } finally {
      process.chdir(origCwd);
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('C2 — ordinateur d’autrui (HTTP)', () => {
  it('PATCH permissions du Dot de A par B → 404', async () => {
    const { ComputerService } =
      await import('../src/server/computer-service.js');
    const { computerRoutes } = await import('../src/server/computer-routes.js');
    const { mountScoped } = await import('./scoped-mount.js');
    const db = new DatabaseSync(':memory:');
    const wsA = new WorkspaceStore(db, 'user-1');
    const wsB = new WorkspaceStore(db, 'user-2');
    wsA.ensureSeed();
    wsB.ensureSeed();
    const dotA = wsA.dots()[0];
    const config = {
      baseUrl: 'https://example.com',
      voiceName: 'voice',
      slackUsers: [],
      runtimeUrl: 'http://localhost',
      computerSupervisorUrl: 'http://127.0.0.1:4312',
      computerSupervisorToken: 'supervisor-secret',
      computerToken: 'master-secret',
    };
    const serviceB = new ComputerService(
      wsB,
      config,
      () => false,
      async () => Response.json({ computers: [] }),
    );
    const app = mountScoped(computerRoutes(), {
      userId: 'user-2',
      workspace: wsB,
      computers: serviceB,
    });
    const res = await app.request(`/dots/${dotA.id}/computer/permissions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(404);
    // Le Dot de A n'a pas été modifié (B n'a rien écrit).
    expect(wsA.computers.permissions(dotA.id)).toMatchObject({
      enabled: false,
    });
    db.close();
  });
});

describe('C2 — voix inter-comptes', () => {
  it('begin pour le thread de A par B → refus (thread introuvable pour B)', async () => {
    const { VoiceService } = await import('../src/server/voice.js');
    const db = new DatabaseSync(':memory:');
    const store = new Store(db).forUser('user-1');
    const workspace = new WorkspaceStore(db, 'user-1');
    workspace.ensureSeed();
    const dot = workspace.dots()[0];
    workspace.bindThread('thread-a', dot.id, 'Conversation A');
    const turn = vi.fn(async () => 'Current answer');
    const history = vi.fn(async () => 'user: Earlier topic');
    const transport = vi.fn(
      async () =>
        new Response('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111', {
          headers: { location: '/v1/realtime/calls/rtc_test' },
        }),
    );
    const voice = new VoiceService(
      {
        workspace,
        store,
        config: {
          baseUrl: 'https://example.com',
          voiceKey: 'test-secret',
          voiceModel: 'voice-model',
          voiceName: 'marin',
          runtimeUrl: '',
          slackUsers: [],
        },
        turn,
        history,
        requireReady() {},
        setup: () => ({
          voice: true,
          intelligence: true,
          model: true,
          browser: false,
          slack: 'not_configured',
          missing: [],
        }),
      },
      transport,
    );
    const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111';
    // A peut lancer l'appel sur son thread.
    const call = await voice.begin(
      'thread-a',
      offer,
      new AbortController().signal,
      'user-1',
    );
    expect(typeof call.id).toBe('string');
    // B ne peut pas lancer d'appel sur le thread de A.
    await expect(
      voice.begin('thread-a', offer, new AbortController().signal, 'user-2'),
    ).rejects.toThrow();
    voice.abortAll();
    db.close();
  });
});

describe('C2 — SSE /api/copilotkit inter-comptes', () => {
  it('le handle refuse le thread de A à B (403)', async () => {
    const { Platform } = await import('../src/server/platform.js');
    const db = new DatabaseSync(':memory:');
    const store = new Store(db).forUser('user-1');
    const workspace = new WorkspaceStore(db, 'user-1');
    workspace.ensureSeed();
    const dot = workspace.dots()[0];
    workspace.bindThread('thread-a', dot.id, 'Conversation A');
    const platform = new Platform(store, workspace, {
      baseUrl: '',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    });
    // A passe la porte (400 = validation du corps, après le scope).
    const resA = await platform.handle(
      new Request('http://localhost/api/copilotkit/agent/' + dot.id + '/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: 'thread-a', messages: 'invalid' }),
      }),
      'user-1',
    );
    expect(resA.status).toBe(400);
    // B est bloqué par la porte (403), avant toute exécution.
    const resB = await platform.handle(
      new Request('http://localhost/api/copilotkit/agent/' + dot.id + '/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: 'thread-a', messages: 'invalid' }),
      }),
      'user-2',
    );
    expect(resB.status).toBe(403);
    db.close();
  });
});
