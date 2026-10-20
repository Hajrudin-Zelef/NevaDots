import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SkillSummary } from '../shared/skill-types.js';

/** Un `SKILL.md` plus gros n'est pas un skill raisonnable. */
const MAX_SKILL_MD_CHARS = 400_000;
/** Description gardée en mémoire pour le scoring (affichage borné plus bas). */
const MAX_DESCRIPTION_CHARS = 2000;
/** Bornes d'affichage renvoyées au modèle. */
const SEARCH_DESCRIPTION_CHARS = 400;
/** Contenu renvoyé par défaut au chargement (le fichier reste sur disque). */
export const DEFAULT_SKILL_CONTENT_CHARS = 20_000;
/** Lecture d'une ressource texte via read_skill_file. */
export const DEFAULT_SKILL_FILE_CHARS = 20_000;
const MAX_LISTED_FILES = 500;
const MAX_TOOL_FILES = 40;
/** Ticket de bundle : usage unique, 30 s, lié au Dot et au skill. */
const BUNDLE_TTL_MS = 30_000;
const BUNDLE_CAP = 1000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache']);

export interface IndexedSkill extends SkillSummary {
  /** Dossier du skill (source de vérité sur le host). */
  dir: string;
  /** Chemin du SKILL.md. */
  file: string;
  /** Frontmatter complet (données tierces). */
  descriptionFull: string;
  /** Contenu du SKILL.md (borné à MAX_SKILL_MD_CHARS). */
  content: string;
  /** Hash contenu + arborescence (détecte les changements de ressources). */
  version: string;
  /** Fichiers du skill (chemins relatifs + tailles), bornés. */
  files: { path: string; size: number }[];
  nameTokens: Set<string>;
  descriptionTokens: Set<string>;
  normalizedName: string;
}

function slug(value: string, max = 64): string {
  return (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'skill'
  );
}

const stripAccents = (value: string) =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function tokens(value: string): Set<string> {
  return new Set(
    stripAccents(value)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length > 1) ?? [],
  );
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Premier paragraphe utile du corps (repli quand le frontmatter est muet). */
function bodyExcerpt(content: string, frontmatterEnd: number): string {
  const body = content
    .slice(frontmatterEnd)
    .replace(/^---\s*$/m, '')
    .split(/\n\s*\n/)
    .map((block) => block.replace(/^#+\s*/gm, '').trim())
    .find((block) => block.length > 20);
  return collapse(body ?? '').slice(0, MAX_DESCRIPTION_CHARS);
}

function frontmatterOf(content: string): {
  data: Record<string, unknown>;
  end: number;
} {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return { data: {}, end: 0 };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { data: {}, end: 0 };
  const raw = text.slice(3, end).replace(/^\n/, '');
  try {
    const parsed = parseYaml(raw);
    return {
      data:
        parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)
          : {},
      end: end + 4,
    };
  } catch {
    return { data: {}, end: end + 4 };
  }
}

function walkFiles(dir: string, root: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(full, root, out);
    } else if (entry.isFile()) {
      out.push(relative(root, full));
    }
    if (out.length > 5000) return;
  }
}

function walkSkillFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(full);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        found.push(full);
      }
    }
  };
  visit(root);
  return found;
}

function treeOf(
  content: string,
  dir: string,
): { version: string; files: { path: string; size: number }[] } {
  const paths: string[] = [];
  walkFiles(dir, dir, paths);
  paths.sort();
  const hash = createHash('sha256').update(content);
  const files: { path: string; size: number }[] = [];
  for (const file of paths) {
    try {
      const info = lstatSync(join(dir, file));
      hash.update(`\n${file}:${info.size}`);
      if (files.length < MAX_LISTED_FILES)
        files.push({ path: file.split(sep).join('/'), size: info.size });
    } catch {
      // Fichier disparu pendant le scan : le hash reste stable pour les autres.
    }
  }
  return { version: hash.digest('hex'), files };
}

function readSkill(
  file: string,
  libraryRoot: string,
): IndexedSkill | undefined {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  if (content.length > MAX_SKILL_MD_CHARS)
    content = content.slice(0, MAX_SKILL_MD_CHARS);
  const { data, end } = frontmatterOf(content);
  const dir = dirname(file);
  const fallbackName = dir.split(sep).pop() ?? 'skill';
  const name =
    typeof data.name === 'string' && data.name.trim()
      ? collapse(data.name)
      : fallbackName;
  const described =
    typeof data.description === 'string' ? collapse(data.description) : '';
  const descriptionFull = (
    described.length >= 8 ? described : bodyExcerpt(content, end)
  ).slice(0, MAX_DESCRIPTION_CHARS);
  const relativeDir = relative(libraryRoot, dir).split(sep);
  const repo = relativeDir[0] || 'local';
  const id = `${slug(repo)}/${slug(name)}`;
  const tree = treeOf(content, dir);
  return {
    id,
    name,
    repo,
    description: descriptionFull.slice(0, SEARCH_DESCRIPTION_CHARS),
    descriptionFull,
    dir,
    file,
    content,
    version: tree.version,
    files: tree.files,
    nameTokens: tokens(name),
    descriptionTokens: tokens(descriptionFull),
    normalizedName: stripAccents(name).toLowerCase(),
  };
}

export class SkillLibrary {
  private skills = new Map<string, IndexedSkill>();
  private skipped = 0;
  private loadedAt = 0;
  private root: string;
  private bundles = new Map<
    string,
    { skillId: string; dotId: string; expiresAt: number }
  >();

  constructor(root = 'data/skills') {
    this.root = resolve(root);
    this.reindex();
  }

  get size(): number {
    return this.skills.size;
  }
  get path(): string {
    return this.root;
  }
  get lastLoadedAt(): number {
    return this.loadedAt;
  }
  get skippedCount(): number {
    return this.skipped;
  }

  /** Rescanne la bibliothèque. Retourne le nombre de skills indexés. */
  reindex(): number {
    const next = new Map<string, IndexedSkill>();
    let skipped = 0;
    for (const file of walkSkillFiles(this.root)) {
      const skill = readSkill(file, this.root);
      if (!skill) {
        skipped++;
        continue;
      }
      if (next.has(skill.id)) {
        skipped++;
        continue;
      }
      next.set(skill.id, skill);
    }
    this.skills = next;
    this.skipped = skipped;
    this.loadedAt = Date.now();
    return next.size;
  }

  get(id: string): IndexedSkill | undefined {
    return this.skills.get(id);
  }

  list(limit = 20): SkillSummary[] {
    return [...this.skills.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, Math.max(0, limit))
      .map(({ id, name, repo, description }) => ({
        id,
        name,
        repo,
        description,
      }));
  }

  /**
   * Recherche déterministe sur nom + description. Les requêtes gagnent à
   * être en anglais (les descriptions le sont) ; les accents sont ignorés.
   */
  search(query: string, limit = 5): SkillSummary[] {
    const normalized = stripAccents(query).toLowerCase().trim();
    const queryTokens = [...tokens(query)];
    if (!normalized || !queryTokens.length) return [];
    const scored: { skill: IndexedSkill; score: number }[] = [];
    for (const skill of this.skills.values()) {
      let score = 0;
      if (skill.normalizedName === normalized) score += 20;
      else if (skill.normalizedName.includes(normalized)) score += 8;
      for (const token of queryTokens) {
        if (skill.nameTokens.has(token)) score += 3;
        else if (skill.descriptionTokens.has(token)) score += 1;
      }
      if (score > 0) scored.push({ skill, score });
    }
    scored.sort(
      (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
    );
    return scored
      .slice(0, Math.min(Math.max(limit, 1), 10))
      .map(({ skill }) => ({
        id: skill.id,
        name: skill.name,
        repo: skill.repo,
        description: skill.description,
      }));
  }

  /** Fichiers du skill, bornés, pour guider l'agent vers scripts/assets. */
  listFiles(
    id: string,
    limit = MAX_TOOL_FILES,
  ): { path: string; size: number }[] {
    return (this.skills.get(id)?.files ?? []).slice(
      0,
      Math.min(Math.max(limit, 1), MAX_TOOL_FILES),
    );
  }

  /**
   * Lit une ressource texte du skill (côté host). Refuse les chemins absolus,
   * `..`, les symlinks et les binaires (NUL dans les 4 premiers Ko).
   */
  readFile(
    id: string,
    relPath: string,
    maxChars = DEFAULT_SKILL_FILE_CHARS,
  ):
    | {
        path: string;
        text: string;
        truncated: boolean;
        totalChars: number;
        binary: boolean;
      }
    | undefined {
    const skill = this.skills.get(id);
    if (!skill) return undefined;
    if (!relPath || relPath.includes('\0')) return undefined;
    const normalized = relPath.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..'))
      return undefined;
    const full = resolve(skill.dir, normalized);
    const inside = relative(skill.dir, full);
    if (!inside || inside.startsWith('..') || inside.startsWith(sep))
      return undefined;
    let info;
    try {
      info = lstatSync(full);
    } catch {
      return undefined;
    }
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    let raw: Buffer;
    try {
      raw = readFileSync(full);
    } catch {
      return undefined;
    }
    const binary = raw.subarray(0, 4096).includes(0);
    if (binary)
      return {
        path: inside.split(sep).join('/'),
        text: '',
        truncated: false,
        totalChars: raw.length,
        binary: true,
      };
    const text = raw.toString('utf8');
    const bounded = text.slice(0, Math.min(Math.max(maxChars, 1), 50_000));
    return {
      path: inside.split(sep).join('/'),
      text: bounded,
      truncated: text.length > bounded.length,
      totalChars: text.length,
      binary: false,
    };
  }

  /** Ticket à usage unique pour télécharger le bundle d'un skill. */
  mintBundle(skillId: string, dotId: string): string {
    const now = Date.now();
    for (const [ticket, entry] of this.bundles)
      if (entry.expiresAt <= now) this.bundles.delete(ticket);
    while (this.bundles.size >= BUNDLE_CAP) {
      const oldest = this.bundles.keys().next();
      if (oldest.done) break;
      this.bundles.delete(oldest.value);
    }
    const ticket = randomBytes(32).toString('hex');
    this.bundles.set(ticket, {
      skillId,
      dotId,
      expiresAt: now + BUNDLE_TTL_MS,
    });
    return ticket;
  }

  consumeBundle(ticket: string): { skillId: string; dotId: string } | null {
    const entry = this.bundles.get(ticket);
    if (!entry) return null;
    this.bundles.delete(ticket);
    if (entry.expiresAt <= Date.now()) return null;
    return { skillId: entry.skillId, dotId: entry.dotId };
  }

  /** Contenu du SKILL.md, borné. `truncated` signale un reste sur disque. */
  content(
    id: string,
    maxChars = DEFAULT_SKILL_CONTENT_CHARS,
  ): { text: string; truncated: boolean; totalChars: number } | undefined {
    const skill = this.skills.get(id);
    if (!skill) return undefined;
    const text = skill.content.slice(0, maxChars);
    return {
      text,
      truncated: skill.content.length > text.length,
      totalChars: skill.content.length,
    };
  }
}
