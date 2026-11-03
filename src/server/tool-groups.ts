import type {
  AnyServerTool,
  ChatMiddleware,
  ChatMiddlewareConfig,
} from '@tanstack/ai';
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';

export const TOOL_GROUPS = [
  'research',
  'pdf',
  'computer',
  'external',
  'mcp',
  'skills',
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];

export const TOOL_GROUP_LABELS: Record<ToolGroup, string> = {
  research: 'web research and public page reading',
  pdf: 'read, edit and OCR PDF attachments',
  computer: 'this Dot computer: browser, files and shell',
  external: 'configured external accounts',
  mcp: 'connected MCP tools',
  skills: 'local skills library',
};

const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const LOADER_NAME = 'load_tools';

interface LoadedEntry {
  groups: Set<ToolGroup>;
  expiresAt: number;
}

/**
 * Groupes chargés par thread. Volontairement simple : TTL 24 h, purge à
 * l'accès, nettoyage explicite à la suppression de la conversation.
 */
export class ToolGroupState {
  private readonly entries = new Map<string, LoadedEntry>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(threadId: string): Set<ToolGroup> {
    const entry = this.entries.get(threadId);
    if (!entry) return new Set();
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(threadId);
      return new Set();
    }
    return new Set(entry.groups);
  }

  has(threadId: string, group: ToolGroup): boolean {
    return this.get(threadId).has(group);
  }

  load(threadId: string, groups: Iterable<ToolGroup>): ToolGroup[] {
    const loaded = this.get(threadId);
    for (const group of groups) loaded.add(group);
    this.entries.set(threadId, {
      groups: loaded,
      expiresAt: this.now() + this.ttlMs,
    });
    return [...loaded];
  }

  clear(threadId: string): void {
    this.entries.delete(threadId);
  }

  clearAll(): void {
    this.entries.clear();
  }
}

export interface ToolGroupSet {
  core: AnyServerTool[];
  groups: Partial<Record<ToolGroup, AnyServerTool[]>>;
  available: ToolGroup[];
}

export interface ToolGroupRuntime {
  /** Outil `load_tools` à ajouter au noyau. */
  loader: ToolDefinition;
  /** Middleware à passer à `chat()`. */
  middleware: ChatMiddleware;
  /** Noms d'outils par groupe (diagnostic/tests). */
  toolNames: Partial<Record<ToolGroup, string[]>>;
}

export function filterToolCollisions(
  core: AnyServerTool[],
  groups: Partial<Record<ToolGroup, AnyServerTool[]>>,
): ToolGroupSet {
  const coreNames = new Set(['load_tools', ...core.map((tool) => tool.name)]);
  const seenGroups = new Set<string>();
  const filtered: Partial<Record<ToolGroup, AnyServerTool[]>> = {};
  const available: ToolGroup[] = [];
  for (const group of TOOL_GROUPS) {
    const tools = groups[group];
    if (!tools?.length) continue;
    const kept = tools.filter((tool) => {
      if (coreNames.has(tool.name) || seenGroups.has(tool.name)) {
        console.warn(
          `Tool collision ignored: "${tool.name}" from group "${group}".`,
        );
        return false;
      }
      seenGroups.add(tool.name);
      return true;
    });
    if (!kept.length) continue;
    filtered[group] = kept;
    available.push(group);
  }
  return { core, groups: filtered, available };
}

export function createToolGroupRuntime(
  state: ToolGroupState,
  threadId: string,
  set: ToolGroupSet,
): ToolGroupRuntime | undefined {
  if (!set.available.length) return undefined;
  const groupTools = new Map<ToolGroup, AnyServerTool[]>();
  const toolToGroup = new Map<string, ToolGroup>();
  const toolNames: Partial<Record<ToolGroup, string[]>> = {};
  for (const group of set.available) {
    const tools = set.groups[group] ?? [];
    groupTools.set(group, tools);
    toolNames[group] = tools.map((tool) => tool.name);
    for (const tool of tools) toolToGroup.set(tool.name, group);
  }

  const loader = defineTool({
    name: LOADER_NAME,
    description: `Load tool groups for this chat before using their tools. Available groups: ${set.available
      .map((group) => `${group} (${TOOL_GROUP_LABELS[group]})`)
      .join(', ')}. Loaded groups stay available for this conversation (24 h).`,
    parameters: z.object({
      groups: z
        .array(z.enum(set.available as [ToolGroup, ...ToolGroup[]]))
        .min(1)
        .max(set.available.length),
    }),
    execute: async ({ groups }) => {
      const loaded = state.load(threadId, groups);
      return {
        loaded,
        tools: groups.flatMap((group) => toolNames[group] ?? []),
        note: 'The tools are available in the next iteration. Load only the groups the task needs.',
      };
    },
  });

  const middleware: ChatMiddleware = {
    name: 'nevadots-tool-groups',
    onConfig: (_ctx, config: ChatMiddlewareConfig) => {
      const additions = [...state.get(threadId)].flatMap(
        (group) => set.groups[group] ?? [],
      );
      const names = new Set(config.tools.map((tool) => tool.name));
      const extra = additions.filter((tool) => !names.has(tool.name));
      const messages = rewriteUnknownToolErrors(config.messages, toolToGroup);
      if (!extra.length && messages === config.messages) return;
      return {
        ...(extra.length ? { tools: [...config.tools, ...extra] } : {}),
        ...(messages !== config.messages ? { messages } : {}),
      };
    },
    onBeforeToolCall: (_ctx, hook) => {
      if (hook.tool) return;
      const group = toolToGroup.get(hook.toolName);
      if (group)
        return {
          type: 'skip',
          result: {
            error: `Tool "${hook.toolName}" is not loaded. Call load_tools with {"groups":["${group}"]} first.`,
          },
        };
      return {
        type: 'skip',
        result: {
          error: `Unknown tool "${hook.toolName}". Call load_tools with one of: ${set.available.join(', ')}.`,
        },
      };
    },
  };

  return { loader, middleware, toolNames };
}

function rewriteUnknownToolErrors(
  messages: ChatMiddlewareConfig['messages'],
  toolToGroup: Map<string, ToolGroup>,
): ChatMiddlewareConfig['messages'] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== 'tool') return message;
    const text =
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? '');
    const match = /Unknown tool:\s*['"]?([A-Za-z0-9_.-]+)['"]?/i.exec(text);
    if (!match) return message;
    const group = toolToGroup.get(match[1]);
    if (!group) return message;
    changed = true;
    return {
      ...message,
      content: JSON.stringify({
        error: `Tool "${match[1]}" is not loaded. Call load_tools with {"groups":["${group}"]} first.`,
      }),
    };
  });
  return changed ? next : messages;
}
