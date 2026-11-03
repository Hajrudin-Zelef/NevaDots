import { describe, expect, it } from 'vitest';
import type { AnyServerTool, ChatMiddlewareConfig } from '@tanstack/ai';
import {
  createToolGroupRuntime,
  filterToolCollisions,
  ToolGroupState,
} from '../src/server/tool-groups.js';

function tool(name: string): AnyServerTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object' },
    execute: async () => ({ ok: true }),
  } as unknown as AnyServerTool;
}

function config(tools: AnyServerTool[]): ChatMiddlewareConfig {
  return {
    messages: [],
    systemPrompts: [],
    tools: tools as ChatMiddlewareConfig['tools'],
  };
}

describe('ToolGroupState', () => {
  it('charge, persiste et expire après le TTL', () => {
    let now = 1_000;
    const state = new ToolGroupState(5_000, () => now);
    expect(state.get('thread')).toEqual(new Set());
    state.load('thread', ['pdf', 'computer']);
    expect(state.get('thread')).toEqual(new Set(['pdf', 'computer']));
    now += 4_999;
    expect(state.has('thread', 'pdf')).toBe(true);
    now += 2;
    expect(state.get('thread')).toEqual(new Set());
  });

  it('efface un thread ou tout l’état', () => {
    const state = new ToolGroupState();
    state.load('a', ['pdf']);
    state.load('b', ['computer']);
    state.clear('a');
    expect(state.get('a')).toEqual(new Set());
    expect(state.has('b', 'computer')).toBe(true);
    state.clearAll();
    expect(state.get('b')).toEqual(new Set());
  });
});

describe('tool groups runtime', () => {
  it('filtre les collisions et réserve le nom load_tools', () => {
    const core = [tool('core'), tool('load_tools')];
    const set = filterToolCollisions(core, {
      pdf: [tool('pdf_edit'), tool('load_tools'), tool('core')],
      computer: [tool('computer_exec')],
    });
    expect(set.available).toEqual(['pdf', 'computer']);
    expect(set.groups.pdf?.map((item) => item.name)).toEqual(['pdf_edit']);
  });

  it('ajoute les outils du groupe au tour suivant, sans doublon', async () => {
    const now = 1_000;
    const state = new ToolGroupState(10_000, () => now);
    const set = filterToolCollisions([tool('core')], {
      pdf: [tool('pdf_edit')],
      computer: [tool('computer_exec')],
    });
    const runtime = createToolGroupRuntime(state, 'thread', set);
    expect(runtime).toBeDefined();
    const loader = runtime!.loader as unknown as {
      execute?: (input: { groups: string[] }) => Promise<unknown>;
    };
    await loader.execute?.({ groups: ['pdf'] });
    expect(state.get('thread')).toEqual(new Set(['pdf']));

    const first = (await runtime!.middleware.onConfig?.(
      {} as never,
      config([tool('core')]),
    )) as { tools: AnyServerTool[] };
    expect(first.tools.map((item) => item.name)).toEqual(['core', 'pdf_edit']);
    const second = await runtime!.middleware.onConfig?.(
      {} as never,
      config(first.tools),
    );
    expect(second).toBeUndefined();
  });

  it('retourne l’erreur exacte load_tools pour un outil non chargé', async () => {
    const state = new ToolGroupState();
    const set = filterToolCollisions([tool('core')], {
      pdf: [tool('pdf_edit')],
      computer: [tool('computer_exec')],
    });
    const runtime = createToolGroupRuntime(state, 'thread', set)!;
    const decision = await runtime.middleware.onBeforeToolCall?.(
      {} as never,
      { toolName: 'computer_exec', tool: undefined } as never,
    );
    expect(decision).toEqual({
      type: 'skip',
      result: {
        error:
          'Tool "computer_exec" is not loaded. Call load_tools with {"groups":["computer"]} first.',
      },
    });
  });

  it('ne crée pas de loader quand aucun groupe n’est disponible', () => {
    const set = filterToolCollisions([tool('core')], {});
    expect(createToolGroupRuntime(new ToolGroupState(), 'thread', set)).toBe(
      undefined,
    );
  });
});
