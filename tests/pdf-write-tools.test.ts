import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  pdfEditAttachment,
  pdfOcrAttachment,
  pdfWriteTools,
} from '../src/server/pdf-write-tools';

// Faux pdfcraft : doc_open → {doc:1,pages:5} ; enregistre les étapes ;
// écrit les fichiers `out`/`path` demandés. PDFW_FAIL=<tool> → erreur dure
// (stderr + exit 1), PDFW_FAIL_SOFT=<tool> → objet {"error"} + exit 0.
const FAKE_CLI = [
  '#!/usr/bin/env node',
  "const fs=require('fs'),path=require('path');",
  'const argv=process.argv.slice(2);',
  'const root=argv[argv.indexOf("--root")+1] || ".";',
  'const script=argv[argv.indexOf("--script")+1];',
  'const steps=JSON.parse(fs.readFileSync(script,"utf8"));',
  'const log=process.env.PDFW_LOG||null;',
  'let code=0;',
  'for(const [i,s] of steps.entries()){',
  '  if(log) fs.appendFileSync(log, JSON.stringify({tool:s.tool,args:s.args})+"\\n");',
  '  if(process.env.PDFW_FAIL===s.tool){console.error(`pdfcraft-cli: step ${i+1} (${s.tool}): boom`);code=1;break;}',
  '  if(process.env.PDFW_FAIL_SOFT===s.tool){console.log(JSON.stringify({error:"boom douce"}));break;}',
  '  if(s.tool==="doc_open"){console.log(JSON.stringify({doc:1,pages:5,encrypted:false,editable:true},null,2));continue;}',
  '  if(s.tool==="text_lines"){console.log(JSON.stringify({doc:1,page:s.args.page,lines:[{line:1,text:"Bonjour PDF ligne un"},{line:2,text:"deuxième ligne"},{line:3,text:"BONJOUR truc"}]},null,2));continue;}',
  '  const out=(s.args&&(s.args.out||s.args.path))||null;',
  '  if(out){const abs=path.isAbsolute(out)?out:path.join(root,out);fs.mkdirSync(path.dirname(abs),{recursive:true});fs.writeFileSync(abs,"PDFOUT");}',
  '  console.log(JSON.stringify({doc:1,ok:s.tool,path:out||null},null,2));',
  '}',
  'process.exit(code);',
].join('\n');

// Faux ocrmypdf : copie entrée → sortie, enregistre argv ; OCR_EXIT/OCR_STDERR pour l'échec.
const FAKE_OCR = [
  '#!/usr/bin/env node',
  "const fs=require('fs');",
  'const argv=process.argv.slice(2);',
  'if(process.env.OCR_ARGV) fs.writeFileSync(process.env.OCR_ARGV, JSON.stringify(argv));',
  'if(process.env.OCR_EXIT){console.error(process.env.OCR_STDERR||"boom ocr");process.exit(Number(process.env.OCR_EXIT));}',
  'const [inp,out]=argv.slice(-2);',
  'fs.copyFileSync(inp,out);',
].join('\n');

const sandbox = mkdtempSync(join(tmpdir(), 'pdfwrite-'));
const origCwd = process.cwd();
const origCli = process.env.PDFCRAFT_CLI_PATH;
const origOcr = process.env.OCRMYPDF_PATH;

function makePdfAttachment(category = 'pdf'): string {
  const id = randomUUID();
  const dir = join(sandbox, 'data', 'attachments', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'file'), '%PDF-1.4 fake');
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      id,
      name: 'rapport final.pdf',
      size: 13,
      mime: 'application/pdf',
      category,
      createdAt: Date.now(),
    }),
  );
  return id;
}

function lastSteps(): Array<{ tool: string; args: Record<string, unknown> }> {
  const raw = readFileSync(join(sandbox, 'steps.log'), 'utf8').trim();
  return raw ? raw.split('\n').map((l) => JSON.parse(l)) : [];
}

beforeEach(() => {
  const cliPath = join(sandbox, 'pdfcraft-cli');
  writeFileSync(cliPath, FAKE_CLI);
  chmodSync(cliPath, 0o755);
  const ocrPath = join(sandbox, 'ocrmypdf');
  writeFileSync(ocrPath, FAKE_OCR);
  chmodSync(ocrPath, 0o755);
  process.env.PDFCRAFT_CLI_PATH = cliPath;
  process.env.OCRMYPDF_PATH = ocrPath;
  process.env.PDFW_LOG = join(sandbox, 'steps.log');
  writeFileSync(join(sandbox, 'steps.log'), '');
  delete process.env.PDFW_FAIL;
  delete process.env.PDFW_FAIL_SOFT;
  delete process.env.OCR_EXIT;
  delete process.env.OCR_STDERR;
  delete process.env.OCR_ARGV;
  process.chdir(sandbox);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterAll(() => {
  process.chdir(origCwd);
  if (origCli === undefined) delete process.env.PDFCRAFT_CLI_PATH;
  else process.env.PDFCRAFT_CLI_PATH = origCli;
  if (origOcr === undefined) delete process.env.OCRMYPDF_PATH;
  else process.env.OCRMYPDF_PATH = origOcr;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('pdf_write-tools', () => {
  it('édite : rotate + métadonnées, nouveau fichier rattaché', async () => {
    const id = makePdfAttachment();
    const meta = await pdfEditAttachment({
      attachmentId: id,
      operations: [
        { op: 'rotate', pages: '1-2', degrees: 90 },
        { op: 'metadata', title: 'Neva' },
      ],
    });
    expect(meta.name).toBe('rapport_final-edite.pdf');
    expect(meta.mime).toBe('application/pdf');
    expect(meta.attachedAt).toBeGreaterThan(0);
    expect(
      existsSync(join(sandbox, 'data', 'attachments', meta.id, 'file')),
    ).toBe(true);
    const steps = lastSteps();
    expect(steps.map((s) => s.tool)).toEqual([
      'doc_open',
      'doc_open',
      'page_rotate',
      'doc_set_info',
      'doc_save',
    ]);
    expect(steps[0].args).toEqual({ path: `${id}/file` });
    expect(steps[2].args).toEqual({ doc: 1, degrees: 90, pages: [1, 2] });
    expect(steps[3].args).toEqual({ doc: 1, key: 'Title', value: 'Neva' });
    expect(String((steps[4].args as { path: string }).path)).toMatch(
      /^nevadots-[0-9a-f-]{36}\.pdf$/,
    );
    // Temporaires nettoyés : que des dossiers UUID sous data/attachments.
    for (const entry of readdirSync(join(sandbox, 'data', 'attachments')))
      expect(entry).not.toMatch(/^nevadots-/);
  });

  it('extract produit le fichier extrait, to_docx le docx', async () => {
    const id = makePdfAttachment();
    const ext = await pdfEditAttachment({
      attachmentId: id,
      operations: [{ op: 'extract', pages: '2' }],
    });
    expect(ext.name).toBe('rapport_final-extrait.pdf');
    const docx = await pdfEditAttachment({
      attachmentId: id,
      operations: [{ op: 'to_docx' }],
    });
    expect(docx.name).toBe('rapport_final.docx');
    expect(docx.mime).toContain('wordprocessingml');
    const comp = await pdfEditAttachment({
      attachmentId: id,
      operations: [{ op: 'compress' }],
    });
    expect(comp.name).toBe('rapport_final-compresse.pdf');
    const stamped = await pdfEditAttachment({
      attachmentId: id,
      operations: [{ op: 'add_text', page: 1, text: 'VU' }],
    });
    expect(stamped.name).toBe('rapport_final-edite.pdf');
    const steps = lastSteps();
    const add = steps.find((s) => s.tool === 'page_add_text');
    expect(add?.args).toMatchObject({ doc: 1, page: 1, text: 'VU' });
  });

  it('refuse deux sorties, pages hors plage, fichiers non-PDF', async () => {
    const id = makePdfAttachment();
    await expect(
      pdfEditAttachment({
        attachmentId: id,
        operations: [{ op: 'extract', pages: '1' }, { op: 'to_docx' }],
      }),
    ).rejects.toThrow('sortie');
    await expect(
      pdfEditAttachment({
        attachmentId: id,
        operations: [{ op: 'compress' }, { op: 'to_docx' }],
      }),
    ).rejects.toThrow('combine');
    await expect(
      pdfEditAttachment({
        attachmentId: id,
        operations: [{ op: 'delete', pages: '9' }],
      }),
    ).rejects.toThrow('inexistante');
    await expect(
      pdfEditAttachment({ attachmentId: '../../etc', operations: [] }),
    ).rejects.toThrow();
    const txt = makePdfAttachment('text');
    await expect(
      pdfEditAttachment({ attachmentId: txt, operations: [] }),
    ).rejects.toThrow("n'est pas un PDF");
    await expect(
      pdfEditAttachment({ attachmentId: randomUUID(), operations: [] }),
    ).rejects.toThrow('introuvable');
  });

  it('propage les erreurs CLI (exit ≠ 0 et objet error)', async () => {
    const id = makePdfAttachment();
    process.env.PDFW_FAIL = 'page_rotate';
    await expect(
      pdfEditAttachment({
        attachmentId: id,
        operations: [{ op: 'rotate', pages: '1' }],
      }),
    ).rejects.toThrow('boom');
    delete process.env.PDFW_FAIL;
    process.env.PDFW_FAIL_SOFT = 'doc_save';
    await expect(
      pdfEditAttachment({
        attachmentId: id,
        operations: [{ op: 'rotate', pages: '1' }],
      }),
    ).rejects.toThrow('douce');
  });

  it('outils absents quand les binaires manquent', () => {
    process.env.PDFCRAFT_CLI_PATH = join(sandbox, 'inexistant');
    expect(pdfWriteTools().map((t) => t.name)).toEqual(['pdf_ocr']);
    process.env.OCRMYPDF_PATH = join(sandbox, 'inexistant');
    expect(pdfWriteTools()).toEqual([]);
    process.env.PDFCRAFT_CLI_PATH = join(sandbox, 'pdfcraft-cli');
    process.env.OCRMYPDF_PATH = join(sandbox, 'ocrmypdf');
    expect(pdfWriteTools().map((t) => t.name)).toEqual(['pdf_edit', 'pdf_ocr']);
  });

  it('ocr : fra+eng + skip par défaut, sortie rattachée', async () => {
    const id = makePdfAttachment();
    const argvPath = join(sandbox, 'ocr-argv.json');
    process.env.OCR_ARGV = argvPath;
    const meta = await pdfOcrAttachment({ attachmentId: id });
    expect(meta.name).toBe('rapport_final-ocr.pdf');
    expect(meta.mime).toBe('application/pdf');
    expect(meta.attachedAt).toBeGreaterThan(0);
    expect(
      existsSync(join(sandbox, 'data', 'attachments', meta.id, 'file')),
    ).toBe(true);
    const argv = JSON.parse(readFileSync(argvPath, 'utf8')) as string[];
    expect(argv).toContain('--language');
    expect(argv[argv.indexOf('--language') + 1]).toBe('fra+eng');
    expect(argv).toContain('--skip-text');
    expect(argv).not.toContain('--force-ocr');
  });

  it('ocr : mode force + échec propagé', async () => {
    const id = makePdfAttachment();
    const argvPath = join(sandbox, 'ocr-argv.json');
    process.env.OCR_ARGV = argvPath;
    await pdfOcrAttachment({ attachmentId: id, mode: 'force' });
    const argv = JSON.parse(readFileSync(argvPath, 'utf8')) as string[];
    expect(argv).toContain('--force-ocr');
    process.env.OCR_EXIT = '3';
    process.env.OCR_STDERR = 'plus de mémoire';
    await expect(pdfOcrAttachment({ attachmentId: id })).rejects.toThrow(
      'mémoire',
    );
  });

  it('replace_text : substitue dans les lignes, une seule passe d’écriture', async () => {
    const id = makePdfAttachment();
    const meta = await pdfEditAttachment({
      attachmentId: id,
      operations: [{ op: 'replace_text', find: 'bonjour', replace: 'Salut' }],
    });
    expect(meta.name).toBe('rapport_final-edite.pdf');
    expect(meta.attachedAt).toBeGreaterThan(0);
    const steps = lastSteps();
    // Sonde (1 doc_open) + passe scan (2ᵉ doc_open + text_lines) + passe
    // écriture (3ᵉ doc_open + text_edit×2 + doc_save).
    const opens = steps.filter((s) => s.tool === 'doc_open');
    expect(opens).toHaveLength(3);
    const edits = steps.filter((s) => s.tool === 'text_edit');
    // 5 pages scannées (défaut = toutes), 2 lignes correspondantes chacune.
    expect(edits).toHaveLength(10);
    expect(edits[0].args).toMatchObject({
      doc: 1,
      page: 1,
      line: 1,
      text: 'Salut PDF ligne un',
    });
    expect(edits[1].args).toMatchObject({
      doc: 1,
      page: 1,
      line: 3,
      text: 'Salut truc',
    });
    expect(edits[2].args).toMatchObject({ page: 2, line: 1 });
    expect(steps[steps.length - 1].tool).toBe('doc_save');
    // Temporaires nettoyés.
    for (const entry of readdirSync(join(sandbox, 'data', 'attachments')))
      expect(entry).not.toMatch(/^nevadots-/);
  });

  it('replace_text : zéro occurrence = erreur claire', async () => {
    const id = makePdfAttachment();
    await expect(
      pdfEditAttachment({
        attachmentId: id,
        operations: [{ op: 'replace_text', find: 'absent', replace: 'x' }],
      }),
    ).rejects.toThrow('Aucune occurrence');
  });

  it('replace_text : non combinable avec une autre opération', async () => {
    const id = makePdfAttachment();
    await expect(
      pdfEditAttachment({
        attachmentId: id,
        operations: [
          { op: 'replace_text', find: 'a', replace: 'b' },
          { op: 'rotate', pages: '1' },
        ],
      }),
    ).rejects.toThrow('passe dédiée');
  });
});
