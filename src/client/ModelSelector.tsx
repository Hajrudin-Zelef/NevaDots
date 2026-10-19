import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  const [dropPos, setDropPos] = useState({
    top: 0,
    left: 0,
    width: 240,
    maxHeight: 340,
  });
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const updateDropPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === 'undefined') return;
    const rect = trigger.getBoundingClientRect();
    const gap = 8;
    const width = Math.min(
      Math.max(rect.width, 240),
      Math.max(180, window.innerWidth - 16),
    );
    const left = Math.min(
      Math.max(8, rect.left),
      Math.max(8, window.innerWidth - width - 8),
    );
    const above = Math.max(0, rect.top - gap - 8);
    const below = Math.max(0, window.innerHeight - rect.bottom - gap - 8);
    const openAbove = above >= 180 || above >= below;
    const maxHeight = Math.max(100, Math.min(340, openAbove ? above : below));
    const top = openAbove
      ? Math.max(8, rect.top - gap - maxHeight)
      : Math.min(rect.bottom + gap, window.innerHeight - maxHeight - 8);
    setDropPos({ top, left, width, maxHeight });
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !ref.current?.contains(target) &&
        !dropdownRef.current?.contains(target)
      )
        setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', updateDropPosition);
    window.addEventListener('scroll', updateDropPosition, true);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', updateDropPosition);
      window.removeEventListener('scroll', updateDropPosition, true);
    };
  }, [open, updateDropPosition]);

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
        ref={triggerRef}
        type="button"
        className="model-selector-trigger"
        onClick={() => {
          if (!open) updateDropPosition();
          setOpen((value) => !value);
        }}
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

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={dropdownRef}
            className="model-selector-dropdown"
            style={{
              position: 'fixed',
              top: dropPos.top,
              left: dropPos.left,
              width: dropPos.width,
              maxHeight: dropPos.maxHeight,
              bottom: 'auto',
            }}
          >
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
          </div>,
          document.body,
        )}
    </div>
  );
}
