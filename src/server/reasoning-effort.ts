/**
 * Heuristique déterministe du mode Défaut (auto) : choisit un niveau de
 * raisonnement d'après la requête, sans appel modèle supplémentaire.
 *
 * Règles (documentées, testées dans tests/reasoning-effort.test.ts) :
 * - vide ou salutation/merci isolé → `none` (pas de réflexion à facturer) ;
 * - code ou mot-clé complexe (bug, refactor, architecture, audit, plan,
 *   migration, preuve, debug, SQL/regex, perf/sécu) ou > 1500 car. → `high` ;
 * - très long (> 4000 car.) + code + architecture/audit/migration →
 *   `max` (seul cas où l'auto sort des niveaux courants) ;
 * - question courte (< 300 car., se termine par ?) ou < 120 car. → `low` ;
 * - sinon `medium`.
 *
 * L'auto n'est pas tenu au natif affiché dans le sélecteur : la valeur
 * part telle quelle en `reasoning_effort`, LiteLLM la transmet ou
 * l'ignore proprement selon le modèle.
 */
export type AutoEffort = 'none' | 'low' | 'medium' | 'high' | 'max';

const TRIVIAL_RE =
  /^(bonjour|salut|coucou|hello|hi|bonsoir|merci|thanks|ok|oui|non|ça va|au revoir|à bientôt)[?!.…\s]*$/i;
const HAS_CODE_RE =
  /```|diff --git|Traceback|Error:|at\s+[\w$.]+\s*\(|SELECT\s+.*FROM|function\s+\w+\s*\(|def\s+\w+\s*\(|class\s+\w+|<\/?[a-z][^>]*>/i;
const COMPLEX_RE =
  /bug|erreur|crash|plantage|refactor|architect|audit|migration|plan d['’]action|preuve|démontr|debug|récursion|concurren|race condition|sql|regex|optimis|performance|sécurité|faille|vulnérabilité|dette technique/i;
const HUGE_REFACTOR_RE = /architect|audit|migration|refactor/i;

export function pickAutoReasoningEffort(text: string): AutoEffort {
  const t = text.trim();
  if (!t) return 'none';
  if (t.length < 60 && TRIVIAL_RE.test(t)) return 'none';
  const hasCode = HAS_CODE_RE.test(t);
  const complex = COMPLEX_RE.test(t);
  if (t.length > 4000 && hasCode && HUGE_REFACTOR_RE.test(t)) return 'max';
  if (hasCode || complex || t.length > 1500) return 'high';
  if ((/\?\s*$/.test(t) && t.length < 300) || t.length < 120) return 'low';
  return 'medium';
}
