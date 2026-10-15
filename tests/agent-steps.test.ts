import { describe, expect, it } from 'vitest';
import { stepLabelForTool } from '../src/server/agent-steps';

describe('stepLabelForTool (phase 3)', () => {
  it('mappe les outils connus en français', () => {
    expect(stepLabelForTool('search_web')).toBe('Recherche web');
    expect(stepLabelForTool('read_public_page')).toBe("Lecture d'une page web");
    expect(stepLabelForTool('grep_page')).toBe('Recherche dans une page');
    expect(stepLabelForTool('read_space_page')).toBe("Lecture d'une page");
    expect(stepLabelForTool('create_space_page')).toBe("Création d'une page");
    expect(stepLabelForTool('recall')).toBe('Recherche dans la mémoire');
    expect(stepLabelForTool('recall_search')).toBe('Recherche dans la mémoire');
    expect(stepLabelForTool('external_service_call')).toBe(
      'Appel à un service externe',
    );
  });

  it('préfixe les outils computer_ avec leur action', () => {
    expect(stepLabelForTool('computer_browser_snapshot')).toBe(
      'Ordinateur : browser snapshot',
    );
    expect(stepLabelForTool('computer_')).toBe('Ordinateur');
  });

  it('humanise les outils inconnus en repli', () => {
    expect(stepLabelForTool('my_custom_tool')).toBe('My custom tool');
    expect(stepLabelForTool('')).toBe('Étape');
  });
});
