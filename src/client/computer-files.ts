/** Helpers purs du navigateur de fichiers du computer (testables sans React). */

export interface ComputerFileEntry {
  path: string;
  kind: string;
  bytes?: number;
}

/** Un dossier, que le conteneur nomme `folder` (l'UI historique disait `dir`). */
export function isFileDir(entry: { kind: string }): boolean {
  return entry.kind === 'dir' || entry.kind === 'folder';
}

/** Usage disque approximatif de la liste (bytes renseignés uniquement).
 * La liste est récursive côté conteneur : le total vaut pour tout le
 * workspace quel que soit le dossier affiché. */
export function summarizeFiles(entries: ComputerFileEntry[]): {
  files: number;
  bytes: number;
  sized: boolean;
} {
  let files = 0;
  let bytes = 0;
  let sized = true;
  for (const entry of entries) {
    if (isFileDir(entry)) continue;
    files++;
    if (typeof entry.bytes === 'number') bytes += entry.bytes;
    else sized = false;
  }
  return { files, bytes, sized };
}

/** Dossiers d'abord, puis ordre alphabétique FR insensible à la casse. */
export function sortFileEntries(
  entries: ComputerFileEntry[],
): ComputerFileEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = isFileDir(a) ? 0 : 1;
    const bDir = isFileDir(b) ? 0 : 1;
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
