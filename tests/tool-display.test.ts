import { expect, it } from 'vitest';
import {
  TOOL_LABELS,
  diffForStep,
  iconKindForStep,
  labelForStep,
  previewForStep,
  runningPillLabel,
  usedToolsLabel,
} from '../src/client/tool-display';
import type { AgentStep } from '../src/client/useAgentSteps';

function step(partial: Partial<AgentStep> & { id: string }): AgentStep {
  return { label: 'Étape', status: 'done', ...partial };
}

it('libellés français, code en anglais', () => {
  expect(TOOL_LABELS.edit).toBe('Édition');
  expect(TOOL_LABELS.shell).toBe('Shell');
  expect(TOOL_LABELS.read).toBe('Lecture');
  expect(TOOL_LABELS.search).toBe('Recherche');
  expect(TOOL_LABELS.web).toBe('Page web');
});

it('déduit la famille du nom d’outil', () => {
  expect(iconKindForStep(step({ id: 'a', toolName: 'computer_exec' }))).toBe(
    'shell',
  );
  expect(
    iconKindForStep(step({ id: 'a', toolName: 'computer_files_write' })),
  ).toBe('edit');
  expect(
    iconKindForStep(step({ id: 'a', toolName: 'computer_files_read' })),
  ).toBe('read');
  expect(iconKindForStep(step({ id: 'a', toolName: 'edit_space_page' }))).toBe(
    'edit',
  );
  expect(iconKindForStep(step({ id: 'a', toolName: 'search_web' }))).toBe(
    'search',
  );
  expect(iconKindForStep(step({ id: 'a', toolName: 'web_fetch' }))).toBe('web');
  expect(iconKindForStep(step({ id: 'a', toolName: 'read_pdf' }))).toBe('pdf');
  expect(iconKindForStep(step({ id: 'a', toolName: 'generate_image' }))).toBe(
    'image',
  );
  expect(iconKindForStep(step({ id: 'a', toolName: 'computer_type' }))).toBe(
    'type',
  );
});

it('retombe sur `kind` quand le nom est inconnu (historique ancien)', () => {
  expect(iconKindForStep(step({ id: 'a', kind: 'command' }))).toBe('shell');
  expect(iconKindForStep(step({ id: 'a', kind: 'search' }))).toBe('search');
  expect(iconKindForStep(step({ id: 'a', kind: 'web' }))).toBe('web');
  expect(iconKindForStep(step({ id: 'a', kind: 'typing' }))).toBe('type');
  expect(iconKindForStep(step({ id: 'a', kind: 'file' }))).toBe('read');
  // Une écriture de fichier reste une édition, pas une lecture.
  expect(
    iconKindForStep(step({ id: 'a', kind: 'file', verb: 'Modifié' })),
  ).toBe('edit');
});

it('outil inconnu : nom brut en libellé', () => {
  const unknown = step({ id: 'a', toolName: 'brain_write', label: 'Mémoire' });
  expect(iconKindForStep(unknown)).toBe('other');
  expect(labelForStep(unknown)).toBe('brain_write');
});

it('aperçu : le diff est retiré du sous-titre (rendu à part)', () => {
  const edit = step({
    id: 'e',
    toolName: 'edit_space_page',
    kind: 'file',
    verb: 'Modifié',
    subtitle: 'auto-scroll.ts · +12 −3',
    addedLines: 12,
    removedLines: 3,
  });
  expect(previewForStep(edit)).toBe('auto-scroll.ts');
  expect(diffForStep(edit)).toBe('+12 −3');
  // Une commande garde son aperçu tel quel.
  const exec = step({
    id: 'c',
    toolName: 'computer_exec',
    subtitle: 'ls -la',
  });
  expect(previewForStep(exec)).toBe('ls -la');
  expect(diffForStep(exec)).toBeUndefined();
  // Sans sous-titre : rien à afficher.
  expect(previewForStep(step({ id: 'x' }))).toBeUndefined();
});

it('diff : +N seul quand le nombre de lignes retirées est inconnu', () => {
  expect(
    diffForStep(step({ id: 'a', addedLines: 4, subtitle: 'f.ts · +4' })),
  ).toBe('+4');
  expect(
    previewForStep(step({ id: 'a', addedLines: 4, subtitle: 'f.ts · +4' })),
  ).toBe('f.ts');
});

it('en-tête : pluriel et singulier', () => {
  expect(usedToolsLabel(0)).toBe('0 outils utilisés');
  expect(usedToolsLabel(1)).toBe('1 outil utilisé');
  expect(usedToolsLabel(23)).toBe('23 outils utilisés');
});

it('pastille : même famille comptée, familles mélangées résumées', () => {
  const same = [
    step({ id: 'a', toolName: 'computer_exec', status: 'running' }),
    step({ id: 'b', toolName: 'computer_exec', status: 'running' }),
  ];
  expect(runningPillLabel(same)).toBe('2 Shell');
  const one = [step({ id: 'a', toolName: 'computer_exec', status: 'running' })];
  expect(runningPillLabel(one)).toBe('1 Shell');
  const mixed = [
    step({ id: 'a', toolName: 'computer_exec', status: 'running' }),
    step({ id: 'b', toolName: 'search_web', status: 'running' }),
  ];
  expect(runningPillLabel(mixed)).toBe('2 outils');
  expect(runningPillLabel([step({ id: 'a', status: 'done' })])).toBeNull();
});
