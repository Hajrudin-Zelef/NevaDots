export type ThemePreference = 'system' | 'light' | 'dark' | 'hard_dark';
export type ResolvedTheme = 'light' | 'dark' | 'hard_dark';

const themeKey = 'opendots-theme';
const paletteKey = 'opendots-palette';

export interface Palette {
  id: string;
  label: string;
  color: string;
}

/** Palettes d'accent, reprises de l'UI cetas-lite. */
export const PALETTES: Palette[] = [
  { id: 'bleu', label: 'Bleu', color: '#3b87ce' },
  { id: 'violet', label: 'Violet', color: '#8b5cf6' },
  { id: 'vert', label: 'Vert', color: '#22c55e' },
  { id: 'vert_pur', label: 'Vert pur', color: '#00e676' },
  { id: 'bleu_ocean', label: 'Bleu océan', color: '#0ea5e9' },
  { id: 'jaune_or', label: 'Jaune or', color: '#d4a017' },
  { id: 'rouge', label: 'Rouge', color: '#ef4444' },
  { id: 'ocean', label: 'Ocean', color: '#2196f3' },
];

export const DEFAULT_PALETTE = 'bleu';

// The choice for this page, even if storage refuses to keep it.
let chosen: ThemePreference | undefined;
let chosenPalette: string | undefined;

const query = () => window.matchMedia('(prefers-color-scheme: dark)');

// Storage can be unavailable (private windows, blocked site data); the theme
// then follows the system for this visit.
export function themePreference(): ThemePreference {
  if (chosen) return chosen;
  try {
    const value = localStorage.getItem(themeKey);
    if (
      value === 'light' ||
      value === 'dark' ||
      value === 'hard_dark' ||
      value === 'system'
    ) {
      return value;
    }
  } catch {
    // Fall through to the system theme.
  }
  return 'system';
}

export function palettePreference(): string {
  if (chosenPalette) return chosenPalette;
  try {
    const value = localStorage.getItem(paletteKey);
    if (value && PALETTES.some((p) => p.id === value)) return value;
  } catch {
    // Fall through to the default palette.
  }
  return DEFAULT_PALETTE;
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  if (preference === 'hard_dark') return 'hard_dark';
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

const themeColor = (theme: ResolvedTheme) =>
  theme === 'light' ? '#f8f7f4' : theme === 'hard_dark' ? '#0d0d0d' : '#1b1b1b';

function apply() {
  const theme = resolveTheme(themePreference(), query().matches);
  const root = document.documentElement;
  // hard_dark réutilise le thème sombre généré au build (data-theme='dark')
  // et ajoute une surcharge profonde via data-dark='hard'.
  root.dataset.theme = theme === 'hard_dark' ? 'dark' : theme;
  if (theme === 'hard_dark') root.dataset.dark = 'hard';
  else delete root.dataset.dark;
  root.dataset.palette = palettePreference();
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', themeColor(theme));
}

export function setThemePreference(preference: ThemePreference) {
  chosen = preference;
  try {
    if (preference === 'system') localStorage.removeItem(themeKey);
    else localStorage.setItem(themeKey, preference);
  } catch {
    // Applies for this visit only.
  }
  apply();
}

export function setPalettePreference(palette: string) {
  if (!PALETTES.some((p) => p.id === palette)) return;
  chosenPalette = palette;
  try {
    localStorage.setItem(paletteKey, palette);
  } catch {
    // Applies for this visit only.
  }
  apply();
}

export function watchSystemTheme() {
  apply();
  query().addEventListener('change', apply);
}
