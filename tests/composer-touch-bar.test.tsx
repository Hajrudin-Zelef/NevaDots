import { expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement, type ReactNode } from 'react';
import { Composer } from '../src/client/Composer';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

/** Lot 6, étape 2 : l'envoi et le Stop vivent dans `.composer-touch-bar`
 *  (sœur de la rangée d'outils), pour que `(hover: none)` masque les
 *  outils tout en gardant une barre d'envoi. */

function renderComposer(extras?: {
  stopButton?: ReactNode;
  submitLabel?: string;
}) {
  const nothing: ReactNode = null;
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(Composer, {
        text: 'Bonjour',
        onTextChange: () => {},
        placeholder: 'Écrire',
        inputAriaLabel: 'Composer',
        canSubmitOnEnter: true,
        onSubmit: () => {},
        submitDisabled: false,
        submitTitle: 'Envoyer',
        submitAriaLabel: 'Envoyer',
        submitLabel: extras?.submitLabel,
        sourceOpen: false,
        onToggleSource: () => {},
        source: '',
        onSourceChange: () => {},
        menuOpen: false,
        onToggleMenu: () => {},
        menu: nothing,
        dotId: 'd1',
        modelValue: '',
        modelOptions: { default: null, providers: [] },
        defaultModelLabel: null,
        onModelSaved: () => Promise.resolve(),
        onModelError: () => {},
        reasoningEffort: 'none',
        onSetReasoningEffort: () => {},
        note: nothing,
        stopButton: extras?.stopButton,
      }),
    );
  });
  return renderer!;
}

function sendButton(renderer: ReactTestRenderer) {
  return renderer.root.find(
    (node) =>
      node.type === 'button' &&
      typeof node.props.className === 'string' &&
      node.props.className.split(' ').includes('send-button'),
  );
}

it("le bouton d'envoi est dans la barre tactile, pas dans la rangée d'outils", () => {
  const renderer = renderComposer();
  const button = sendButton(renderer);
  const bar = renderer.root.findByProps({ className: 'composer-touch-bar' });
  expect(bar.findByType('button')).toBe(button);
  const tools = renderer.root.findByProps({
    className: 'chat-compose-tools',
  });
  expect(
    tools.findAll(
      (node) =>
        node.type === 'button' &&
        typeof node.props.className === 'string' &&
        node.props.className.split(' ').includes('send-button'),
    ),
  ).toEqual([]);
});

it('le Stop fourni reste dans la barre tactile (visible pendant un run)', () => {
  const stop = createElement(
    'button',
    {
      type: 'button',
      className: 'send-button stop',
      'aria-label': 'Arrêter la réponse',
    },
    '■',
  );
  const renderer = renderComposer({ stopButton: stop });
  const bar = renderer.root.findByProps({ className: 'composer-touch-bar' });
  expect(
    bar.findByProps({ className: 'send-button stop' }).props['aria-label'],
  ).toBe('Arrêter la réponse');
});

it("le bouton libellé (écran d'accueil) est aussi dans la barre tactile", () => {
  const renderer = renderComposer({ submitLabel: 'Démarrer' });
  const bar = renderer.root.findByProps({ className: 'composer-touch-bar' });
  expect(bar.findByProps({ className: 'send-button send-labeled' }).type).toBe(
    'button',
  );
});
