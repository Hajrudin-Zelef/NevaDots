import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { SkillLibrary } from '../src/server/skills-library';
import { skillTools } from '../src/server/skill-tools';
import { skillRoutes } from '../src/server/skill-routes';
import type { AppVariables } from '../src/server/request-context';
import type { ComputerService } from '../src/server/computer-service';
import { WorkspaceStore } from '../src/server/workspace';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'skilltools-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'repo/skills/docx');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---
name: docx
description: Create and edit Word documents.
---

# DOCX procedure
Step one.`,
  );
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts/run.sh'), '#!/bin/sh\necho docx\n');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets/logo.bin'), Buffer.from([0, 1, 2]));
  return { root, lib: new SkillLibrary(root) };
}

function tool(lib: SkillLibrary, name: string) {
  const found = skillTools(lib).find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  // Le tableau est une union de schémas distincts : on isole l'exécuteur
  // testé derrière une signature commune.
  return found as unknown as {
    execute?: (input: Record<string, unknown>) => Promise<unknown>;
  };
}

describe('skill tools', () => {
  it('search_skills renvoie les ids et marque les données tierces', async () => {
    const { lib } = fixture();
    const result = (await tool(lib, 'search_skills').execute?.({
      query: 'word document',
    })) as {
      count: number;
      note: string;
      skills: { id: string }[];
    };
    expect(result.count).toBe(1);
    expect(result.skills[0].id).toBe('repo/docx');
    expect(result.note).toContain('Third-party');
  });

  it('load_skill renvoie le contenu avec le préambule de sécurité', async () => {
    const { lib } = fixture();
    const result = (await tool(lib, 'load_skill').execute?.({
      id: 'repo/docx',
    })) as { content: string; truncated: boolean; version: string };
    expect(result.content).toContain('third-party skill');
    expect(result.content).toContain('# DOCX procedure');
    expect(result.truncated).toBe(false);
    expect(result.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it('load_skill matérialise le bundle via le computer quand il est disponible', async () => {
    const { lib } = fixture();
    const calls: {
      id: string;
      input: { ticket: string; path: string; version: string };
    }[] = [];
    const computer = {
      configured: true,
      policy: () => ({
        enabled: true,
        browser: false,
        files: true,
        shell: false,
      }),
      installSkillBundle: async (
        id: string,
        input: { ticket: string; path: string; version: string },
      ) => {
        calls.push({ id, input });
        return { installed: true, current: false, path: input.path };
      },
    } as unknown as ComputerService;
    const tools = skillTools(lib, {
      computer,
      dotId: 'dot-1',
      bundleBaseUrl: 'http://172.17.0.1:4310',
    });
    const load = tools.find(
      (item) => item.name === 'load_skill',
    ) as unknown as {
      execute?: (input: Record<string, unknown>) => Promise<{
        path: string | null;
        installed: boolean;
        files: { path: string }[];
        content: string;
      }>;
    };
    const result = await load.execute?.({ id: 'repo/docx' });
    expect(result?.path).toBe('.skills/repo/docx');
    expect(result?.installed).toBe(true);
    expect(result?.files.map((file) => file.path)).toContain('scripts/run.sh');
    expect(calls[0].id).toBe('dot-1');
    expect(calls[0].input.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0].input.path).toBe('.skills/repo/docx');
    expect(calls[0].input.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it('load_skill garde le contenu si la matérialisation échoue', async () => {
    const { lib } = fixture();
    const computer = {
      configured: true,
      policy: () => ({
        enabled: true,
        browser: false,
        files: true,
        shell: false,
      }),
      installSkillBundle: async () => {
        throw new Error('computer stopped');
      },
    } as unknown as ComputerService;
    const tools = skillTools(lib, {
      computer,
      dotId: 'dot-1',
      bundleBaseUrl: 'http://172.17.0.1:4310',
    });
    const load = tools.find(
      (item) => item.name === 'load_skill',
    ) as unknown as {
      execute?: (input: Record<string, unknown>) => Promise<{
        path: string | null;
        note?: string;
        content: string;
      }>;
    };
    const result = await load.execute?.({ id: 'repo/docx' });
    expect(result?.content).toContain('# DOCX procedure');
    expect(result?.path).toBeNull();
    expect(result?.note).toContain('not materialized');
  });

  it('load_skill sans computer renvoie le contenu seul', async () => {
    const { lib } = fixture();
    const result = (await tool(lib, 'load_skill').execute?.({
      id: 'repo/docx',
    })) as { path: string | null; note?: string };
    expect(result.path).toBeNull();
    expect(result.note).toContain('Computer not configured');
  });

  it('read_skill_file lit le texte et refuse traversée/binaire', async () => {
    const { lib } = fixture();
    const read = tool(lib, 'read_skill_file');
    const file = (await read.execute?.({
      id: 'repo/docx',
      path: 'scripts/run.sh',
    })) as { text: string; binary: boolean };
    expect(file.text).toContain('echo docx');
    expect(file.binary).toBe(false);
    const binary = (await read.execute?.({
      id: 'repo/docx',
      path: 'assets/logo.bin',
    })) as { binary: boolean; text: string };
    expect(binary.binary).toBe(true);
    expect(binary.text).toBe('');
    await expect(
      read.execute?.({ id: 'repo/docx', path: '../SKILL.md' }),
    ).rejects.toThrow('Skill file not found.');
  });

  it('load_skill refuse un id inconnu', async () => {
    const { lib } = fixture();
    await expect(
      tool(lib, 'load_skill').execute?.({ id: 'repo/absent' }),
    ).rejects.toThrow('Skill not found.');
  });
});

describe('skill routes', () => {
  function workspaceFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'skillws-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const ws = new WorkspaceStore(join(dir, 'w.sqlite'), 'user-1');
    cleanup.push(() => ws.close());
    return ws;
  }
  function appWith(
    lib: SkillLibrary,
    role: 'admin' | 'user',
    ws = workspaceFixture(),
  ) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('role', role);
      await next();
    });
    app.route('/', skillRoutes(lib, ws));
    return { app, ws };
  }

  it('GET /skills cherche et liste', async () => {
    const { lib } = fixture();
    const { app } = appWith(lib, 'user');
    const response = await app.request('/skills?query=word');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      size: number;
      skills: { id: string }[];
    };
    expect(body.size).toBe(1);
    expect(body.skills[0].id).toBe('repo/docx');
  });

  it('le bundle sert un tar.gz à usage unique', async () => {
    const { lib } = fixture();
    const ticket = lib.mintBundle('repo/docx', 'dot-1');
    const { app } = appWith(lib, 'user');
    const response = await app.request(`/skills/bundle?ticket=${ticket}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('gzip');
    const tar = gunzipSync(Buffer.from(await response.arrayBuffer()));
    expect(tar.toString('utf8')).toContain('SKILL.md');
    expect(tar.toString('utf8')).toContain('scripts/run.sh');
    const replay = await app.request(`/skills/bundle?ticket=${ticket}`);
    expect(replay.status).toBe(401);
  });

  it('POST /skills/:id/ticket est réservé à l’Admin et mint un ticket', async () => {
    const { lib } = fixture();
    const user = await appWith(lib, 'user').app.request(
      '/skills/repo%2Fdocx/ticket',
      {
        method: 'POST',
      },
    );
    expect(user.status).toBe(403);
    const admin = await appWith(lib, 'admin').app.request(
      '/skills/repo%2Fdocx/ticket',
      { method: 'POST' },
    );
    expect(admin.status).toBe(200);
    const body = (await admin.json()) as { ticket: string; id: string };
    expect(body.id).toBe('repo/docx');
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(lib.consumeBundle(body.ticket)).toEqual({
      skillId: 'repo/docx',
      dotId: 'admin:undefined',
    });
  });

  it('politique Admin : kill switch, allowlist et usage', async () => {
    const { lib } = fixture();
    const ws = workspaceFixture();
    // Défaut : autorisé pour tous les comptes.
    expect(ws.skillsPolicy()).toEqual({ enabled: true, allowedUsers: null });
    expect(ws.skillsAllowed()).toBe(true);
    const { app } = appWith(lib, 'admin', ws);
    const denied = await appWith(lib, 'user', ws).app.request('/skills/policy');
    expect(denied.status).toBe(403);

    const off = await app.request('/skills/policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(off.status).toBe(200);
    expect(ws.skillsAllowed()).toBe(false);
    const search = skillTools(lib, {
      isEnabled: () => ws.skillsAllowed(),
    }).find((t) => t.name === 'search_skills') as unknown as {
      execute?: (input: { query: string }) => Promise<unknown>;
    };
    await expect(search.execute?.({ query: 'word' })).rejects.toThrow(
      /disabled/,
    );

    await app.request('/skills/policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, allowedUsers: ['user-2'] }),
    });
    expect(ws.skillsAllowed()).toBe(false);
    ws.forUser('user-2').skillsAllowed();
    expect(ws.forUser('user-2').skillsAllowed()).toBe(true);

    ws.forUser('user-2').recordSkillLoad('dot-1', 'repo/docx');
    ws.forUser('user-2').recordSkillLoad('dot-1', 'repo/docx');
    const usage = await app.request('/skills/usage');
    expect(await usage.json()).toMatchObject({
      usage: [
        { userId: 'user-2', dotId: 'dot-1', skillId: 'repo/docx', loads: 2 },
      ],
    });
    const invalid = await app.request('/skills/policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(invalid.status).toBe(400);
  });

  it('POST /skills/reindex est réservé à l’Admin', async () => {
    const { lib } = fixture();
    const user = await appWith(lib, 'user').app.request('/skills/reindex', {
      method: 'POST',
    });
    expect(user.status).toBe(403);
    const admin = await appWith(lib, 'admin').app.request('/skills/reindex', {
      method: 'POST',
    });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({ count: 1 });
  });
});
