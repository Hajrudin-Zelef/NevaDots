import { describe, expect, it } from 'vitest';
import { StepTracker, stepLabelForTool } from '../src/server/agent-steps';

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

describe('StepTracker (protocole équilibré)', () => {
  it('n’émet qu’un START par libellé actif (appels parallèles)', () => {
    const tracker = new StepTracker();
    expect(tracker.start('a', 'Ordinateur : exec')).toEqual([
      { type: 'started', stepName: 'Ordinateur : exec' },
    ]);
    // Second appel identique en parallèle : pas de doublon (sinon AGUIError).
    expect(tracker.start('b', 'Ordinateur : exec')).toEqual([]);
    // Les deux fins soldent une seule fois.
    expect(tracker.end('a')).toEqual([]);
    expect(tracker.end('b')).toEqual([
      { type: 'finished', stepName: 'Ordinateur : exec' },
    ]);
  });

  it('ignore les fins sans début et solde les étapes orphelines', () => {
    const tracker = new StepTracker();
    expect(tracker.end('inconnu')).toEqual([]);
    tracker.start('a', 'Recherche web');
    tracker.start('b', 'Ordinateur : exec');
    expect(tracker.drain()).toEqual([
      { type: 'finished', stepName: 'Recherche web' },
      { type: 'finished', stepName: 'Ordinateur : exec' },
    ]);
    // Après solde, les fins tardives sont ignorées (pas de doublon).
    expect(tracker.end('a')).toEqual([]);
    expect(tracker.end('b')).toEqual([]);
  });

  it('séquence simple équilibrée', () => {
    const tracker = new StepTracker();
    const events = [
      ...tracker.start('a', 'Recherche web'),
      ...tracker.end('a'),
    ];
    expect(events).toEqual([
      { type: 'started', stepName: 'Recherche web' },
      { type: 'finished', stepName: 'Recherche web' },
    ]);
  });
});
