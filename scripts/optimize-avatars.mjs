#!/usr/bin/env node
/**
 * Dérivés web des clips d'avatar.
 *
 * Les sources (`public/dots/**`) sont l'art privé de l'auteur : ce script ne
 * les lit que pour lire, et n'écrit QUE dans `dist/client/dots/**` (sortie de
 * build, gitignorée). Rien n'est commité, rien n'est poussé.
 *
 * Pourquoi : les clips d'origine pèsent 4,5 à 9,8 Mo chacun (jusqu'à ~20 Mo
 * téléchargés pour un seul tour de mascotte). On produit des paliers légers,
 * avec un budget par fichier et une qualité adaptative : on baisse la qualité
 * jusqu'à rentrer dans le budget, jamais en dessous d'un plancher.
 *
 * Sécurité :
 *   - outil manquant → on saute tout (exit 0) et les originaux restent ;
 *   - ffmpeg/anim_dump en échec sur un fichier → original conservé ;
 *   - dérivé plus lourd que l'original → original conservé ;
 *   - cache dans `data/avatar-cache/` → les rebuilds suivants sont instantanés.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

const ROOT = process.cwd();
const DOTS = join(ROOT, 'dist', 'client', 'dots');
const CACHE = join(ROOT, 'data', 'avatar-cache');
const MANIFEST = join(ROOT, 'src', 'shared', 'avatars.ts');

/** Paliers, du plus léger au plus lourd (l'ordre sert à la détection). */
const TIERS = [
  {
    name: 'low',
    match: /\.12\.webp$/,
    width: 288,
    fps: 8,
    quality: 45,
    budget: 250 * 1024,
  },
  {
    name: 'standard',
    match: /\.15\.webp$/,
    width: 384,
    fps: 10,
    quality: 45,
    budget: 550 * 1024,
  },
  {
    name: 'high',
    match: /\.webp$/,
    width: 448,
    fps: 15,
    quality: 45,
    budget: 1200 * 1024,
  },
];
const QUALITY_FLOOR = 28;
const POSTER_BUDGET = 15 * 1024;
const POSTER_WIDTH = 256;

function tool(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args[0] ?? ''} → ${(result.stderr || result.stdout || '').slice(0, 400)}`,
    );
  return result.stdout ?? '';
}

/** Fichiers réellement référencés par le manifeste partagé. */
function referencedClips() {
  if (!existsSync(MANIFEST)) return null;
  const text = readFileSync(MANIFEST, 'utf8');
  const found = new Set();
  for (const match of text.matchAll(
    /['"]((?:leo|sam|aline)\/[^'"]+\.webp)['"]/g,
  ))
    found.add(match[1]);
  return found.size ? found : null;
}

/** Source fps approximative (première durée de frame, en ms). */
function sourceFrameMs(file) {
  const info = run(tool('webpinfo') ?? 'webpinfo', [file]);
  const durations = [...info.matchAll(/Duration:\s*(\d+)/g)].map((m) =>
    Number(m[1]),
  );
  const positive = durations.filter((value) => value > 0);
  if (!positive.length) return null;
  const sorted = [...positive].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function encodeAnimated(source, target, tier, workDir) {
  const framesDir = join(workDir, 'frames');
  mkdirSync(framesDir, { recursive: true });
  run(tool('anim_dump') ?? 'anim_dump', ['-folder', framesDir, source]);
  const frames = readdirSync(framesDir)
    .filter((name) => name.endsWith('.png'))
    .sort();
  if (frames.length < 2) return false;

  const frameMs = sourceFrameMs(source) ?? 40;
  const step = Math.max(1, Math.round(1000 / tier.fps / frameMs));
  const picked = frames.filter((_, index) => index % step === 0);

  // Séquences continues : ffmpeg s'arrête à la première image manquante.
  const seqDir = join(workDir, 'seq');
  mkdirSync(seqDir, { recursive: true });
  picked.forEach((name, index) =>
    copyFileSync(
      join(framesDir, name),
      join(seqDir, `f${String(index).padStart(4, '0')}.png`),
    ),
  );

  let inputDir = seqDir;
  const first = join(seqDir, 'f0000.png');
  const size = pngSize(first);
  if (size && size.width > tier.width) {
    const scaled = join(workDir, 'scaled');
    mkdirSync(scaled, { recursive: true });
    run(tool('ffmpeg') ?? 'ffmpeg', [
      '-y',
      '-v',
      'error',
      '-start_number',
      '0',
      '-i',
      join(seqDir, 'f%04d.png'),
      '-vf',
      `scale=${tier.width}:${tier.width}:flags=lanczos`,
      join(scaled, 'f%04d.png'),
    ]);
    inputDir = scaled;
  }
  const inputs = readdirSync(inputDir)
    .filter((name) => name.endsWith('.png'))
    .sort()
    .map((name) => join(inputDir, name));
  if (!inputs.length) return false;

  const durationMs = Math.max(16, Math.round(1000 / tier.fps));
  let quality = tier.quality;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    run(tool('img2webp') ?? 'img2webp', [
      '-loop',
      '0',
      '-lossy',
      '-q',
      String(quality),
      '-m',
      '4',
      '-d',
      String(durationMs),
      ...inputs,
      '-o',
      target,
    ]);
    if (!existsSync(target)) return false;
    if (statSync(target).size <= tier.budget) return true;
    quality -= 6;
    if (quality < QUALITY_FLOOR) break;
  }
  return existsSync(target);
}

function encodePoster(source, target) {
  run(tool('cwebp') ?? 'cwebp', [
    '-quiet',
    '-q',
    '72',
    '-resize',
    String(POSTER_WIDTH),
    '0',
    source,
    '-o',
    target,
  ]);
  return existsSync(target);
}

function pngSize(file) {
  try {
    const buffer = readFileSync(file);
    if (buffer.length < 24) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function cacheKey(file, tier, stat) {
  return createHash('sha1')
    .update(
      `${file}:${stat.size}:${stat.mtimeMs}:${tier.width}:${tier.fps}:${tier.budget}`,
    )
    .digest('hex')
    .slice(0, 20);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function main() {
  if (!existsSync(DOTS)) {
    console.warn('[avatars] dist/client/dots absent — rien à faire.');
    return;
  }
  const missing = ['anim_dump', 'img2webp', 'cwebp'].filter(
    (name) => !tool(name),
  );
  if (missing.length) {
    console.warn(
      `[avatars] outils manquants (${missing.join(', ')}) — dérivés non générés, originaux conservés.`,
    );
    return;
  }

  mkdirSync(CACHE, { recursive: true });
  const referenced = referencedClips();
  // Clips débranchés : on ne les sert pas (dist uniquement, sources intactes).
  // Fait AVANT l'encodage — sinon on compresse des fichiers qu'on jette.
  let pruned = 0;
  if (referenced) {
    for (const file of walk(DOTS)) {
      const name = relative(DOTS, file);
      if (!/^(leo|sam)\//.test(name)) continue;
      if (basename(file) === 'poster.webp') continue;
      const base = name.replace(/\.(12|15)\.webp$/, '.webp');
      if (referenced.has(base)) continue;
      rmSync(file, { force: true });
      pruned += 1;
    }
  }
  const files = walk(DOTS).filter((file) => file.endsWith('.webp'));
  const report = [];
  let saved = 0;

  for (const file of files) {
    const stat = statSync(file);
    const name = relative(DOTS, file);
    if (basename(file) === 'poster.webp') {
      if (stat.size <= POSTER_BUDGET) continue;
      const target = `${file}.opt`;
      if (!encodePoster(file, target)) continue;
      if (statSync(target).size < stat.size) {
        saved += stat.size - statSync(target).size;
        renameSync(target, file);
        report.push({ name, before: stat.size, after: statSync(file).size });
      } else rmSync(target, { force: true });
      continue;
    }
    const tier = TIERS.find((candidate) => candidate.match.test(file));
    if (!tier) continue;
    const workDir = join(tmpdir(), `nd-avatar-${process.pid}-${report.length}`);
    // Cache indexé sur la SOURCE (public/dots), pas sur la copie de dist :
    // Vite recrée dist à chaque build, donc son mtime change toujours et
    // le cache ne servirait jamais.
    const source = join(ROOT, 'public', 'dots', name);
    const key = cacheKey(
      name,
      tier,
      existsSync(source) ? statSync(source) : stat,
    );
    const cached = join(CACHE, `${key}.webp`);
    const target = `${file}.opt`;
    let encoded = false;
    try {
      if (existsSync(cached)) {
        copyFileSync(cached, target);
        encoded = true;
      } else {
        rmSync(workDir, { recursive: true, force: true });
        encoded = encodeAnimated(file, target, tier, workDir);
        if (encoded && existsSync(target)) copyFileSync(target, cached);
      }
    } catch (error) {
      console.warn(`[avatars] ${name} : ${error.message} — original conservé.`);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
    if (!encoded || !existsSync(target)) {
      rmSync(target, { force: true });
      continue;
    }
    const after = statSync(target).size;
    // Jamais plus lourd que l'original : dans le doute, on garde la source.
    if (after >= stat.size) {
      rmSync(target, { force: true });
      report.push({ name, before: stat.size, after: stat.size, kept: true });
      continue;
    }
    renameSync(target, file);
    saved += stat.size - after;
    report.push({ name, before: stat.size, after });
  }

  const rows = report
    .filter((row) => !row.kept)
    .sort((a, b) => b.before - a.before)
    .slice(0, 8)
    .map(
      (row) =>
        `  ${row.name.padEnd(28)} ${(row.before / 1048576).toFixed(2)} → ${(row.after / 1048576).toFixed(2)} Mo`,
    );
  if (rows.length)
    console.log(`[avatars] plus gros gains :\n${rows.join('\n')}`);
  console.log(
    `[avatars] ${report.length} clip(s) traité(s), ${pruned} débranché(s) retiré(s), ${(saved / 1048576).toFixed(1)} Mo économisés.`,
  );

  // Budget : un dépassement ne casse jamais le build (les clips restent
  // utilisables). `PERF_BUDGET_STRICT=1` en fait une erreur pour la CI.
  const over = report.filter(
    (row) => !row.kept && row.after > budgetOf(row.name),
  );
  if (over.length) {
    console.warn(
      `[avatars] au-dessus du budget : ${over
        .map((row) => `${row.name} (${(row.after / 1048576).toFixed(2)} Mo)`)
        .join(', ')}`,
    );
    if (process.env.PERF_BUDGET_STRICT === '1') process.exitCode = 1;
  }
}

function budgetOf(name) {
  const tier = TIERS.find((candidate) => candidate.match.test(name));
  return tier?.budget ?? POSTER_BUDGET;
}

main();
