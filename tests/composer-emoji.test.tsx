import { expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { createElement, type ReactNode } from 'react';
import { Composer } from '../src/client/Composer';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

function renderComposer(onTextChange: (value: string) => void) {
  const nothing: ReactNode = null;
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      createElement(Composer, {
        text: 'Bonjour',
        onTextChange,
        placeholder: 'Écrire',
        inputAriaLabel: 'Composer',
        canSubmitOnEnter: true,
        onSubmit: () => {},
        submitDisabled: false,
        submitTitle: 'Envoyer',
        submitAriaLabel: 'Envoyer',
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

it('le volet emoji insère au texte (fin en repli sans vrai DOM)', () => {
  const onTextChange = vi.fn();
  const renderer = renderComposer(onTextChange);
  const smile = renderer.root
    .findAllByType('button')
    .find((b) => b.props['aria-label'] === 'Insérer un emoji')!;
  act(() => {
    smile.props.onClick();
  });
  const first = renderer.root
    .findAllByProps({ className: 'emoji-item' })
    .at(0)!;
  const emoji = first.children.join('');
  expect(emoji.length).toBeGreaterThan(0);
  act(() => {
    first.props.onClick();
  });
  expect(onTextChange).toHaveBeenCalledWith(`Bonjour${emoji}`);
});
