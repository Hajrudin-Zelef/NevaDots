import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_FILES,
  AVATAR_QUALITY_FPS,
  AVATAR_STATE_FILES,
} from '../src/shared/avatars.js';

/**
 * Garde-fou des assets d'avatar : le manifeste partagé ne doit référencer que
 * des fichiers réellement présents, à chaque palier. Un clip renommé ou un
 * palier oublié casserait la mascotte silencieusement (404 sur un WebP).
 */
const DOTS = join(__dirname, '..', 'public', 'dots');

function tierName(file: string, quality: 'low' | 'standard' | 'high') {
  if (quality === 'high' || !file.endsWith('.webp')) return file;
  return file.replace(/\.webp$/, `.${AVATAR_QUALITY_FPS[quality]}.webp`);
}

function declaredFiles(): string[] {
  const files = new Set<string>();
  for (const file of Object.values(AVATAR_FILES)) files.add(file);
  for (const states of Object.values(AVATAR_STATE_FILES)) {
    for (const value of Object.values(states ?? {})) {
      for (const file of Array.isArray(value) ? value : [value])
        files.add(file);
    }
  }
  return [...files];
}

describe('assets d’avatar', () => {
  it('chaque fichier du manifeste existe (tous les paliers webp)', () => {
    const missing: string[] = [];
    for (const file of declaredFiles()) {
      for (const quality of ['high', 'standard', 'low'] as const) {
        const name = tierName(file, quality);
        if (!existsSync(join(DOTS, name))) missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it('les posters animés sont légers', () => {
    for (const id of Object.keys(AVATAR_STATE_FILES)) {
      const dir = (AVATAR_FILES[id as keyof typeof AVATAR_FILES] ?? '').replace(
        /\/[^/]+$/,
        '',
      );
      const poster = join(DOTS, dir, 'poster.webp');
      expect(existsSync(poster), poster).toBe(true);
      expect(statSync(poster).size, poster).toBeLessThanOrEqual(25 * 1024);
    }
  });

  it('le logo public est un WebP léger', () => {
    const logo = join(__dirname, '..', 'public', 'logo.webp');
    expect(existsSync(logo)).toBe(true);
    expect(statSync(logo).size).toBeLessThanOrEqual(40 * 1024);
  });
});
