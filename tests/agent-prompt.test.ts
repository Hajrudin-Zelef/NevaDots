import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  MEMORY_BUDGET,
  PAGE_BUDGET,
  slimMemories,
  slimPageContext,
} from '../src/server/agent-prompt';

const base = {
  dotName: 'Leo',
  instructions: 'Be helpful.',
  memories: [],
  brainSummary: 'aucun',
  page: undefined,
  computerConfigured: false,
  connectedCount: 0,
  connectionActionToolName: 'request_connection_action',
  externalServices: [],
  spaceId: 'space-1',
};

describe('agent-prompt (phase 5)', () => {
  it('slimMemories borne le volume', () => {
    expect(slimMemories([])).toBe('none');
    const big = ['x'.repeat(MEMORY_BUDGET + 500)];
    const slimmed = slimMemories(big);
    expect(slimmed.length).toBeLessThan(MEMORY_BUDGET + 100);
    expect(slimmed).toContain('truncated');
  });

  it('slimPageContext réduit au identité + extrait', () => {
    expect(slimPageContext(undefined)).toBe('none');
    const page = {
      id: 'p1',
      spaceId: 's1',
      parentId: null,
      title: 'Ma page',
      content: 'y'.repeat(PAGE_BUDGET + 500),
      revision: 1,
      createdAt: 0,
      updatedAt: 0,
      sourceThreadId: null,
    };
    const slimmed = slimPageContext(page);
    expect(slimmed).toContain('id=p1');
    expect(slimmed).toContain('Ma page');
    expect(slimmed).toContain('read_space_page');
    expect(slimmed.length).toBeLessThan(PAGE_BUDGET + 300);
  });

  it('buildSystemPrompt est en anglais, compressé, avec persona et flow', () => {
    const prompt = buildSystemPrompt(base);
    // ~250 tokens statiques : bien sous les ~472 d'avant.
    expect(prompt.length).toBeLessThan(2200);
    expect(prompt).toContain('PERSONA');
    expect(prompt).toContain('Demanding mentor');
    expect(prompt).toContain('Never invent');
    expect(prompt).toContain('FLOW');
    expect(prompt).toContain('self-audit');
    expect(prompt).toContain('Role instructions: Be helpful.');
    // Pas de JSON brut injecté.
    expect(prompt).not.toContain('JSON.stringify');
  });

  it('ne fuit pas le contenu complet de la page', () => {
    const secret = 'contenu-secret-' + 'z'.repeat(5000);
    const prompt = buildSystemPrompt({
      ...base,
      page: {
        id: 'p1',
        spaceId: 's1',
        parentId: null,
        title: 'T',
        content: secret,
        revision: 1,
        createdAt: 0,
        updatedAt: 0,
        sourceThreadId: null,
      },
    });
    expect(prompt).not.toContain(secret);
    expect(prompt).toContain(secret.slice(0, 100));
  });
});
