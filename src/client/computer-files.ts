/** Helpers purs du navigateur de fichiers du computer (testables sans React). */

export interface ComputerFileEntry {
  path: string;
  kind: string;
  bytes?: number;
}

/** Dossiers d'abord, puis ordre alphabétique FR insensible à la casse. */
export function sortFileEntries(
  entries: ComputerFileEntry[],
): ComputerFileEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.kind === 'dir' ? 0 : 1;
    const bDir = b.kind === 'dir' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.path.localeCompare(b.path, 'fr', { sensitivity: 'base' });
  });
}

/** Dernier segment d'un chemin workspace (`a/b.txt` → `b.txt`). */
export function fileBasename(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base || path;
}

/** Taille lisible FR (`1115` → `1,1 Ko`, `7` → `7 o`). */
export function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1).replace('.', ',')} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
}

/** Dossier parent (`a/b` → `a`, `a` → `''` racine). */
export function parentDir(dir: string): string {
  const clean = dir.replace(/\/+$/, '');
  const index = clean.lastIndexOf('/');
  return index < 0 ? '' : clean.slice(0, index);
}
