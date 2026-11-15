import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  firstSentence,
  stripAnsiCodes,
  summarizeToolCall,
} from '../src/shared/activity';
import { StepCard } from '../src/client/StepCard';
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

// --- Rendu « N outils utilisés » (façon OpenCode) -------------------------

it('en-tête : « N outils utilisés » au pluriel, « 1 outil utilisé » au singulier', () => {
  const three = renderToStaticMarkup(
    <StepCard
      live={false}
      steps={[
        step({ id: 'a', toolName: 'computer_exec' }),
        step({ id: 'b', toolName: 'computer_exec' }),
        step({ id: 'c', toolName: 'computer_exec' }),
      ]}
    />,
  );
  expect(three).toContain('3 outils utilisés');
  const one = renderToStaticMarkup(
    <StepCard live={false} steps={[step({ id: 'a' })]} />,
  );
  expect(one).toContain('1 outil utilisé');
});

it('replié une fois terminé : en-tête seul, aucune ligne rendue', () => {
  const html = renderToStaticMarkup(
    <StepCard
      live={false}
      steps={[step({ id: 'a', toolName: 'computer_exec', subtitle: 'ls -la' })]}
    />,
  );
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('tool-run-list');
  expect(html).not.toContain('ls -la');
});

it('déplié pendant le run : une ligne par appel, jamais regroupées', () => {
  const html = renderToStaticMarkup(
    <StepCard
      live
      steps={[
        step({
          id: 'r1',
          toolName: 'computer_files_read',
          kind: 'file',
          subtitle: '/a.md',
        }),
        step({
          id: 'r2',
          toolName: 'computer_files_read',
          kind: 'file',
          subtitle: '/b.md',
        }),
        step({
          id: 'e1',
          toolName: 'computer_files_write',
          kind: 'file',
          verb: 'Modifié',
          subtitle: 'auto-scroll.ts · +12 −3',
          addedLines: 12,
          removedLines: 3,
        }),
      ]}
    />,
  );
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('tool-run-list');
  // Trois appels = trois lignes (l'ancien rendu fusionnait les lectures).
  expect(html.split('tool-run-row').length - 1).toBe(3);
  expect(html).toContain('Lecture');
  expect(html).toContain('/a.md');
  expect(html).toContain('/b.md');
  expect(html).toContain('Édition');
  expect(html).toContain('auto-scroll.ts');
  // Le diff est rendu une seule fois, à part de l'aperçu.
  expect(html.split('+12 −3').length - 1).toBe(1);
});

it('aperçu de commande affiché sur la ligne Shell', () => {
  const html = renderToStaticMarkup(
    <StepCard
      live
      steps={[
        step({
          id: 'c1',
          toolName: 'computer_exec',
          kind: 'command',
          verb: 'Exécuté',
          subtitle: 'grep -n "turn-status" src/client/Chat.tsx',
        }),
      ]}
    />,
  );
  expect(html).toContain('Shell');
  expect(html).toContain('grep -n &quot;turn-status&quot;');
});

it('erreur : ligne rouge, 1re phrase, bouton copier', () => {
  const html = renderToStaticMarkup(
    <StepCard
      live
      steps={[
        step({
          id: 'bad',
          toolName: 'search_web',
          status: 'error',
          error: 'Le service a refusé. Réessaie plus tard.',
        }),
      ]}
    />,
  );
  expect(html).toContain('tool-run-row error');
  expect(html).toContain('Recherche');
  expect(html).toContain('Le service a refusé.');
  expect(html).not.toContain('Réessaie plus tard.');
  expect(html).toContain('Copier');
});

it('affiche « Échec » quand le message d’erreur est vide', () => {
  const html = renderToStaticMarkup(
    <StepCard live steps={[step({ id: 'bad', status: 'error', error: '' })]} />,
  );
  expect(html).toContain('Échec');
});

it('distingue l’interruption de l’erreur', () => {
  const html = renderToStaticMarkup(
    <StepCard
      live
      steps={[step({ id: 's', toolName: 'computer_exec', status: 'stopped' })]}
    />,
  );
  expect(html).toContain('Interrompu');
  expect(html).not.toContain('tool-run-row error');
});

it('pastille live : « 1 Shell » pendant le run, absente une fois terminé', () => {
  const running = renderToStaticMarkup(
    <StepCard
      live
      steps={[
        step({ id: 'a', toolName: 'computer_exec', status: 'done' }),
        step({ id: 'b', toolName: 'computer_exec', status: 'running' }),
      ]}
    />,
  );
  expect(running).toContain('tool-run-pill');
  expect(running).toContain('1 Shell');
  const done = renderToStaticMarkup(
    <StepCard
      live={false}
      steps={[step({ id: 'a', toolName: 'computer_exec', status: 'done' })]}
    />,
  );
  expect(done).not.toContain('tool-run-pill');
});
