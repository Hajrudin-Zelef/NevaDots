import { expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement, type ReactNode } from 'react';
import { Composer } from '../src/client/Composer';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

function renderComposer(submitLabel?: string) {
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
        submitLabel,
        sourceOpen: false,
        onToggleSource: () => {},
        source: '',
        onSourceChange: () => {},
        menuOpen: false,
        onToggleMenu: () => {},
        menu: nothing,
        promptMenuOpen: false,
        onTogglePromptMenu: () => {},
        promptMenu: nothing,
        dotId: 'd1',
        modelValue: '',
        modelOptions: { default: null, providers: [] },
        defaultModelLabel: null,
        onModelSaved: () => Promise.resolve(),
        onModelError: () => {},
        reasoningEffort: 'none',
        reasoningLabel: 'Non',
        onCycleReasoning: () => {},
        note: nothing,
      }),
    );
  });
  return renderer!;
}

it('bouton libellé quand submitLabel est fourni (écran d’accueil)', () => {
  const renderer = renderComposer('Démarrer');
  const labeled = renderer.root.findByProps({
    className: 'send-button send-labeled',
  });
  expect(labeled.type).toBe('button');
  expect(
    labeled.children.some(
      (child: unknown) =>
        typeof child === 'string' && child.includes('Démarrer'),
    ),
  ).toBe(true);
});

it('pastille flèche seule sans submitLabel (conversation en cours)', () => {
  const renderer = renderComposer(undefined);
  const buttons = renderer.root.findAllByType('button');
  const sends = buttons.filter(
    (b) =>
      typeof b.props.className === 'string' &&
      b.props.className.split(' ').includes('send-button'),
  );
  expect(sends).toHaveLength(1);
  expect(sends[0].props.className).not.toContain('send-labeled');
});
