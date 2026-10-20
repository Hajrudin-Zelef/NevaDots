import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { SkillLibrary } from '../src/server/skills-library';
import { skillTools } from '../src/server/skill-tools';
import { skillRoutes } from '../src/server/skill-routes';
import type { AppVariables } from '../src/server/request-context';

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

  it('load_skill refuse un id inconnu', async () => {
    const { lib } = fixture();
    await expect(
      tool(lib, 'load_skill').execute?.({ id: 'repo/absent' }),
    ).rejects.toThrow('Skill not found.');
  });
});

describe('skill routes', () => {
  function appWith(lib: SkillLibrary, role: 'admin' | 'user') {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('role', role);
      await next();
    });
    app.route('/', skillRoutes(lib));
    return app;
  }

  it('GET /skills cherche et liste', async () => {
    const { lib } = fixture();
    const app = appWith(lib, 'user');
    const response = await app.request('/skills?query=word');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      size: number;
      skills: { id: string }[];
    };
    expect(body.size).toBe(1);
    expect(body.skills[0].id).toBe('repo/docx');
  });

  it('POST /skills/reindex est réservé à l’Admin', async () => {
    const { lib } = fixture();
    const user = await appWith(lib, 'user').request('/skills/reindex', {
      method: 'POST',
    });
    expect(user.status).toBe(403);
    const admin = await appWith(lib, 'admin').request('/skills/reindex', {
      method: 'POST',
    });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({ count: 1 });
  });
});
