import { expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement, type ReactNode } from 'react';
import { Composer } from '../src/client/Composer';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

/** Lot 6, étape 2 : l'envoi et le Stop vivent dans `.composer-touch-bar`
 *  (sœur de la rangée d'outils). Fix round 1/5 : sous `(hover: none)` la
 *  rangée d'outils N'EST PLUS masquée — elle garde la chip modèle, le
 *  globe, le menu `+`, le micro et le raisonnement (tous « Garder ») ; le
 *  masquage CSS ne porte plus que sur la chip agent, dont la fonction
 *  existe déjà dans le menu `+` et la sidebar. */

function renderComposer(extras?: {
  stopButton?: ReactNode;
  submitLabel?: string;
  modelOptions?: {
    default: null;
    providers: Array<{
      id: string;
      label: string;
      models: string[];
      configured: boolean;
    }>;
  };
  modelValue?: string;
  onToggleWebSearch?: () => void;
  webSearchOn?: boolean;
  reasoningLevels?: string[] | null;
  agentChip?: ReactNode;
  voiceButton?: ReactNode;
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
        modelValue: extras?.modelValue ?? '',
        modelOptions: extras?.modelOptions ?? { default: null, providers: [] },
        defaultModelLabel: null,
        onModelSaved: () => Promise.resolve(),
        onModelError: () => {},
        reasoningEffort: 'none',
        onSetReasoningEffort: () => {},
        reasoningLevels: extras?.reasoningLevels,
        onToggleWebSearch: extras?.onToggleWebSearch,
        webSearchOn: extras?.webSearchOn,
        voiceButton: extras?.voiceButton,
        agentChip: extras?.agentChip,
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

/* Fix round 1/5 — finding Important 1 : la chip modèle (et les autres
 * contrôles « Garder ») restent dans la rangée d'outils, rendue visible
 * en tactile par le CSS (`responsive.css`, `@media (hover: none)`) au
 * lieu d'être masquée. Les valeurs CSS (44 px, `flex-wrap`, masquage
 * de la chip agent) restent un item du contrôle visuel. */

function modelChip(renderer: ReactTestRenderer) {
  const tools = renderer.root.findByProps({
    className: 'chat-compose-tools',
  });
  return tools.findByProps({ className: 'model-selector' });
}

it('la chip modèle reste dans la rangée d\u2019outils et son déclencheur est un bouton utilisable', () => {
  const renderer = renderComposer({
    modelOptions: {
      default: null,
      providers: [
        {
          id: 'litellm',
          label: 'LiteLLM',
          models: ['glm-5.3'],
          configured: true,
        },
      ],
    },
  });
  const chip = modelChip(renderer);
  const trigger = chip.find(
    (node) =>
      node.type === 'button' &&
      typeof node.props.className === 'string' &&
      node.props.className.split(' ').includes('model-selector-trigger'),
  );
  expect(trigger.props.title).toBe('Changer de modèle');
  // Clic = ouverture (chevron ▼ → ▲) : le bouton est câblé, pas inerte.
  // Environnement node : pas de `document`, le portail du menu ne se
  // rend pas — le rendu réel du menu reste un item du contrôle visuel.
  expect(
    chip.findByProps({ className: 'model-selector-chevron' }).children,
  ).toEqual(['▼']);
  act(() => {
    trigger.props.onClick();
  });
  expect(
    modelChip(renderer).findByProps({ className: 'model-selector-chevron' })
      .children,
  ).toEqual(['▲']);
  // La chip n'a PAS été déplacée dans la barre tactile : elle reste
  // dans la rangée d'outils, visible en tactile via le CSS.
  const bar = renderer.root.findByProps({ className: 'composer-touch-bar' });
  expect(
    bar.findAll(
      (node) =>
        node.props?.className === 'model-selector' ||
        (typeof node.props?.className === 'string' &&
          node.props.className.split(' ').includes('model-selector-trigger')),
    ),
  ).toEqual([]);
});

it('le menu +, le globe, le micro et le raisonnement restent dans la rangée d\u2019outils', () => {
  const renderer = renderComposer({
    onToggleWebSearch: () => {},
    webSearchOn: false,
    reasoningLevels: ['low', 'medium', 'high', 'max'],
    voiceButton: createElement('button', {
      type: 'button',
      className: 'icon-button',
      'aria-label': 'Démarrer une conversation vocale',
    }),
  });
  const tools = renderer.root.findByProps({
    className: 'chat-compose-tools',
  });
  expect(
    tools.findByProps({ 'aria-label': 'Ouvrir les outils du composer' }).type,
  ).toBe('button');
  expect(tools.findByProps({ 'aria-label': 'Recherche web' }).type).toBe(
    'button',
  );
  expect(
    tools.findByProps({ 'aria-label': 'Démarrer une conversation vocale' })
      .type,
  ).toBe('button');
  const brain = tools.find(
    (node) =>
      node.type === 'button' &&
      typeof node.props['aria-label'] === 'string' &&
      node.props['aria-label'].startsWith('Réflexion :'),
  );
  expect(brain).toBeTruthy();
  expect(
    tools.findByProps({ 'aria-label': 'Variante de raisonnement' }).type,
  ).toBe('select');
});

it('la chip agent reste dans le DOM (son masquage tactile est CSS seulement)', () => {
  const chip = createElement(
    'button',
    {
      type: 'button',
      className: 'agent-chip',
      'aria-label': 'Agent actif : Test',
    },
    'Test',
  );
  const renderer = renderComposer({ agentChip: chip });
  const tools = renderer.root.findByProps({
    className: 'chat-compose-tools',
  });
  // Présente dans le DOM : sous `(hover: none)` c'est le CSS qui la
  // masque (`display: none` sur `.agent-chip`) — sa fonction (changer
  // de Dot) reste offerte par le menu `+` et la sidebar.
  expect(
    tools.findByProps({ className: 'agent-chip' }).props['aria-label'],
  ).toBe('Agent actif : Test');
});
