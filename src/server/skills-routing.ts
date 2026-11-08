/**
 * Routage skills (usage auto sur le fond, silence sur les banalités).
 *
 * Pur et déterministe : aucune I/O, aucune dépendance. Le serveur suggère
 * 1 à 3 skills à partir du texte utilisateur ; le modèle garde le dernier
 * mot via `search_skills` / `load_skill`. La suggestion est injectée comme
 * DONNÉE dans le prompt, jamais comme instruction système.
 */

/** Les 5 maillons de la méthode quotidienne, dans l'ordre de la chaîne. */
export const WORKFLOW_SKILL_IDS = [
  'mattpocock-skills/grill-with-docs',
  'mattpocock-skills/to-spec',
  'mattpocock-skills/implement',
  'mattpocock-skills/tdd',
  'mattpocock-skills/diagnosing-bugs',
] as const;

export interface SuggestedSkill {
  id: string;
  /** Une ligne FR : pourquoi ce skill pour cette demande. */
  why: string;
}

/** Nombre max de suggestions injectées (budgets contexte). */
export const MAX_SUGGESTIONS = 3;

interface Route {
  id: string;
  why: string;
  triggers: string[];
  patterns: RegExp[];
}

const ROUTES: Route[] = [
  {
    id: 'mattpocock-skills/grill-with-docs',
    why: 'cadrer et challenger le plan avant tout code',
    triggers: [
      'reflech',
      'avis',
      'architect',
      'concev',
      'design',
      'plan',
      'strateg',
      'choix',
      'decis',
      'brainstorm',
      'discut',
      'idee',
      'propos',
    ],
  },
  {
    id: 'mattpocock-skills/to-spec',
    why: 'figer le plan validé en spec',
    triggers: [
      'spec',
      'formalise',
      'cahier',
      'redige',
      'ecris.*spec',
      'tickets?',
    ],
  },
  {
    id: 'mattpocock-skills/implement',
    why: 'exécuter à partir de la spec',
    triggers: [
      'implement',
      'cree',
      'ajoute',
      'developp',
      'construis',
      'construire',
      'fonctionnalite',
      'feature',
      'refactor',
      'code',
      'script',
      'programme',
    ],
  },
  {
    id: 'mattpocock-skills/tdd',
    why: 'tester en red-green-refactor',
    triggers: [
      'test',
      'tdd',
      'red-green',
      'couverture',
      'coverage',
      'corrige',
      'regression',
    ],
  },
  {
    id: 'mattpocock-skills/diagnosing-bugs',
    why: 'diagnostiquer avant tout correctif aveugle',
    triggers: [
      'debug',
      'debog',
      'diagnos',
      'erreur',
      'stacktrace',
      'trace',
      'plantage',
      'crash',
      'lent',
      'lenteur',
      'perf',
      'marche pas',
      'fonctionne pas',
      'echoue',
      'bog',
    ],
  },
];

/** Banalités : saluts, mercis, acquiescements — jamais de skill. */
const SMALL_TALK =
  /^(bonjour|salut|coucou|hello|hi|hey|yo|merci|thanks|ok|okay|oui|non|d.?accord|super|parfait|top|genial|bravo|au revoir|adieu|bye|a plus|ca va|ça va|bien|et toi|stp|svp)(\s+(beaucoup|bien|infiniment|pour (ton|votre) aide))?\W*$/;

/** Normalise : minuscules, sans accents, espaces resserrés. */
export function normalizeForRouting(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Vrai pour les banalités (salut, merci, réponse courte) : pas de skill. */
export function isTrivialRequest(text: string): boolean {
  const normalized = normalizeForRouting(text);
  if (!normalized) return true;
  if (normalized.length <= 40 && SMALL_TALK.test(normalized)) return true;
  // Message très court sans aucun marqueur de tâche.
  if (normalized.length < 12) return true;
  return false;
}

for (const route of ROUTES)
  route.patterns = route.triggers.map((trigger) => new RegExp(trigger));

/** 0 à 3 suggestions, dans l'ordre de la chaîne (dédupliquées). */
export function suggestSkills(
  text: string,
  max: number = MAX_SUGGESTIONS,
): SuggestedSkill[] {
  const normalized = normalizeForRouting(text);
  if (!normalized || isTrivialRequest(text)) return [];
  const found: SuggestedSkill[] = [];
  for (const route of ROUTES) {
    if (found.length >= max) break;
    if (route.patterns.some((pattern) => pattern.test(normalized)))
      found.push({ id: route.id, why: route.why });
  }
  return found;
}
