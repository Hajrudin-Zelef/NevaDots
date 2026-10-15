import { homedir } from 'node:os';
import { join, normalize, relative, sep } from 'node:path';
import { promises as fs } from 'node:fs';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
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

async function readIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** Liste les fichiers .md d'une partition (récursif, borné à 100). */
export async function listBrainFiles(
  partition: BrainPartition,
): Promise<string[]> {
  const root = partitionRoot(partition);
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    if (out.length >= 100) return;
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
      let stat: { isDirectory(): boolean };
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.endsWith('.md')) {
        out.push(rel);
      }
    }
  }
  await walk(root, '');
  return out;
}

export async function readBrainFile(
  partition: BrainPartition,
  relPath: string,
): Promise<BrainFile | null> {
  const abs = resolveBrainPath(partition, relPath);
  if (!abs) return null;
  const content = await readIfExists(abs);
  if (content === null) return null;
  return { partition, path: relPath, content };
}

export async function writeBrainFile(
  partition: BrainPartition,
  relPath: string,
  content: string,
): Promise<BrainFile | null> {
  const abs = resolveBrainPath(partition, relPath);
  if (!abs || typeof content !== 'string' || content.length > 100000)
    return null;
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
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
 * Version synchrone de la consultation (phase 8) : le run() de DotAgent
 * est synchrone (Observable), les fichiers sont locaux et petits.
 * Seed + résumé borné en un appel.
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
        mkdirSync(join(abs, '..'), { recursive: true });
        writeFileSync(
          abs,
          `# Mémoires utilisateur\n\n${memories.map((m) => `- ${m}`).join('\n')}\n`,
          'utf8',
        );
      }
    } catch {
      // Seed optionnel : le cerveau reste vide.
    }
  }
  // Résumé borné des 3 partitions.
  const parts: string[] = [];
  for (const partition of ['user', 'project', 'shared'] as const) {
    const proot = partitionRoot(partition);
    const files: string[] = [];
    try {
      const walk = (dir: string, prefix: string): void => {
        if (files.length >= 100) return;
        for (const entry of readdirSync(dir).sort()) {
          if (files.length >= 100) return;
          if (entry.startsWith('.')) continue;
          const abs = join(dir, entry);
          const rel = prefix ? `${prefix}/${entry}` : entry;
          try {
            if (statSync(abs).isDirectory()) walk(abs, rel);
            else if (entry.endsWith('.md')) files.push(rel);
          } catch {
            continue;
          }
        }
      };
      walk(proot, '');
    } catch {
      continue;
    }
    if (!files.length) continue;
    const lines = [`[${partition}]`];
    const indexFile = files.find(
      (f) =>
        f.toLowerCase() === 'index.md' || f.toLowerCase().endsWith('/index.md'),
    );
    if (indexFile) {
      try {
        const content = readFileSync(join(proot, indexFile), 'utf8');
        lines.push(
          content.length > PARTITION_BUDGET
            ? `${content.slice(0, PARTITION_BUDGET)}\n…[tronqué]`
            : content,
        );
      } catch {
        // Index illisible : on liste seulement.
      }
    }
    lines.push(`Fichiers : ${files.join(', ')}`);
    parts.push(lines.join('\n'));
  }
  return parts.length ? parts.join('\n\n') : 'aucun';
}
