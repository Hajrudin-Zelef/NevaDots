import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeGeneratedFilename,
  saveGeneratedFile,
} from '../src/server/generate-file';

// Les tests écrivent dans data/attachments : on isole via cwd temporaire.
const sandbox = mkdtempSync(join(tmpdir(), 'genfile-'));
const origCwd = process.cwd();
process.chdir(sandbox);

afterAll(() => {
  process.chdir(origCwd);
  rmSync(sandbox, { recursive: true, force: true });
});

describe('generate_file', () => {
  it('sanitizeGeneratedFilename bloque le path traversal', () => {
    expect(sanitizeGeneratedFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeGeneratedFilename('..\\..\\secret')).toBe('secret');
    expect(sanitizeGeneratedFilename('/absolu/x.md')).toBe('x.md');
    expect(sanitizeGeneratedFilename('a/b/c.txt')).toBe('c.txt');
    expect(sanitizeGeneratedFilename('')).toBe('fichier.txt');
    expect(sanitizeGeneratedFilename('rapport final.md')).toBe(
      'rapport_final.md',
    );
  });

  it('saveGeneratedFile écrit file + meta.json valides', async () => {
    const meta = await saveGeneratedFile('test.md', '# Hello\n\nContenu.');
    expect(meta.name).toBe('test.md');
    expect(meta.mime).toContain('markdown');
    expect(meta.size).toBeGreaterThan(0);
    // UUID comme répertoire, pas le nom fourni.
    expect(meta.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const dir = join('data', 'attachments', meta.id);
    expect(readFileSync(join(dir, 'file'), 'utf8')).toBe('# Hello\n\nContenu.');
    const saved = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    expect(saved.id).toBe(meta.id);
    expect(saved.name).toBe('test.md');
    // Rattaché dès la création : jamais emporté par le sweep orphelins.
    expect(saved.attachedAt).toBeGreaterThan(0);
    // Un seul dossier créé, nommé par l'UUID.
    expect(readdirSync(join('data', 'attachments'))).toEqual([meta.id]);
  });

  it('saveGeneratedFile refuse les contenus > 5 Mo', async () => {
    const big = 'x'.repeat(6 * 1024 * 1024);
    await expect(saveGeneratedFile('gros.txt', big)).rejects.toThrow(
      /trop volumineux/,
    );
  });
});
