import { homedir } from 'node:os';
import { join, normalize, relative, sep } from 'node:path';
import { promises as fs } from 'node:fs';
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';

/**
 * Cerveau Operator natif (phase 8) : 3 partitions Markdown.
 * - user : ~/.operator/user/ (règles globales de l'utilisateur)
 * - project : <project>/.operator/ (connaissance privée du projet)
 * - shared : <project>/.operator-shared/ (connaissance partagée du projet)
 * Boucle : consulter → construire → mettre à jour (l'agent via brain_*).
 */

export type BrainPartition = 'user' | 'project' | 'shared';

export function userPartitionRoot(): string {
  return join(homedir(), '.operator', 'user');
}

export function projectRoot(): string {
  return process.env.OPERATOR_PROJECT_ROOT ?? process.cwd();
}

export function partitionRoot(partition: BrainPartition): string {
  switch (partition) {
    case 'user':
      return userPartitionRoot();
    case 'project':
      return join(projectRoot(), '.operator');
    case 'shared':
      return join(projectRoot(), '.operator-shared');
  }
}

/**
 * Valide qu'un chemin reste dans la partition (anti path traversal).
 * Retourne le chemin absolu résolu, ou null si invalide.
 */
export function resolveBrainPath(
  partition: BrainPartition,
  relPath: string,
): string | null {
  if (!relPath || typeof relPath !== 'string') return null;
  // Rejet strict : tout segment '..' est interdit (pas de sanitize).
  const normalized = normalize(relPath);
  if (
    normalized === '..' ||
    normalized.startsWith(`..${sep}`) ||
    normalized.includes(`${sep}..${sep}`) ||
    normalized.includes(`${sep}..`) ||
    normalized.startsWith('/') ||
    !normalized.endsWith('.md')
  )
    return null;
  const root = partitionRoot(partition);
  const resolved = join(root, normalized);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return resolved;
}

export interface BrainFile {
  partition: BrainPartition;
  path: string;
  content: string;
}

/** Plafond de lecture d'un fichier cerveau (1 Mo) — l'écriture est plafonnée à 100 Ko. */
const BRAIN_READ_CAP = 1_000_000;
/** Profondeur maximale des marches du cerveau (anti-boucle). */
const BRAIN_WALK_DEPTH_MAX = 8;

/**
 * Vérifie qu'aucun composant du chemin entre root (exclu) et le parent de abs
 * n'est un symlink. Un composant manquant : échec en lecture (le fichier
 * n'existe pas), toléré en écriture (mkdir le créera — les composants en
 * dessous ne peuvent pas exister). Ne protège pas contre un remplacement
 * entre le contrôle et l'usage (attaquant en course, hors modèle de menace :
 * les symlinks visés sont plantés dans un dépôt cloné) ; le composant final
 * est lui verrouillé par O_NOFOLLOW à l'ouverture.
 */
async function checkAncestorsNoSymlink(
  root: string,
  abs: string,
  allowMissing: boolean,
): Promise<boolean> {
  const parts = relative(root, abs).split(sep).filter(Boolean);
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    try {
      if ((await fs.lstat(cur)).isSymbolicLink()) return false;
    } catch {
      if (!allowMissing) return false;
      return true;
    }
  }
  return true;
}

/**
 * Liste les fichiers .md d'une partition (récursif, borné à 100).
 * Les symlinks ne sont ni suivis ni listés (fail-closed) ; profondeur
 * bornée + ensemble de visités (anti-cycle).
 */
export async function listBrainFiles(
  partition: BrainPartition,
): Promise<string[]> {
  const root = partitionRoot(partition);
  const out: string[] = [];
  const visited = new Set<string>();
  async function walk(
    dir: string,
    prefix: string,
    depth: number,
  ): Promise<void> {
    if (out.length >= 100 || depth > BRAIN_WALK_DEPTH_MAX) return;
    let real: string;
    try {
      real = await fs.realpath(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (out.length >= 100) return;
      if (entry.startsWith('.')) continue;
      const abs = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      let stat: { isDirectory(): boolean; isSymbolicLink(): boolean };
      try {
        stat = await fs.lstat(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(abs, rel, depth + 1);
      } else if (entry.endsWith('.md')) {
        out.push(rel);
      }
    }
  }
  await walk(root, '', 0);
  return out;
}

export async function readBrainFile(
  partition: BrainPartition,
  relPath: string,
): Promise<BrainFile | null> {
  const abs = resolveBrainPath(partition, relPath);
  if (!abs) return null;
  if (!(await checkAncestorsNoSymlink(partitionRoot(partition), abs, false)))
    return null;
  // O_NOFOLLOW : l'ouverture échoue (ELOOP) si la cible finale est un symlink,
  // ce qui ferme la course entre le contrôle et la lecture.
  try {
    const handle = await fs.open(
      abs,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size > BRAIN_READ_CAP) return null;
      const content = await handle.readFile('utf8');
      return { partition, path: relPath, content };
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    return null;
  }
}

export async function writeBrainFile(
  partition: BrainPartition,
  relPath: string,
  content: string,
): Promise<BrainFile | null> {
  const abs = resolveBrainPath(partition, relPath);
  if (!abs || typeof content !== 'string' || content.length > 100000)
    return null;
  const root = partitionRoot(partition);
  if (!(await checkAncestorsNoSymlink(root, abs, true))) return null;
  await fs.mkdir(join(abs, '..'), { recursive: true });
  // Re-vérifie après mkdir (un parent aurait pu être remplacé entre-temps).
  if (!(await checkAncestorsNoSymlink(root, abs, true))) return null;
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  try {
    const handle = await fs.open(
      abs,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
      0o644,
    );
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    return null;
  }
  return { partition, path: relPath, content };
}

export interface BrainSummary {
  partition: BrainPartition;
  files: string[];
  /** Contenu de l'index s'il existe, sinon null. */
  index: string | null;
}

/** Budget caractères par partition dans le résumé injecté au prompt. */
const PARTITION_BUDGET = 4000;

/**
 * Consult (phase 8) : résumé borné des 3 partitions pour le system prompt.
 * L'index (index.md) est prioritaire ; le reste est listé.
 */
export async function loadBrainSummary(): Promise<BrainSummary[]> {
  const summaries: BrainSummary[] = [];
  for (const partition of ['user', 'project', 'shared'] as const) {
    const files = await listBrainFiles(partition);
    let index: string | null = null;
    const indexFile = files.find(
      (f) =>
        f.toLowerCase() === 'index.md' || f.toLowerCase().endsWith('/index.md'),
    );
    if (indexFile) {
      const read = await readBrainFile(partition, indexFile);
      if (read && read.content.length > PARTITION_BUDGET) {
        index = `${read.content.slice(0, PARTITION_BUDGET)}\n…[tronqué]`;
      } else {
        index = read?.content ?? null;
      }
    }
    summaries.push({ partition, files, index });
  }
  return summaries;
}

/** Formate le résumé pour injection dans le system prompt. */
export function formatBrainSummary(summaries: BrainSummary[]): string {
  const parts: string[] = [];
  for (const s of summaries) {
    if (!s.files.length && !s.index) continue;
    const lines = [`[${s.partition}]`];
    if (s.index) lines.push(s.index);
    if (s.files.length) {
      lines.push(`Fichiers : ${s.files.join(', ')}`);
    }
    parts.push(lines.join('\n'));
  }
  return parts.length ? parts.join('\n\n') : 'aucun';
}

/**
 * Migration initiale : si la partition user est vide et que des memories
 * SQLite existent, les écrire dans user/memories.md (une seule fois).
 */
export async function seedUserPartitionFromMemories(
  memories: string[],
): Promise<boolean> {
  if (!memories.length) return false;
  const files = await listBrainFiles('user');
  if (files.length > 0) return false;
  const content = `# Mémoires utilisateur\n\n${memories.map((m) => `- ${m}`).join('\n')}\n`;
  const written = await writeBrainFile('user', 'memories.md', content);
  return written !== null;
}

/**
 * Optimisation tokens (2026-10-16) : cache du résumé cerveau par mtime.
 * Le résumé n'est reconstruit que si un fichier du cerveau a changé.
 */
let brainCacheSlot: { fingerprint: string; summary: string } | null = null;

/** Plafond du résumé compact injecté au prompt : le cerveau peut grossir,
 * le coût en tokens du préfixe CONTEXT ne doit pas. Coupe sur une ligne. */
const CONSULT_BUDGET = 2500;

/** Première ligne significative d'un fichier, nettoyée (≤80 car.).
 * Ne lit que les 1024 premiers octets — pas le fichier entier.
 * Le frontmatter YAML est sauté : on prend `description:` si présent,
 * sinon le premier titre après le bloc. Ne renvoie jamais un `---` nu
 * (sinon le résumé injecte 13 × « --- » d'inutiles au lieu de libellés). */
function brainFileHeadline(abs: string): string {
  const cap = (line: string): string =>
    line.length > 80 ? `${line.slice(0, 80)}…` : line;
  let fd: number | null = null;
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return '';
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const buf = Buffer.alloc(1024);
    const n = readSync(fd, buf, 0, 1024, 0);
    const lines = buf.toString('utf8', 0, n).split('\n');
    if (lines[0]?.trim() === '---') {
      let desc = '';
      for (let i = 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t === '---') {
          if (desc) return cap(desc);
          for (let j = i + 1; j < lines.length; j++) {
            const l = lines[j].replace(/^#+\s*/, '').trim();
            if (l) return cap(l);
          }
          return '';
        }
        if (!desc && /^description:\s*/i.test(t))
          desc = t.replace(/^description:\s*/i, '').trim();
      }
      // Bloc non refermé dans la fenêtre (frontmatter long) : description.
      if (desc) return cap(desc);
    }
    for (const raw of lines) {
      const l = raw.replace(/^#+\s*/, '').trim();
      if (l && l !== '---') return cap(l);
    }
  } catch {
    // Illisible : pas de résumé.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore.
      }
    }
  }
  return '';
}

/**
 * Version synchrone de la consultation (phase 8) : le run() de DotAgent
 * est synchrone (Observable), les fichiers sont locaux et petits.
 * Seed + résumé compact en un appel.
 *
 * Le résumé est un index compact (fichier : libellé — description du
 * frontmatter sinon premier titre) au lieu du contenu complet des
 * index.md — l'agent lit le détail via brain_read quand il en a besoin.
 * memories.md est exclu (déjà injecté via slimMemories dans le prompt,
 * source live = SQLite). Le résumé total est plafonné à CONSULT_BUDGET.
 */
export function consultBrainSync(memories: string[]): string {
  const root = userPartitionRoot();
  // Seed : si la partition user est vide, migrer les memories SQLite.
  const isEmpty = (() => {
    try {
      return readdirSync(root).length === 0;
    } catch {
      return true;
    }
  })();
  if (isEmpty && memories.length > 0) {
    try {
      const abs = resolveBrainPath('user', 'memories.md');
      if (abs) {
        // Ne jamais seeder à travers un symlink (cible écrasée).
        let isLink = false;
        try {
          isLink = lstatSync(abs).isSymbolicLink();
        } catch {
          // Manquant : création normale.
        }
        if (!isLink) {
          mkdirSync(join(abs, '..'), { recursive: true });
          const fd = openSync(
            abs,
            fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_TRUNC |
              fsConstants.O_NOFOLLOW,
            0o644,
          );
          try {
            writeSync(
              fd,
              `# Mémoires utilisateur\n\n${memories.map((m) => `- ${m}`).join('\n')}\n`,
              0,
              'utf8',
            );
          } finally {
            closeSync(fd);
          }
        }
      }
    } catch {
      // Seed optionnel : le cerveau reste vide.
    }
  }
  // Marche des 3 partitions : fichiers + mtimes pour le fingerprint.
  const found: { partition: string; rel: string; abs: string }[] = [];
  const fp: string[] = [];
  for (const partition of ['user', 'project', 'shared'] as const) {
    const proot = partitionRoot(partition);
    try {
      // Symlinks ignorés (ni suivis ni listés) ; profondeur bornée +
      // ensemble de visités (anti-cycle) — comme listBrainFiles.
      const visited = new Set<string>();
      const walk = (dir: string, prefix: string, depth: number): void => {
        if (found.length >= 100 || depth > BRAIN_WALK_DEPTH_MAX) return;
        let real: string;
        try {
          real = realpathSync(dir);
        } catch {
          return;
        }
        if (visited.has(real)) return;
        visited.add(real);
        for (const entry of readdirSync(dir).sort()) {
          if (found.length >= 100) return;
          if (entry.startsWith('.')) continue;
          const abs = join(dir, entry);
          const rel = prefix ? `${prefix}/${entry}` : entry;
          try {
            const st = lstatSync(abs);
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) walk(abs, rel, depth + 1);
            else if (entry.endsWith('.md')) {
              if (partition === 'user' && rel.toLowerCase() === 'memories.md')
                continue;
              found.push({ partition, rel, abs });
              fp.push(`${partition}:${rel}:${st.mtimeMs}`);
            }
          } catch {
            continue;
          }
        }
      };
      walk(proot, '', 0);
    } catch {
      continue;
    }
  }
  const fingerprint = fp.join('|');
  if (brainCacheSlot && brainCacheSlot.fingerprint === fingerprint) {
    return brainCacheSlot.summary;
  }
  // Résumé compact : [partition] + "fichier : première ligne".
  const parts: string[] = [];
  for (const partition of ['user', 'project', 'shared'] as const) {
    const files = found.filter((f) => f.partition === partition);
    if (!files.length) continue;
    const lines = [`[${partition}]`];
    for (const f of files) {
      const head = brainFileHeadline(f.abs);
      lines.push(head ? `- ${f.rel} : ${head}` : `- ${f.rel}`);
    }
    parts.push(lines.join('\n'));
  }
  const summary = parts.length ? parts.join('\n\n') : 'aucun';
  let capped = summary;
  if (summary.length > CONSULT_BUDGET) {
    const cut = summary.lastIndexOf('\n', CONSULT_BUDGET);
    capped = `${summary.slice(0, cut > 0 ? cut : CONSULT_BUDGET)}\n…[tronqué — brain_read pour le reste]`;
  }
  brainCacheSlot = { fingerprint, summary: capped };
  return capped;
}
