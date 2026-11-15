import type { ActivityKind } from '../shared/activity';
import type { AgentStep } from './useAgentSteps';

/**
 * Rendu des appels d'outils (façon OpenCode) : un nom court, une icône et
 * un aperçu d'argument par ligne. Module pur — aucun React, aucun DOM —
 * pour que les libellés et les troncatures soient testables seuls.
 */

/** Famille d'affichage (détermine l'icône et le libellé). */
export type ToolIconKind =
  | 'edit'
  | 'shell'
  | 'read'
  | 'list'
  | 'search'
  | 'web'
  | 'pdf'
  | 'image'
  | 'type'
  | 'file'
  | 'other';

/** Libellés affichés (interface en français ; le code reste en anglais). */
export const TOOL_LABELS: Record<ToolIconKind, string> = {
  edit: 'Édition',
  shell: 'Shell',
  read: 'Lecture',
  list: 'Liste',
  search: 'Recherche',
  web: 'Page web',
  pdf: 'PDF',
  image: 'Image',
  type: 'Frappe',
  file: 'Fichier',
  other: 'Outil',
};

/**
 * Nom d'outil → famille d'affichage. Les noms viennent du serveur
 * (`computer_*`, pages, web, PDF…) ; ce qui n'est pas listé retombe sur
 * `ActivityKind`, puis sur le nom brut de l'outil.
 */
const TOOL_KINDS: Record<string, ToolIconKind> = {
  computer_files_write: 'edit',
  computer_files_read: 'read',
  computer_files_list: 'list',
  computer_files_delete: 'edit',
  computer_exec: 'shell',
  computer_type: 'type',
  computer_snapshot: 'image',
  create_space_page: 'edit',
  edit_space_page: 'edit',
  read_space_page: 'read',
  list_space_pages: 'list',
  search_web: 'search',
  web_search: 'search',
  web_fetch: 'web',
  read_public_page: 'web',
  read_pdf: 'pdf',
  pdf_edit: 'pdf',
  pdf_ocr: 'pdf',
  generate_file: 'file',
  generate_image: 'image',
};

/** Famille de repli quand seul `ActivityKind` est connu (historique ancien). */
const KIND_FALLBACK: Record<ActivityKind, ToolIconKind> = {
  command: 'shell',
  typing: 'type',
  web: 'web',
  file: 'read',
  search: 'search',
  tool: 'other',
  reasoning: 'other',
  task: 'other',
};

/** Famille d'affichage d'une étape (nom d'outil prioritaire). */
export function iconKindForStep(step: AgentStep): ToolIconKind {
  const byName = step.toolName ? TOOL_KINDS[step.toolName] : undefined;
  if (byName) return byName;
  // Une écriture de fichier sans nom connu reste une édition, pas une lecture.
  if (step.kind === 'file' && step.verb === 'Modifié') return 'edit';
  if (step.kind) return KIND_FALLBACK[step.kind] ?? 'other';
  return 'other';
}

/** Libellé de la ligne : libellé français, ou nom brut pour l'inconnu. */
export function labelForStep(step: AgentStep): string {
  const kind = iconKindForStep(step);
  if (kind === 'other') return step.toolName ?? step.label;
  return TOOL_LABELS[kind];
}

/** `+N −M` d'une édition (compteurs seuls, jamais le contenu). */
export function diffForStep(step: AgentStep): string | undefined {
  if (step.addedLines === undefined) return undefined;
  return step.removedLines === undefined
    ? `+${step.addedLines}`
    : `+${step.addedLines} −${step.removedLines}`;
}

/**
 * Aperçu d'argument sur une ligne : le résumé typé de `summarizeToolCall`
 * (chemin, commande, requête — déjà tronqué), sans le diff qui est rendu
 * à part. `undefined` quand il n'y a rien à montrer.
 */
export function previewForStep(step: AgentStep): string | undefined {
  const subtitle = step.subtitle?.trim();
  if (!subtitle) return undefined;
  const diff = diffForStep(step);
  if (!diff) return subtitle;
  // Le résumé d'édition est « chemin · +N −M » : on retire le diff.
  const withoutDiff = subtitle
    .replace(new RegExp(`\\s*·\\s*${escapeRegExp(diff)}$`), '')
    .trim();
  return withoutDiff || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** En-tête replié/déplié : « 23 outils utilisés », « 1 outil utilisé ». */
export function usedToolsLabel(count: number): string {
  const total = Math.max(0, Math.trunc(count));
  return total === 1 ? '1 outil utilisé' : `${total} outils utilisés`;
}

/**
 * Pastille live : « 1 Shell » quand les appels en cours partagent la même
 * famille, « 2 outils » sinon. `null` quand plus rien ne tourne.
 */
export function runningPillLabel(steps: AgentStep[]): string | null {
  const running = steps.filter((step) => step.status === 'running');
  if (!running.length) return null;
  const kinds = new Set(running.map((step) => iconKindForStep(step)));
  const [onlyKind] = [...kinds];
  if (kinds.size === 1 && onlyKind !== 'other')
    return `${running.length} ${TOOL_LABELS[onlyKind]}`;
  return `${running.length} outil${running.length > 1 ? 's' : ''}`;
}
