import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
it('persists spaces, specialist permissions, and canonical thread ownership', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const space = store.createSpace('Design', 'Design decisions');
  const dot = store.createDot(space.id, 'Scout', 'Be concise', false, true);
  store.bindThread('thread-1', dot.id, 'Design research');
  expect(store.requireThread('thread-1', dot.id).ownerId).toBe('owner');
  expect(() => store.requireThread('thread-1', 'another-dot')).toThrow();
  expect(() => store.requireThread('unknown')).toThrow();
  expect(store.dot(dot.id)?.researchAllowed).toBe(false);
  store.close();
});
it('rejects a dot in a nonexistent space and does not rebind an existing thread', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  store.ensureSeed();
  expect(() => store.createDot('missing', 'Dot', 'Help', true, true)).toThrow();
  const dots = store.dots();
  store.bindThread('one', dots[0].id, 'First');
  expect(() => store.bindThread('one', dots[0].id, 'Second')).toThrow();
  store.close();
});

it('edits a space and duplicates a dot with its tune', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const space = store.createSpace('Design', 'Design decisions');
  const updated = store.updateSpace(space.id, 'Atelier', 'Refonte UI');
  expect(updated.name).toBe('Atelier');
  expect(store.space(space.id)?.description).toBe('Refonte UI');
  expect(() => store.updateSpace('missing', 'x', '')).toThrow();

  const dot = store.createDot(space.id, 'Scout', 'Be concise', false, true);
  store.setDotContextBudget(dot.id, 16384);
  store.setDotCompactionStrategy(dot.id, 'magic-compact');
  const before = store.dots().length;
  const copy = store.duplicateDot(dot.id);
  expect(copy).toBeTruthy();
  expect(copy?.name).toBe('Scout (copie)');
  expect(copy?.instructions).toBe('Be concise');
  expect(copy?.memoryAllowed).toBe(true);
  expect(copy?.contextBudget).toBe(16384);
  expect(copy?.compactionStrategy).toBe('magic-compact');
  expect(copy?.id).not.toBe(dot.id);
  expect(store.dots()).toHaveLength(before + 1);
  expect(store.duplicateDot('missing')).toBeNull();
  store.close();
});

it('migrates legacy Space ownership once and never restores revoked access on restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-access-'));
  const path = join(dir, 'workspace.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      INSERT INTO spaces VALUES ('old', 'Original', '', 1), ('new', 'New', '', 2);
      INSERT INTO dots VALUES ('dot', 'old', 'Dot', 'Help', 1, 1, 1);`);
    legacy.close();
    const ws = new WorkspaceStore(path, 'owner');
    // C1 : les lignes legacy (user_id NULL) sont réclamées par le premier
    // compte au boot — ici explicitement, comme le fait index.ts.
    ws.claimOrphans('owner');
    const dot = ws.dot('dot')!;
    expect(dot.spaceIds).toEqual(['old']);
    expect(ws.canAccessSpace('dot', 'new')).toBe(false);
    expect(() =>
      ws.updateDot('dot', { ...dot, spaceIds: ['missing'] }),
    ).toThrow();
    expect(ws.dot('dot')?.spaceIds).toEqual(['old']);
    ws.bindThread('existing-thread', 'dot', 'Keep me');
    ws.updateDot('dot', { ...dot, spaceId: 'new', spaceIds: ['new'] });
    ws.close();
    const reopened = new WorkspaceStore(path, 'owner');
    expect(reopened.dot('dot')?.spaceIds).toEqual(['new']);
    expect(reopened.canAccessSpace('dot', 'old')).toBe(false);
    expect(reopened.requireThread('existing-thread').dotId).toBe('dot');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('persists the per-dot context budget (phase 6)', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const space = store.createSpace('Design', 'Design decisions');
  const dot = store.createDot(space.id, 'Scout', 'Be concise', false, true);
  expect(store.dot(dot.id)?.contextBudget ?? null).toBeNull();
  store.setDotContextBudget(dot.id, 16384);
  expect(store.dot(dot.id)?.contextBudget).toBe(16384);
  store.setDotContextBudget(dot.id, null);
  expect(store.dot(dot.id)?.contextBudget ?? null).toBeNull();
  expect(() => store.setDotContextBudget('missing', 8192)).toThrow();
  store.close();
});

it('persists the per-dot compaction strategy (phase 9)', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const space = store.createSpace('Design', 'Design decisions');
  const dot = store.createDot(space.id, 'Scout', 'Be concise', false, true);
  expect(store.dot(dot.id)?.compactionStrategy ?? null).toBeNull();
  store.setDotCompactionStrategy(dot.id, 'magic-compact');
  expect(store.dot(dot.id)?.compactionStrategy).toBe('magic-compact');
  store.setDotCompactionStrategy(dot.id, null);
  expect(store.dot(dot.id)?.compactionStrategy ?? null).toBeNull();
  expect(() => store.setDotCompactionStrategy('missing', 'native')).toThrow();
  store.close();
});

it('refuses an avatar id in the model slot of createDot', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const space = store.createSpace('Design', 'Design decisions');
  // Inversion d'arguments (avatar passé dans le slot model) : refusée.
  expect(() =>
    store.createDot(
      space.id,
      'Scout',
      'Be concise',
      false,
      true,
      [space.id],
      null,
      false,
      'leo',
    ),
  ).toThrow('Invalid model');
  // Un vrai modèle + un avatar passent.
  const dot = store.createDot(
    space.id,
    'Scout',
    'Be concise',
    false,
    true,
    [space.id],
    null,
    false,
    'gpt-4o',
    'leo',
  );
  expect(dot.model).toBe('gpt-4o');
  expect(dot.avatar).toBe('leo');
  store.close();
});

it('migre un app_config legacy AVEC lignes (prod) sans violer NOT NULL', () => {
  // Régression C1 : la migration app_config insérait NULL dans une colonne
  // NOT NULL → le serveur refusait de démarrer sur une base réelle.
  const dir = mkdtempSync(join(tmpdir(), 'ws-legacy-'));
  const path = join(dir, 'legacy.sqlite');
  const setup = new DatabaseSync(path);
  setup.exec(
    "CREATE TABLE app_config(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO app_config VALUES ('k','v');",
  );
  setup.close();
  const store = new WorkspaceStore(path, 'owner');
  store.claimOrphans('user-1');
  const row = (
    store as unknown as {
      db: DatabaseSync;
    }
  ).db
    .prepare('SELECT user_id, key, value FROM app_config')
    .get() as {
    user_id: string;
    key: string;
    value: string;
  };
  expect(row).toMatchObject({ user_id: 'user-1', key: 'k', value: 'v' });
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('skills locaux : flag par Dot, politique admin et usage', () => {
  const store = new WorkspaceStore(':memory:', 'owner');
  const space = store.createSpace('Design', 'Design decisions');
  const dot = store.createDot(
    space.id,
    'Scout',
    'Be concise',
    false,
    true,
    [space.id],
    null,
    false,
    null,
    null,
    true,
  );
  expect(store.dot(dot.id)?.skillsEnabled).toBe(true);
  expect(store.duplicateDot(dot.id)?.skillsEnabled).toBe(true);
  const updated = store.updateDot(dot.id, {
    name: 'Scout',
    instructions: 'Be concise',
    researchAllowed: false,
    memoryAllowed: true,
    skillsEnabled: false,
  });
  expect(updated.skillsEnabled).toBe(false);

  // Défaut : kill switch ouvert, allowlist nulle (tous les comptes).
  expect(store.skillsPolicy()).toEqual({ enabled: true, allowedUsers: null });
  expect(store.skillsAllowed()).toBe(true);
  store.setSkillsPolicy({ enabled: false });
  expect(store.skillsAllowed()).toBe(false);
  store.setSkillsPolicy({ enabled: true, allowedUsers: ['other'] });
  expect(store.skillsAllowed()).toBe(false);
  expect(store.forUser('other').skillsAllowed()).toBe(true);

  store.forUser('other').recordSkillLoad(dot.id, 'repo/docx');
  store.forUser('other').recordSkillLoad(dot.id, 'repo/docx');
  expect(store.skillUsageAll()).toEqual([
    {
      userId: 'other',
      dotId: dot.id,
      skillId: 'repo/docx',
      loads: 2,
      lastUsedAt: expect.any(Number),
    },
  ]);
  // Une politique illisible retombe fermée (fail-closed).
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare(
    "UPDATE app_config SET value='not json' WHERE user_id='' AND key='skills_policy'",
  ).run();
  expect(store.skillsAllowed()).toBe(false);
  store.close();
});
