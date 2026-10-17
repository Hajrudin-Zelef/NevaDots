import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  parsePageSpec,
  pdfTools,
  readPdfAttachment,
} from '../src/server/pdf-tools';
import { takePendingScreenshots } from '../src/server/computer-screenshots';

// Faux CLI : text → 3000+ car. par page ; render → PNG factice ; autres → échec.
const CLI = [
  '#!/usr/bin/env node',
  'const [cmd, pdf, ...rest] = process.argv.slice(2);',
  'const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : null; };',
  "if (cmd === 'text') { console.log('PAGE ' + flag('--page') + ' ' + 'x'.repeat(3000)); process.exit(0); }",
  "if (cmd === 'render') { require('fs').writeFileSync(flag('--out'), Buffer.from('89504e470d0a1a0a', 'hex')); process.exit(0); }",
  'console.error("usage faux-cli"); process.exit(1);',
].join('\n');

const sandbox = mkdtempSync(join(tmpdir(), 'pdftools-'));
const origCwd = process.cwd();
const origCli = process.env.PDFCRAFT_CLI_PATH;

function makeAttachment(category: 'pdf' | 'text'): string {
  const id = randomUUID();
  const dir = join(sandbox, 'data', 'attachments', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'file'), '%PDF-1.4 fake');
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      id,
      name: 'doc.pdf',
      size: 13,
      mime: 'application/pdf',
      category,
      createdAt: Date.now(),
    }),
  );
  return id;
}

beforeAll(() => {
  const cliPath = join(sandbox, 'pdfcraft-cli');
  writeFileSync(cliPath, CLI);
  chmodSync(cliPath, 0o755);
  process.env.PDFCRAFT_CLI_PATH = cliPath;
  process.chdir(sandbox);
});

afterAll(() => {
  process.chdir(origCwd);
  if (origCli === undefined) delete process.env.PDFCRAFT_CLI_PATH;
  else process.env.PDFCRAFT_CLI_PATH = origCli;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('pdf-tools', () => {
  it('parsePageSpec accepte les formats attendus et borne au cap', () => {
    expect(parsePageSpec('1', 10)).toEqual([1]);
    expect(parsePageSpec('1-3', 10)).toEqual([1, 2, 3]);
    expect(parsePageSpec('2,4', 10)).toEqual([2, 4]);
    expect(parsePageSpec('1,1,2', 10)).toEqual([1, 2]);
    expect(parsePageSpec('1-11', 10)).toBeNull();
    expect(parsePageSpec('0', 10)).toBeNull();
    expect(parsePageSpec('3-1', 10)).toBeNull();
    expect(parsePageSpec('abc', 10)).toBeNull();
    expect(parsePageSpec('1,3', 1)).toBeNull();
  });

  it('pdfTools est absent quand le binaire introuvable', () => {
    process.env.PDFCRAFT_CLI_PATH = join(sandbox, 'inexistant');
    expect(pdfTools('dot-x')).toEqual([]);
    process.env.PDFCRAFT_CLI_PATH = join(sandbox, 'pdfcraft-cli');
    expect(pdfTools('dot-x')).toHaveLength(1);
  });

  it('mode texte : concatène les pages demandées', async () => {
    const id = makeAttachment('pdf');
    const res = await readPdfAttachment('dot-t1', {
      attachmentId: id,
      pages: '1-2',
    });
    expect(res.pages).toEqual([1, 2]);
    expect(String(res.text)).toContain('PAGE 1');
    expect(String(res.text)).toContain('PAGE 2');
  });

  it('mode texte : plafond de 12 000 caractères avec troncature explicite', async () => {
    const id = makeAttachment('pdf');
    const res = await readPdfAttachment('dot-t2', {
      attachmentId: id,
      pages: '1-5',
    });
    const text = String(res.text);
    expect(text.length).toBeLessThan(12_600);
    expect(text).toContain('…[tronqué à 12000 caractères');
  });

  it('mode images : alimente la file de captures du Dot', async () => {
    const id = makeAttachment('pdf');
    const res = await readPdfAttachment('dot-img', {
      attachmentId: id,
      pages: '1,2',
      mode: 'images',
    });
    expect(res.pagesTransmises).toBe(2);
    const shots = takePendingScreenshots('dot-img');
    expect(shots).toHaveLength(2);
    expect(Buffer.from(shots[0], 'base64').subarray(0, 4).toString('hex')).toBe(
      '89504e47',
    );
  });

  it('rejette id non-UUID, inconnu, non-PDF et pages hors cap images', async () => {
    await expect(
      readPdfAttachment('dot-x', { attachmentId: '../../etc' }),
    ).rejects.toThrow('invalide');
    await expect(
      readPdfAttachment('dot-x', { attachmentId: randomUUID() }),
    ).rejects.toThrow('introuvable');
    const txt = makeAttachment('text');
    await expect(
      readPdfAttachment('dot-x', { attachmentId: txt }),
    ).rejects.toThrow("n'est pas un PDF");
    const id = makeAttachment('pdf');
    await expect(
      readPdfAttachment('dot-x', {
        attachmentId: id,
        pages: '1-4',
        mode: 'images',
      }),
    ).rejects.toThrow('invalide');
  });
});
