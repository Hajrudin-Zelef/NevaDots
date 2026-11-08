import { expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement, type ReactNode } from 'react';
import { Composer } from '../src/client/Composer';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

function renderComposer(
  submitLabel?: string,
  hideSource?: boolean,
  webSearch?: { on: boolean; onToggle: () => void; disabled?: boolean },
  reasoning?: {
    effort: string | null;
    onSet: () => void;
    levels?: string[] | null;
  },
) {
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
        hideSource,
        webSearchOn: webSearch?.on,
        onToggleWebSearch: webSearch?.onToggle,
        webSearchDisabled: webSearch?.disabled,
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
        reasoningEffort: reasoning?.effort ?? 'none',
        onSetReasoningEffort: reasoning?.onSet ?? (() => {}),
        reasoningLevels: reasoning?.levels,
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

it('masque le globe sur le composer d’accueil (hideSource)', () => {
  const renderer = renderComposer('Démarrer', true);
  const labels = renderer.root
    .findAllByType('button')
    .map((b) => b.props['aria-label']);
  expect(labels).not.toContain('Ajouter une page web');
  expect(labels).not.toContain('Recherche web');
});

it('aucun bouton aide dans le composer', () => {
  for (const renderer of [
    renderComposer(undefined),
    renderComposer('Démarrer', true),
  ]) {
    const labels = renderer.root
      .findAllByType('button')
      .map((b) => b.props['aria-label']);
    expect(labels).not.toContain('Aide pour rédiger un prompt');
  }
});

it('affiche le globe par défaut (conversation en cours)', () => {
  const renderer = renderComposer(undefined);
  const labels = renderer.root
    .findAllByType('button')
    .map((b) => b.props['aria-label']);
  expect(labels).toContain('Ajouter une page web');
});

it('globe = interrupteur websearch quand le handler est fourni', () => {
  const onToggle = vi.fn();
  const renderer = renderComposer(undefined, false, {
    on: true,
    onToggle,
  });
  const globe = renderer.root.findByProps({ 'aria-label': 'Recherche web' });
  expect(globe.props['aria-pressed']).toBe(true);
  expect(String(globe.props.title)).toContain('activée');
  act(() => {
    globe.props.onClick();
  });
  expect(onToggle).toHaveBeenCalledTimes(1);
});

it('globe reste une source quand aucun handler websearch (comportement historique)', () => {
  const renderer = renderComposer(undefined);
  const globe = renderer.root.findByProps({
    'aria-label': 'Ajouter une page web',
  });
  expect(globe).toBeTruthy();
});

it('Brain = retour au Standard (auto), jamais de cycle', () => {
  const onSet = vi.fn();
  const renderer = renderComposer(undefined, false, undefined, {
    effort: 'high',
    onSet,
    levels: ['low', 'high'],
  });
  const brain = renderer.root.findByProps({
    'aria-label': 'Réflexion : haute',
  });
  act(() => {
    brain.props.onClick();
  });
  expect(onSet).toHaveBeenCalledTimes(1);
  expect(onSet).toHaveBeenCalledWith(null);
});

it('option non native grisée avec motif au survol', () => {
  const renderer = renderComposer(undefined, false, undefined, {
    effort: null,
    onSet: () => {},
    levels: ['low'],
  });
  const options = renderer.root.findAllByType('option');
  const max = options.find((o) => o.props.value === 'max')!;
  expect(max.props.disabled).toBe(true);
  expect(String(max.props.title)).toContain('non supporté nativement');
  const low = options.find((o) => o.props.value === 'low')!;
  expect(low.props.disabled).toBeFalsy();
});
