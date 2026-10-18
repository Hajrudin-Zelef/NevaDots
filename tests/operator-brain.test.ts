import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  consultBrainSync,
  formatBrainSummary,
  listBrainFiles,
  readBrainFile,
  resolveBrainPath,
  writeBrainFile,
} from '../src/server/operator-brain';

describe('operator-brain (phase 8)', () => {
  it('resolveBrainPath bloque le path traversal', () => {
    expect(resolveBrainPath('user', '../secret.md')).toBeNull();
    expect(resolveBrainPath('user', '../../etc/passwd')).toBeNull();
    expect(resolveBrainPath('user', 'a/../../b.md')).toBeNull();
    expect(resolveBrainPath('user', '/absolu.md')).toBeNull();
    expect(resolveBrainPath('user', 'notes.txt')).toBeNull();
    expect(resolveBrainPath('user', '')).toBeNull();
    const ok = resolveBrainPath('user', 'specs/api.md');
    expect(ok).not.toBeNull();
    expect(ok!.endsWith('.operator/user/specs/api.md')).toBe(true);
  });

  it('formatBrainSummary gère les partitions vides', () => {
    expect(
      formatBrainSummary([
        { partition: 'user', files: [], index: null },
        { partition: 'project', files: [], index: null },
        { partition: 'shared', files: [], index: null },
      ]),
    ).toBe('aucun');
    const formatted = formatBrainSummary([
      {
        partition: 'user',
        files: ['memories.md', 'specs/api.md'],
        index: '# Index\nRègles.',
      },
      { partition: 'project', files: [], index: null },
      { partition: 'shared', files: [], index: null },
    ]);
    expect(formatted).toContain('[user]');
    expect(formatted).toContain('memories.md');
    expect(formatted).not.toContain('[project]');
  });
});

describe('operator-brain — symlinks et plafonds (audit final)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-symlink-'));
  const home = join(tmp, 'home');
  const proj = join(tmp, 'proj');
  mkdirSync(join(home, '.operator', 'user'), { recursive: true });
  mkdirSync(join(proj, '.operator'), { recursive: true });
  mkdirSync(join(proj, '.operator-shared'), { recursive: true });

  const savedHome = process.env.HOME;
  const savedProj = process.env.OPERATOR_PROJECT_ROOT;

  beforeEach(() => {
    process.env.HOME = home;
    process.env.OPERATOR_PROJECT_ROOT = proj;
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProj === undefined) delete process.env.OPERATOR_PROJECT_ROOT;
    else process.env.OPERATOR_PROJECT_ROOT = savedProj;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('lecture/écriture normales inchangées', async () => {
    expect(
      await writeBrainFile('project', 'normal.md', '# Normal\n'),
    ).not.toBeNull();
    expect((await readBrainFile('project', 'normal.md'))?.content).toBe(
      '# Normal\n',
    );
  });

  it('refuse lecture/écriture/liste à travers un symlink (même interne)', async () => {
    const secret = join(tmp, 'secret.txt');
    writeFileSync(secret, 'TOP-SECRET', 'utf8');
    symlinkSync(secret, join(proj, '.operator', 'link.md'));
    expect(await readBrainFile('project', 'link.md')).toBeNull();
    expect(await writeBrainFile('project', 'link.md', 'x')).toBeNull();
    expect(readFileSync(secret, 'utf8')).toBe('TOP-SECRET');
    expect(await listBrainFiles('project')).not.toContain('link.md');
    // Symlink vers un fichier de la même partition : refusé aussi.
    const real = join(proj, '.operator', 'real.md');
    writeFileSync(real, '# Réel\n', 'utf8');
    symlinkSync(real, join(proj, '.operator', 'alias.md'));
    expect(await readBrainFile('project', 'alias.md')).toBeNull();
  });

  it("refuse l'écriture sous un répertoire symlinké", async () => {
    const target = join(tmp, 'target-dir');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(proj, '.operator', 'sub'));
    expect(await writeBrainFile('project', 'sub/x.md', 'x')).toBeNull();
    expect(existsSync(join(target, 'x.md'))).toBe(false);
  });

  it('ne boucle pas sur un cycle de symlinks (liste + consult)', async () => {
    const cycle = join(proj, '.operator', 'cycle');
    mkdirSync(cycle, { recursive: true });
    symlinkSync(join(proj, '.operator'), join(cycle, 'loop'));
    const files = await listBrainFiles('project');
    expect(files.filter((f) => f.includes('loop'))).toEqual([]);
    expect(typeof consultBrainSync([])).toBe('string');
  });

  it('plafonne la lecture des fichiers géants', async () => {
    const big = join(proj, '.operator', 'big.md');
    writeFileSync(big, 'x'.repeat(1_000_001), 'utf8');
    expect(await readBrainFile('project', 'big.md')).toBeNull();
    const small = join(proj, '.operator', 'small.md');
    writeFileSync(small, '# Petit\n', 'utf8');
    expect((await readBrainFile('project', 'small.md'))?.content).toContain(
      'Petit',
    );
  });

  it('plafonne la profondeur des marches', async () => {
    let dir = join(proj, '.operator', 'deep');
    for (let i = 0; i < 10; i++) {
      dir = join(dir, `l${i}`);
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(dir, 'bottom.md'), '# Fond\n', 'utf8');
    writeFileSync(
      join(proj, '.operator', 'deep', 'l0', 'l1', 'shallow.md'),
      '# Peu profond\n',
      'utf8',
    );
    const files = await listBrainFiles('project');
    expect(files).not.toContain('deep/l0/l1/l2/l3/l4/l5/l6/l7/l8/l9/bottom.md');
    expect(files).toContain('deep/l0/l1/shallow.md');
  });
});

describe('consultBrainSync (optimisation tokens)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-consult-'));
  const home = join(tmp, 'home');
  const proj = join(tmp, 'proj');
  const specsDir = join(proj, '.operator', 'specs');
  mkdirSync(join(home, '.operator', 'user'), { recursive: true });
  mkdirSync(specsDir, { recursive: true });

  const write = (abs: string, content: string) =>
    writeFileSync(abs, content, 'utf8');

  write(
    join(proj, '.operator', 'operator.md'),
    '# Instructions de test\n\nCorps.\n',
  );
  write(
    join(specsDir, 'a.md'),
    '---\ndescription: Contrat alpha — invariants de tri.\nread_if: Travailler sur alpha.\n---\n\n# Titre alpha\n\n' +
      'Corps long pour vérifier que seule la description est reprise. '.repeat(
        40,
      ) +
      '\n',
  );
  // 40 specs supplémentaires : dépasse le budget → troncature bornée.
  for (let i = 0; i < 40; i++) {
    const id = String(i).padStart(2, '0');
    write(
      join(specsDir, `f${id}.md`),
      `---\ndescription: ${'R'.repeat(60)}${id} fin.\nread_if: X.\n---\n\n# F${id}\n`,
    );
  }
  write(join(home, '.operator', 'user', 'notes.md'), '# Notes globales\n');
  write(
    join(home, '.operator', 'user', 'memories.md'),
    '# Mémoires utilisateur\n- machin\n',
  );

  const savedHome = process.env.HOME;
  const savedProj = process.env.OPERATOR_PROJECT_ROOT;

  it('résumé compact : libellés utiles, jamais de ---, memories exclu, budget borné', () => {
    process.env.HOME = home;
    process.env.OPERATOR_PROJECT_ROOT = proj;
    const s1 = consultBrainSync([]);
    expect(s1).toContain('- specs/a.md : Contrat alpha — invariants de tri.');
    expect(s1).toContain('- operator.md : Instructions de test');
    expect(s1).toContain('- notes.md : Notes globales');
    expect(s1).not.toContain('memories.md');
    expect(s1).not.toContain('---');
    // Budget : troncature propre, le début est conservé.
    expect(s1.length).toBeLessThan(2600);
    expect(s1).toContain('…[tronqué');
    expect(s1).toContain('f05.md');
    expect(s1).not.toContain('f39.md');
    // Cache : sans changement, même résultat (aucune relecture).
    expect(consultBrainSync([])).toBe(s1);
    // Changement de contenu → fingerprint mtime → reconstruction.
    write(
      join(specsDir, 'a.md'),
      '---\ndescription: Contrat alpha revise.\nread_if: X.\n---\n\n# Titre\n',
    );
    const s2 = consultBrainSync([]);
    expect(s2).toContain('- specs/a.md : Contrat alpha revise.');
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProj === undefined) delete process.env.OPERATOR_PROJECT_ROOT;
    else process.env.OPERATOR_PROJECT_ROOT = savedProj;
    rmSync(tmp, { recursive: true, force: true });
  });
});
