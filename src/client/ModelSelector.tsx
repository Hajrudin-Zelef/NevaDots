import { useEffect, useRef, useState } from 'react';
import { modelKey, parseModelKey, type ModelsResponse } from '../shared/models';
import { api } from './api';

const PROVIDER_META: Record<string, { color: string; icon: string }> = {
  opencode: {
    color: '#6366f1',
    icon: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#6366f1"/><text x="12" y="16" text-anchor="middle" font-size="10" fill="white" font-family="monospace">OC</text></svg>`,
  },
  litellm: {
    color: '#0ea5e9',
    icon: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#0ea5e9"/><text x="12" y="16" text-anchor="middle" font-size="9" fill="white" font-family="monospace">LL</text></svg>`,
  },
  openrouter: {
    color: '#8b5cf6',
    icon: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#8b5cf6"/><text x="12" y="16" text-anchor="middle" font-size="9" fill="white" font-family="monospace">OR</text></svg>`,
  },
  deepseek: {
    color: '#3b82f6',
    icon: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#3b82f6"/><text x="12" y="16" text-anchor="middle" font-size="9" fill="white" font-family="monospace">DS</text></svg>`,
  },
  freellmapi: {
    color: '#10b981',
    icon: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#10b981"/><text x="12" y="16" text-anchor="middle" font-size="9" fill="white" font-family="monospace">FL</text></svg>`,
  },
};

interface Props {
  dotId: string;
  modelValue: string;
  modelOptions: ModelsResponse;
  defaultModelLabel: string | null;
  onModelSaved: () => Promise<void> | void;
  onModelError: (message: string) => void;
}

export function ModelSelector({
  dotId,
  modelValue,
  modelOptions,
  defaultModelLabel,
  onModelSaved,
  onModelError,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const select = async (value: string) => {
    setOpen(false);
    const parsed = parseModelKey(value);
    onModelError('');
    try {
      await api(`/dots/${dotId}/model`, 'PUT', parsed ?? { model: null });
      await onModelSaved();
    } catch (cause) {
      onModelError(
        cause instanceof Error
          ? cause.message
          : 'Impossible de changer de modèle.',
      );
    }
  };

  const currentParsed = parseModelKey(modelValue);
  const currentMeta = currentParsed
    ? PROVIDER_META[currentParsed.provider]
    : null;
  const currentLabel =
    currentParsed?.model ??
    (defaultModelLabel ? `Défaut · ${defaultModelLabel}` : 'Défaut');

  return (
    <div className="model-selector" ref={ref}>
      <button
        type="button"
        className="model-selector-trigger"
        onClick={() => setOpen((v) => !v)}
        title="Changer de modèle"
      >
        {currentMeta && (
          <span
            className="model-selector-dot"
            style={{ background: currentMeta.color }}
          />
        )}
        <span className="model-selector-label">{currentLabel}</span>
        <span className="model-selector-chevron">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="model-selector-dropdown">
          <button
            type="button"
            className={`model-selector-option ${!modelValue ? 'active' : ''}`}
            onClick={() => void select('')}
          >
            <span className="model-selector-option-model">
              {defaultModelLabel ? `Défaut · ${defaultModelLabel}` : 'Défaut'}
            </span>
          </button>

          {modelOptions.providers.map((provider) => {
            const meta = PROVIDER_META[provider.id] ?? {
              color: '#94a3b8',
              icon: '',
            };
            return (
              <div key={provider.id} className="model-selector-group">
                <div
                  className="model-selector-group-header"
                  style={{ color: meta.color }}
                >
                  <span
                    className="model-selector-dot"
                    style={{ background: meta.color }}
                  />
                  <strong>{provider.label}</strong>
                  {!provider.configured && (
                    <span className="model-selector-unconfigured">
                      non configuré
                    </span>
                  )}
                </div>
                {provider.models.map((model) => {
                  const key = modelKey(provider.id, model);
                  return (
                    <button
                      type="button"
                      key={key}
                      className={`model-selector-option ${modelValue === key ? 'active' : ''}`}
                      onClick={() => void select(key)}
                    >
                      <span
                        className="model-selector-option-accent"
                        style={{ background: meta.color }}
                      />
                      <span className="model-selector-option-model">
                        {model}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
