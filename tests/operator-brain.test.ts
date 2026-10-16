import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  consultBrainSync,
  formatBrainSummary,
  resolveBrainPath,
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
