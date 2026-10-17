import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => vi.fn());
vi.mock('../src/client/api', () => ({ api }));
import type { DotModelControls } from '../src/client/useDotModelControls';
import { useDotModelControls } from '../src/client/useDotModelControls';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

// Le hook vit dans le navigateur (`models-changed`) ; mini stub d'événements.
{
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: () => void) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.forEach((fn) => fn());
      return true;
    },
  });
}

const CATALOGUE = {
  default: { provider: 'litellm', model: 'deepseek-chat' },
  providers: [{ provider: 'litellm', models: [{ id: 'deepseek-chat' }] }],
};

let latest: DotModelControls | null = null;

function Probe({ ...options }: Parameters<typeof useDotModelControls>[0]) {
  const controls = useDotModelControls(options);
  latest = controls;
  return createElement(
    'span',
    null,
    JSON.stringify({
      models: controls.models.default,
      modelValue: controls.modelValue,
      defaultModelLabel: controls.defaultModelLabel,
      selected: controls.selectedModelLabel,
      reasoning: controls.reasoningLabel,
    }),
  );
}

const roots: ReactTestRenderer[] = [];
afterEach(() => {
  while (roots.length) roots.pop()?.unmount();
});

function snapshot(): Record<string, unknown> {
  const span = roots[roots.length - 1].root.findByType('span');
  return JSON.parse(
    (Array.isArray(span.children) ? span.children.join('') : '') as string,
  );
}

async function mount(
  options: Parameters<typeof useDotModelControls>[0],
): Promise<void> {
  await act(async () => {
    roots.push(create(createElement(Probe, options)));
  });
  await act(async () => {});
}

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (url: string) =>
    url === '/models' ? CATALOGUE : {},
  );
});

it('charge le catalogue et dérive libellés + sélection', async () => {
  await mount({
    dotId: 'd1',
    provider: 'litellm',
    model: 'deepseek-chat',
    reasoningEffort: 'low',
  });
  const s = snapshot();
  expect(s.models).toEqual(CATALOGUE.default);
  expect(s.modelValue).toBe('litellm::deepseek-chat');
  expect(s.defaultModelLabel).toBe('deepseek-chat');
  expect(s.selected).toBe('deepseek-chat');
  expect(s.reasoning).toBe('basse');
});

it('recharge au signal models-changed et replie sur le fallback', async () => {
  await mount({
    dotId: 'd1',
    fallbackDefaultModel: 'srv-def',
  });
  expect(snapshot().selected).toBe('deepseek-chat');
  api.mockImplementation(async () => ({ default: null, providers: [] }));
  await act(async () => {
    window.dispatchEvent(new Event('models-changed'));
    await Promise.resolve();
  });
  await act(async () => {});
  expect(snapshot().selected).toBe('srv-def');
  expect(snapshot().modelValue).toBe('');
});

it('cycle le reasoning, efface l’erreur et prévient', async () => {
  const onSaved = vi.fn(async () => {});
  const onStart = vi.fn();
  const onError = vi.fn();
  await mount({
    dotId: 'd1',
    reasoningEffort: '',
    onReasoningStart: onStart,
    onReasoningSaved: onSaved,
    onReasoningError: onError,
  });
  await act(async () => {
    await latest!.cycleReasoning();
  });
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith('/dots/d1/reasoning', 'PUT', {
    effort: 'low',
  });
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
  // Sans dotId : aucune requête.
  api.mockClear();
  await mount({ dotId: null, reasoningEffort: '' });
  await act(async () => {
    await latest!.cycleReasoning();
  });
  expect(api).not.toHaveBeenCalledWith(
    expect.stringContaining('/reasoning'),
    expect.anything(),
    expect.anything(),
  );
});
