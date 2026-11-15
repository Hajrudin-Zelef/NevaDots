import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import { ComputerToolCard } from '../src/client/ComputerToolCard';

it('shows real terminal output and does not treat a nonzero exit as success', () => {
  const html = renderToStaticMarkup(
    <ComputerToolCard
      name="computer_exec"
      toolCallId="exec"
      status="complete"
      dotId="scout"
      dotName="Scout"
      showScreen={false}
      running={false}
      result={JSON.stringify({
        exitCode: 1,
        stdout: '',
        stderr: 'File not found',
      })}
    />,
  );
  expect(html).toContain('Exit 1');
  expect(html).toContain('File not found');
  expect(html).not.toContain('Terminé');
});

it('marks unfinished calls interrupted after a run ends and labels live views as current', () => {
  const html = renderToStaticMarkup(
    <ComputerToolCard
      name="computer_navigate"
      toolCallId="nav"
      status="inProgress"
      dotId="scout"
      dotName="Scout"
      showScreen
      running={false}
      args={{ url: 'https://example.com' }}
    />,
  );
  expect(html).toContain('Interrompu');
  expect(html).toContain('Navigateur');
  expect(html).toContain('https://example.com');
  expect(html).not.toContain('<img');
});

it.each([
  [
    {
      status: 'stopped',
      reason: 'stop_requested',
      message: 'The run was stopped.',
    },
    'Interrompu',
  ],
  [
    {
      status: 'error',
      reason: 'missing_terminal_event',
      message: 'The tool never returned.',
    },
    'Échec',
  ],
  [
    {
      status: 'timeout',
      message: 'Computer request timed out.',
    },
    'Timed out',
  ],
])('recognizes runtime-finalized tool result %j', (result, label) => {
  const html = renderToStaticMarkup(
    <ComputerToolCard
      name="computer_navigate"
      toolCallId="nav"
      status="complete"
      dotId="scout"
      dotName="Scout"
      showScreen={false}
      running={false}
      result={JSON.stringify(result)}
    />,
  );
  expect(html).toContain(label);
  expect(html).toContain(result.message);
  expect(html).not.toContain('Terminé');
});

// Lot 4 : succès = pas de badge ; sortie ANSI nettoyée en <pre> défilant
// avec bouton Copier à côté.
it('shows no badge on success and strips ANSI from terminal output', () => {
  const html = renderToStaticMarkup(
    <ComputerToolCard
      name="computer_exec"
      toolCallId="exec"
      status="complete"
      dotId="scout"
      dotName="Scout"
      showScreen={false}
      running={false}
      result={JSON.stringify({
        exitCode: 0,
        stdout: '\x1b[32mok\x1b[0m\n',
        stderr: '',
      })}
    />,
  );
  expect(html).toContain('Commande terminal');
  expect(html).not.toContain('Terminé');
  expect(html).not.toContain('En cours');
  expect(html).not.toContain('Exit');
  expect(html).toContain('ok');
  expect(html).not.toContain('\x1b[32m');
  expect(html).toContain('Copier');
  expect(html).toContain('muse-tool-output');
});
