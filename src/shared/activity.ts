import type { Message, ToolCall } from '@ag-ui/core';
import { isScheduledTaskMessage } from './scheduled-message.js';

/**
 * Derives a human-readable activity feed from the AG-UI message stream.
 * Every assistant tool call (command, website, file, search, MCP tool) and
 * every reasoning block becomes one {@link ActivityEvent}. Purely client-side:
 * the tool calls and their results are already present in `agent.messages`.
 */

export type ActivityKind =
  | 'command'
  | 'typing'
  | 'web'
  | 'file'
  | 'search'
  | 'tool'
  | 'reasoning'
  | 'task';

export type ActivityStatus = 'running' | 'ok' | 'error' | 'stopped';

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  label: string;
  detail: string;
  status: ActivityStatus;
  result?: string;
  error?: string;
}

const RESULT_LIMIT = 800;

/** Limites des résumés typés affichés (jamais d'args bruts : certains
 *  contenus atteignent 100 000 car. et peuvent être sensibles). */
const SUMMARY_QUERY_LIMIT = 60;
const SUMMARY_COMMAND_LIMIT = 80;
const SUMMARY_PATH_LIMIT = 120;

function truncate(value: string, limit = RESULT_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** Supprime les séquences d'échappement ANSI (couleurs terminal). */
export function stripAnsiCodes(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/** Première phrase d'un texte (résumé d'erreur), « Échec » si vide. */
export function firstSentence(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return 'Échec';
  const match = clean.match(/^.*?[.!?…](\s|$)/);
  const sentence = (match ? match[0] : clean).trim();
  return truncate(sentence, 200);
}

function countLines(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return value.split('\n').length;
}

/** Verbe passé du résumé d'étape (« Exploré / Modifié / Exécuté / Utilisé »). */
export type ToolVerb = 'Exploré' | 'Modifié' | 'Exécuté' | 'Utilisé';

function verbForTool(name: string, kind: ActivityKind): ToolVerb {
  if (name === 'computer_exec' || name.endsWith('_exec')) return 'Exécuté';
  if (
    name === 'computer_files_write' ||
    name === 'create_space_page' ||
    name === 'edit_space_page' ||
    name === 'generate_file' ||
    /write|edit|create|update/.test(name)
  )
    return 'Modifié';
  if (
    kind === 'file' ||
    kind === 'search' ||
    kind === 'web' ||
    /read|list|grep|search|recall|fetch|snapshot/.test(name)
  )
    return 'Exploré';
  return 'Utilisé';
}

export interface ToolSummary {
  kind: ActivityKind;
  label: string;
  detail: string;
  verb: ToolVerb;
  /** Résumé typé sûr à afficher (chemin, requête tronquée, compteur). */
  subtitle: string;
  matchCount?: number;
  addedLines?: number;
  removedLines?: number;
  exitCode?: number;
}

function arrayCount(data: Record<string, unknown>): number | undefined {
  for (const key of ['matches', 'results', 'files', 'entries', 'pages']) {
    const value = data[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

/**
 * Résumé typé d'un appel d'outil pour la StepCard (lot 4). Ne reprend
 * jamais le contenu brut des arguments : chemins et requêtes tronqués,
 * contenus texte/fichiers réduits à des compteurs (lignes, caractères).
 */
export function summarizeToolCall(
  name: string,
  params: Record<string, unknown>,
  result?: Record<string, unknown>,
): ToolSummary {
  const { kind, label, detail } = describeTool(name, params);
  const verb = verbForTool(name, kind);
  const path = argString(params, ['path', 'file', 'filename']);
  const query = argString(params, ['query', 'q', 'search']);
  const command = argString(params, ['command', 'cmd', 'script']);
  const url = argString(params, ['url', 'href']);
  const text = argString(params, ['text', 'content', 'input']);
  const newText =
    typeof params.newText === 'string'
      ? params.newText
      : typeof params.new_content === 'string'
        ? params.new_content
        : undefined;
  const oldText =
    typeof params.oldText === 'string'
      ? params.oldText
      : typeof params.old_text === 'string'
        ? params.old_text
        : undefined;
  const data = result ?? {};
  const exitCode =
    typeof data.exitCode === 'number' ? data.exitCode : undefined;
  const summary: ToolSummary = {
    kind,
    label,
    detail,
    verb,
    subtitle: '',
    matchCount: arrayCount(data),
    exitCode,
  };
  if (verb === 'Modifié') {
    // +N −N : lignes ajoutées (nouveau contenu) / retirées (ancien contenu
    // ou compteur du résultat) — des compteurs, jamais le contenu.
    summary.addedLines =
      typeof data.addedLines === 'number'
        ? data.addedLines
        : typeof data.insertions === 'number'
          ? data.insertions
          : (countLines(newText) ?? countLines(text));
    summary.removedLines =
      typeof data.removedLines === 'number'
        ? data.removedLines
        : typeof data.deletions === 'number'
          ? data.deletions
          : countLines(oldText);
    const diff =
      summary.addedLines !== undefined
        ? `+${summary.addedLines}${summary.removedLines !== undefined ? ` −${summary.removedLines}` : ''}`
        : '';
    summary.subtitle = [path ? truncate(path, SUMMARY_PATH_LIMIT) : '', diff]
      .filter(Boolean)
      .join(' · ');
    return summary;
  }
  if (name === 'computer_exec' || kind === 'command') {
    summary.subtitle = command ? truncate(command, SUMMARY_COMMAND_LIMIT) : '';
    return summary;
  }
  if (name === 'computer_type' || kind === 'typing') {
    // Le texte frappé n'est jamais affiché : longueur seulement.
    summary.subtitle =
      typeof text === 'string' && text.length
        ? `Texte (${text.length} car.)`
        : '';
    return summary;
  }
  if (kind === 'search') {
    summary.subtitle = query
      ? `« ${truncate(query, SUMMARY_QUERY_LIMIT)} »`
      : '';
    return summary;
  }
  if (kind === 'web') {
    summary.subtitle = url ? truncate(url, SUMMARY_PATH_LIMIT) : '';
    return summary;
  }
  if (kind === 'file') {
    const totalLines =
      typeof data.totalLines === 'number' ? data.totalLines : undefined;
    summary.subtitle = [
      path ? truncate(path, SUMMARY_PATH_LIMIT) : '',
      totalLines !== undefined ? `${totalLines} lignes` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return summary;
  }
  summary.subtitle = detail ? truncate(detail, SUMMARY_COMMAND_LIMIT) : '';
  return summary;
}

export interface ToolOutcome extends ToolSummary {
  status: ActivityStatus;
  error: string;
}

/**
 * Statut + résumé d'un appel terminé, depuis son message `role:"tool"`.
 * Sans message de résultat l'appel est encore en cours (`running`) : c'est
 * l'appelant (transcript figé) qui le requalifie en `stopped` si besoin.
 */
export function describeToolOutcome(
  name: string,
  params: Record<string, unknown>,
  toolMessage?: (Message & { role: 'tool' }) | undefined,
): ToolOutcome {
  const data = toolMessage ? computerToolResult(toolMessage.content) : {};
  const summary = summarizeToolCall(name, params, data);
  const { status, error } = statusFromResult(data, toolMessage);
  return { ...summary, status, error };
}

export function computerToolResult(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: raw };
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.fromEntries(Object.entries(raw))
    : {};
}

function argString(
  params: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Maps a tool name + arguments to a display kind, French label and detail. */
export function describeTool(
  name: string,
  params: Record<string, unknown>,
): { kind: ActivityKind; label: string; detail: string } {
  const action = name.replace(/^computer_/, '');
  const url = argString(params, ['url', 'href']);
  const path = argString(params, ['path', 'file', 'filename']);
  const query = argString(params, ['query', 'q', 'search']);
  const command = argString(params, ['command', 'cmd', 'script']);
  const text = argString(params, ['text', 'content', 'input']);

  if (name === 'computer_exec' || action === 'exec') {
    return {
      kind: 'command',
      label: 'Commande terminal',
      detail: command ?? '',
    };
  }
  if (name === 'computer_type' || action === 'type') {
    return { kind: 'typing', label: 'Frappe au clavier', detail: text ?? '' };
  }
  if (name === 'computer_files_write' || action === 'files_write') {
    return { kind: 'file', label: 'Écrit un fichier', detail: path ?? '' };
  }
  if (name === 'computer_files_read' || action === 'files_read') {
    return { kind: 'file', label: 'Lit un fichier', detail: path ?? '' };
  }
  if (name === 'computer_files_list' || action === 'files_list') {
    return { kind: 'file', label: 'Liste les fichiers', detail: path ?? '' };
  }
  if (name === 'create_space_page') {
    return { kind: 'file', label: 'Crée une page', detail: path ?? text ?? '' };
  }
  if (name === 'edit_space_page') {
    return { kind: 'file', label: 'Modifie une page', detail: path ?? '' };
  }
  if (name === 'read_space_page') {
    return { kind: 'file', label: 'Lit une page', detail: path ?? '' };
  }
  if (name === 'search_web' || name === 'web_search') {
    return { kind: 'search', label: 'Recherche web', detail: query ?? '' };
  }
  if (name === 'read_public_page' || name === 'web_fetch') {
    return { kind: 'web', label: 'Lit une page web', detail: url ?? '' };
  }
  if (action === 'navigate') {
    return { kind: 'web', label: 'Visite un site', detail: url ?? '' };
  }
  if (
    action === 'click' ||
    action === 'scroll' ||
    action === 'key' ||
    action === 'type'
  ) {
    return {
      kind: 'web',
      label: 'Agit dans la page',
      detail: url ?? text ?? '',
    };
  }
  if (action === 'read' || action === 'snapshot' || action === 'screenshot') {
    return { kind: 'web', label: 'Inspecte la page', detail: url ?? '' };
  }
  return {
    kind: 'tool',
    label: `Outil · ${name}`,
    detail: argString(params, ['summary', 'approvalId']) ?? '',
  };
}

function extractResult(
  kind: ActivityKind,
  data: Record<string, unknown>,
  content: string,
): string {
  if (kind === 'command') {
    if (typeof data.stdout === 'string' && data.stdout.trim())
      return truncate(data.stdout.trim());
    if (typeof data.stderr === 'string' && data.stderr.trim())
      return truncate(data.stderr.trim());
  }
  if (typeof data.content === 'string' && data.content.trim())
    return truncate(data.content.trim());
  if (typeof data.text === 'string' && data.text.trim())
    return truncate(data.text.trim());
  if (typeof data.excerpt === 'string' && data.excerpt.trim())
    return truncate(data.excerpt.trim());
  return content.trim() ? truncate(content.trim()) : '';
}

function statusFromResult(
  data: Record<string, unknown>,
  toolMessage: (Message & { role: 'tool' }) | undefined,
): { status: ActivityStatus; error: string } {
  if (!toolMessage) return { status: 'running', error: '' };
  const error =
    (toolMessage.error && String(toolMessage.error)) ||
    (typeof data.error === 'string' ? data.error : '');
  if (error) return { status: 'error', error };
  if (data.status === 'stopped' || data.reason === 'stop_requested')
    return { status: 'stopped', error: '' };
  const exitCode = data.exitCode;
  if (typeof exitCode === 'number' && exitCode !== 0)
    return { status: 'error', error: `Code de sortie ${exitCode}` };
  if (data.status === 'error')
    return {
      status: 'error',
      error: typeof data.message === 'string' ? data.message : 'Erreur',
    };
  return { status: 'ok', error: '' };
}

export function deriveActivity(messages: Message[]): ActivityEvent[] {
  const toolMessages = new Map<string, Message & { role: 'tool' }>();
  for (const message of messages) {
    if (message.role === 'tool') {
      toolMessages.set(
        message.toolCallId,
        message as Message & { role: 'tool' },
      );
    }
  }
  const events: ActivityEvent[] = [];
  for (const message of messages) {
    if (
      isScheduledTaskMessage(message) &&
      typeof message.content === 'string' &&
      message.content.trim()
    ) {
      events.push({
        id: message.id,
        kind: 'task',
        label: 'Tâche planifiée',
        detail: '',
        status: 'ok',
        result: truncate(message.content.trim()),
      });
      continue;
    }
    if (
      message.role === 'reasoning' &&
      typeof message.content === 'string' &&
      message.content.trim()
    ) {
      events.push({
        id: message.id,
        kind: 'reasoning',
        label: 'Raisonnement',
        detail: '',
        status: 'ok',
        result: truncate(message.content.trim()),
      });
      continue;
    }
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    for (const call of message.toolCalls as ToolCall[]) {
      const params = computerToolResult(call.function.arguments);
      const { kind, label, detail } = describeTool(call.function.name, params);
      const toolMessage = toolMessages.get(call.id);
      const data = toolMessage ? computerToolResult(toolMessage.content) : {};
      const { status, error } = statusFromResult(data, toolMessage);
      const result = toolMessage
        ? extractResult(kind, data, toolMessage.content)
        : '';
      events.push({ id: call.id, kind, label, detail, status, result, error });
    }
  }
  return events;
}

/** Short verb phrase used by the collapsed pill / bubbles. */
export function activityVerb(event: ActivityEvent): string {
  switch (event.kind) {
    case 'command':
      return `exécute : ${event.detail || 'une commande'}`;
    case 'web': {
      const host = event.detail.replace(/^https?:\/\//, '').split('/')[0];
      return `visite ${host || 'un site'}`;
    }
    case 'file':
      return `${event.label.toLowerCase()} ${event.detail || ''}`.trim();
    case 'search':
      return `recherche « ${event.detail || '…'} »`;
    case 'typing':
      return 'frappe du texte';
    case 'reasoning':
      return 'réfléchit';
    case 'task':
      return 'tâche planifiée terminée';
    default:
      return event.label;
  }
}
