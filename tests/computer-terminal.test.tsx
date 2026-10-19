import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveTerminalStrip } from '../src/client/ComputerTerminal';
import type { ComputerActivitySnapshot } from '../src/client/useComputerActivity';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const values = new Map<string, string>();
vi.stubGlobal('window', {
  localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  },
});
afterEach(() => values.clear());

function snapshot(
  actor: 'agent' | 'owner',
  running: boolean,
): ComputerActivitySnapshot {
  return {
    connected: true,
    error: '',
    runs: [
      {
        key: 'run-1',
        actor,
        command: 'npm test',
        startedAt: 1,
        running,
        stdout: running ? '' : '12 tests passed',
        stderr: '',
        exitCode: running ? undefined : 0,
        elapsedMs: running ? undefined : 1200,
      },
    ],
  };
}

it('ouvre le strip automatiquement à la première commande du Dot', () => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(LiveTerminalStrip, {
        dotId: 'leo',
        dotName: 'LEO',
        activity: snapshot('agent', true),
      }),
    );
  });
  const toggle = renderer!.root.findByProps({
    className: 'live-terminal-strip-toggle',
  });
  expect(toggle.props['aria-expanded']).toBe(true);
  expect(JSON.stringify(renderer!.toJSON())).toContain('$ npm test');
  expect(
    renderer!.root.findByProps({
      className: 'computer-terminal-run running ',
    }).props.open,
  ).toBe(true);
});

it('reste compact pour une commande manuelle et se replie sur demande', () => {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(LiveTerminalStrip, {
        dotId: 'marius',
        dotName: 'Marius',
        activity: snapshot('owner', false),
      }),
    );
  });
  let toggle = renderer!.root.findByProps({
    className: 'live-terminal-strip-toggle',
  });
  expect(toggle.props['aria-expanded']).toBe(false);
  act(() => toggle.props.onClick());
  toggle = renderer!.root.findByProps({
    className: 'live-terminal-strip-toggle',
  });
  expect(toggle.props['aria-expanded']).toBe(true);
  expect(JSON.stringify(renderer!.toJSON())).toContain('12 tests passed');
  act(() => toggle.props.onClick());
  expect(
    renderer!.root.findByProps({
      className: 'live-terminal-strip-toggle',
    }).props['aria-expanded'],
  ).toBe(false);
});

it('respecte le repli manuel au prochain montage pour la même commande', () => {
  values.set('nevadots-terminal-strip:leo', 'closed');
  values.set('nevadots-terminal-strip:leo:last-auto-open', 'run-1');
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(LiveTerminalStrip, {
        dotId: 'leo',
        dotName: 'LEO',
        activity: snapshot('agent', false),
      }),
    );
  });
  expect(
    renderer!.root.findByProps({
      className: 'live-terminal-strip-toggle',
    }).props['aria-expanded'],
  ).toBe(false);
});

it('montre les petites sorties et replie les sorties longues façon OpenCode', () => {
  const long = snapshot('agent', false);
  long.runs[0].stdout = Array.from({ length: 20 }, (_, i) => `ligne ${i}`).join(
    '\n',
  );
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(LiveTerminalStrip, {
        dotId: 'long-output',
        dotName: 'LEO',
        activity: long,
      }),
    );
  });
  const details = renderer!.root.findByType('details');
  expect(details.props.open).toBe(false);
  expect(JSON.stringify(renderer!.toJSON())).toContain('$ npm test');
  expect(JSON.stringify(renderer!.toJSON())).toContain(
    'Cliquer pour développer',
  );
});
