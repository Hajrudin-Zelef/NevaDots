import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  UI_SCALE_DEFAULT_PERCENT,
  UI_SCALE_MAX_PERCENT,
  UI_SCALE_MIN_PERCENT,
  UI_SCALE_STEP_PERCENT,
  UI_SCALE_STORAGE_KEY,
  clampUiScalePercent,
  parseUiScalePercent,
  stepUiScalePercent,
  uiScaleFactor,
  uiScaleLabel,
} from '../src/client/ui-scale';

/** Document minimal : `--nd-ui-scale` doit être écrit sur `<html>`. */
function stubDocument() {
  const properties: Record<string, string> = {};
  const dataset: Record<string, string> = {};
  vi.stubGlobal('document', {
    documentElement: {
      dataset,
      style: {
        setProperty: (name: string, value: string) => {
          properties[name] = value;
        },
      },
    },
  });
  return { properties, dataset };
}

function stubStorage(initial?: Record<string, string>) {
  const store = new Map(Object.entries(initial ?? {}));
  const writes: string[] = [];
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(`${key}=${value}`);
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
  return { store, writes };
}

it('borne l’échelle à 50–130 % par pas de 5, sans arrondi flottant', () => {
  expect(UI_SCALE_MIN_PERCENT).toBe(50);
  expect(UI_SCALE_MAX_PERCENT).toBe(130);
  expect(UI_SCALE_STEP_PERCENT).toBe(5);
  expect(UI_SCALE_DEFAULT_PERCENT).toBe(100);
  expect(clampUiScalePercent(49)).toBe(50);
  expect(clampUiScalePercent(0)).toBe(50);
  expect(clampUiScalePercent(131)).toBe(130);
  expect(clampUiScalePercent(500)).toBe(130);
  expect(clampUiScalePercent(102)).toBe(100);
  expect(clampUiScalePercent(103)).toBe(105);
  expect(clampUiScalePercent(Number.NaN)).toBe(100);
});

it('relit une valeur stockée quelconque sans casser l’affichage', () => {
  expect(parseUiScalePercent(null)).toBe(100);
  expect(parseUiScalePercent('')).toBe(100);
  expect(parseUiScalePercent('85')).toBe(85);
  expect(parseUiScalePercent('85 %')).toBe(85);
  expect(parseUiScalePercent(' 110 ')).toBe(110);
  expect(parseUiScalePercent('abc')).toBe(100);
  expect(parseUiScalePercent('0')).toBe(100);
  expect(parseUiScalePercent('-20')).toBe(100);
  expect(parseUiScalePercent('999')).toBe(130);
});

it('les deux boutons montent et descendent de 5 % et s’arrêtent aux bornes', () => {
  expect(stepUiScalePercent(100, 1)).toBe(105);
  expect(stepUiScalePercent(100, -1)).toBe(95);
  expect(stepUiScalePercent(130, 1)).toBe(130);
  expect(stepUiScalePercent(50, -1)).toBe(50);
  expect(uiScaleLabel(105)).toBe('105 %');
  expect(uiScaleFactor(85)).toBe(0.85);
  expect(uiScaleFactor(100)).toBe(1);
});

it('applique l’échelle au document (--nd-ui-scale + data-ui-scale)', async () => {
  const { properties, dataset } = stubDocument();
  stubStorage();
  try {
    vi.resetModules();
    const scale = await import('../src/client/ui-scale');
    scale.applyUiScalePercent(115);
    expect(properties['--nd-ui-scale']).toBe('1.15');
    expect(dataset.uiScale).toBe('115');
    // Une valeur hors bornes est ramenée avant d’être écrite.
    scale.applyUiScalePercent(400);
    expect(properties['--nd-ui-scale']).toBe('1.3');
    expect(dataset.uiScale).toBe('130');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('mémorise le choix et notifie les deux rendus (barre + Réglages)', async () => {
  stubDocument();
  const { writes, store } = stubStorage();
  try {
    vi.resetModules();
    const scale = await import('../src/client/ui-scale');
    const seen: number[] = [];
    const unsubscribe = scale.subscribeUiScale(() =>
      seen.push(scale.uiScalePercent()),
    );
    expect(scale.uiScalePercent()).toBe(100);
    scale.setUiScalePercent(95);
    expect(scale.uiScalePercent()).toBe(95);
    expect(store.get(UI_SCALE_STORAGE_KEY)).toBe('95');
    expect(writes).toEqual([`${UI_SCALE_STORAGE_KEY}=95`]);
    scale.setUiScalePercent(100);
    expect(seen).toEqual([95, 100]);
    unsubscribe();
    scale.setUiScalePercent(90);
    expect(seen).toEqual([95, 100]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('reste utilisable quand le stockage refuse (fenêtre privée)', async () => {
  stubDocument();
  const failing = () => {
    throw new Error('SecurityError');
  };
  vi.stubGlobal('localStorage', {
    getItem: failing,
    setItem: failing,
    removeItem: failing,
  });
  try {
    vi.resetModules();
    const scale = await import('../src/client/ui-scale');
    expect(scale.uiScalePercent()).toBe(100);
    // Le choix vaut pour cette visite, même non persisté.
    expect(scale.setUiScalePercent(110)).toBe(110);
    expect(scale.uiScalePercent()).toBe(110);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('public/theme.js applique la même échelle avant la première peinture', () => {
  const preload = readFileSync('public/theme.js', 'utf8');
  // Même clé, mêmes bornes, même variable CSS que le module runtime :
  // sans ça, l’interface s’affiche à 100 % puis saute à la taille choisie.
  expect(preload).toContain(UI_SCALE_STORAGE_KEY);
  expect(preload).toContain('--nd-ui-scale');
  expect(preload).toContain(String(UI_SCALE_MIN_PERCENT));
  expect(preload).toContain(String(UI_SCALE_MAX_PERCENT));
});
