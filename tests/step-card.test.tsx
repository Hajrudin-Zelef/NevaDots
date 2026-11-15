import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  firstSentence,
  stripAnsiCodes,
  summarizeToolCall,
} from '../src/shared/activity';
import {
  StepCard,
  groupSteps,
  stepCardTitle,
} from '../src/client/StepCard';
import type { AgentStep } from '../src/client/useAgentSteps';

function step(partial: Partial<AgentStep> & { id: string }): AgentStep {
  return { label: 'Étape', status: 'done', ...partial };
}

it('ne montre jamais les args bruts : contenu long réduit à des compteurs', () => {
  const huge = 'x'.repeat(100_000);
  const summary = summarizeToolCall(
    'computer_files_write',
    { path: '/tmp/notes.md', content: huge },
    {},
  );
  expect(summary.subtitle).not.toContain('xxx');
  expect(summary.subtitle).toContain('/tmp/notes.md');
  expect(summary.addedLines).toBe(1);
  expect(summary.verb).toBe('Modifié');
});

it('résume la frappe par sa longueur seulement, jamais son texte', () => {
  const summary = summarizeToolCall('computer_type', {
    text: 'mot de passe secret',
  });
  expect(summary.subtitle).toBe('Texte (19 car.)');
  expect(summary.subtitle).not.toContain('mot de passe');
});

it('tronque requête et commande, compte les matches et le exit code', () => {
  const search = summarizeToolCall(
    'search_web',
    { query: 'q'.repeat(200) },
    { results: [{}, {}, {}] },
  );
  expect(search.subtitle.length).toBeLessThan(70);
  expect(search.matchCount).toBe(3);
  expect(search.verb).toBe('Exploré');
  const exec = summarizeToolCall(
    'computer_exec',
    { command: `echo ${'a'.repeat(200)}` },
    { exitCode: 1 },
  );
  expect(exec.subtitle.length).toBeLessThan(90);
  expect(exec.exitCode).toBe(1);
  expect(exec.verb).toBe('Exécuté');
});

it('dérive +N −N des edits depuis les compteurs, pas le contenu', () => {
  const summary = summarizeToolCall('edit_space_page', {
    path: 'page.md',
    oldText: 'a\nb\nc',
    newText: 'a\nb\nc\nd\ne',
  });
  expect(summary.addedLines).toBe(5);
  expect(summary.removedLines).toBe(3);
});

it('stripAnsiCodes retire les couleurs terminal, firstSentence résume', () => {
  expect(stripAnsiCodes('\x1b[31merreur\x1b[0m ok')).toBe('erreur ok');
  expect(firstSentence('Première phrase. Deuxième phrase.')).toBe(
    'Première phrase.',
  );
  expect(firstSentence('   ')).toBe('Échec');
  expect(firstSentence('')).toBe('Échec');
});

it('regroupe les lectures consécutives en une ligne, pas les edits', () => {
  const steps = [
    step({
      id: 'r1',
      label: 'Lit un fichier',
      verb: 'Exploré',
      kind: 'file',
      subtitle: '/a.md',
    }),
    step({
      id: 'r2',
      label: 'Lit un fichier',
      verb: 'Exploré',
      kind: 'file',
      subtitle: '/b.md',
    }),
    step({
      id: 'r3',
      label: 'Lit un fichier',
      verb: 'Exploré',
      kind: 'file',
      subtitle: '/c.md',
    }),
    step({
      id: 'e1',
      label: 'Modifie une page',
      verb: 'Modifié',
      kind: 'file',
      subtitle: 'page-a.md',
      addedLines: 12,
      removedLines: 3,
    }),
    step({
      id: 'e2',
      label: 'Modifie une page',
      verb: 'Modifié',
      kind: 'file',
      subtitle: 'page-b.md',
      addedLines: 2,
      removedLines: 0,
    }),
  ];
  const groups = groupSteps(steps);
  expect(groups).toHaveLength(3);
  expect(groups[0].label).toBe('Exploré');
  expect(groups[0].subtitle).toBe('3 fichiers');
  expect(groups[0].steps).toHaveLength(3);
  expect(groups[1].subtitle).toContain('+12 −3');
  expect(groups[2].subtitle).toContain('+2 −0');
});

it('ne regroupe jamais une erreur avec ses voisines', () => {
  const groups = groupSteps([
    step({
      id: 'r1',
      label: 'Lit un fichier',
      verb: 'Exploré',
      kind: 'file',
    }),
    step({
      id: 'bad',
      label: 'Recherche web',
      verb: 'Exploré',
      kind: 'search',
      status: 'error',
      error: 'Timeout. Détail.',
    }),
    step({
      id: 'r2',
      label: 'Lit un fichier',
      verb: 'Exploré',
      kind: 'file',
    }),
  ]);
  expect(groups).toHaveLength(3);
  expect(groups[1].status).toBe('error');
});

it('titre : verbes dédupliqués + détail fichiers/commandes', () => {
  const steps = [
    step({ id: 'a', verb: 'Exploré', kind: 'file' }),
    step({ id: 'b', verb: 'Exploré', kind: 'file' }),
    step({ id: 'c', verb: 'Exploré', kind: 'file' }),
    step({ id: 'd', verb: 'Exécuté', kind: 'command' }),
    step({ id: 'e', verb: 'Exécuté', kind: 'command' }),
  ];
  expect(stepCardTitle(steps)).toBe(
    'Exploré 3 fichiers · Exécuté 2 commandes',
  );
  expect(
    stepCardTitle([step({ id: 'x' }), step({ id: 'y' })]),
  ).toBe('2 outils');
});

it('rend le titre verbe + lignes groupées une fois terminée', () => {
  const html = renderToStaticMarkup(
    <StepCard
      live
      steps={[
        step({ id: 'a', verb: 'Exploré', kind: 'file' }),
        step({ id: 'b', verb: 'Exploré', kind: 'file' }),
        step({ id: 'c', verb: 'Exécuté', kind: 'command', label: 'Commande terminal', subtitle: 'ls' }),
      ]}
    />,
  );
  expect(html).toContain('Exploré 2 fichiers · Exécuté 1 commande');
  expect(html).toContain('2 fichiers');
  expect(html).toContain('ls');
  expect(html).toContain('3/3');
});

it('sort l’erreur du groupe : carte rouge, 1re phrase, bouton copier', () => {
  const html = renderToStaticMarkup(
    <StepCard
      live
      steps={[
        step({
          id: 'bad',
          label: 'Recherche web',
          status: 'error',
          error: 'Le service a refusé. Réessaie plus tard.',
        }),
      ]}
    />,
  );
  expect(html).toContain('Recherche web');
  expect(html).toContain('Le service a refusé.');
  expect(html).not.toContain('Réessaie plus tard.');
  expect(html).toContain('Copier');
  expect(html).toContain('step-card-step error');
});

it('affiche « Échec » quand le message d’erreur est vide', () => {
  const html = renderToStaticMarkup(
    <StepCard
      live
      steps={[step({ id: 'bad', label: 'Outil', status: 'error', error: '' })]}
    />,
  );
  expect(html).toContain('Échec');
});

it('distingue l’interruption de l’erreur', () => {
  const html = renderToStaticMarkup(
    <StepCard
      live
      steps={[
        step({ id: 's', label: 'Commande terminal', status: 'stopped' }),
      ]}
    />,
  );
  expect(html).toContain('Interrompu');
  expect(html).not.toContain('step-card-step error');
});

it('reste dépliée pendant le run et montre l’étape en cours', () => {
  const html = renderToStaticMarkup(
    <StepCard
      live
      steps={[
        step({ id: 'a', label: 'Recherche web', status: 'done' }),
        step({ id: 'b', label: 'Commande terminal', status: 'running' }),
      ]}
    />,
  );
  expect(html).toContain('Commande terminal…');
  expect(html).toContain('Recherche web');
  expect(html).toContain('1/2');
});
