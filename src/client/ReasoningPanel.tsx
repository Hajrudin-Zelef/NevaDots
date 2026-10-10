import { useEffect, useRef } from 'react';
import { X, Languages } from 'lucide-react';
import type { ReasoningRunStats } from '../server/reasoning.js';

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatTokens(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function ReasoningPanel({
  open,
  onClose,
  modelName,
  live,
  text,
  stats,
  translation,
  translating,
  translateError,
  showTranslation,
  onTranslate,
  onToggleTranslation,
}: {
  open: boolean;
  onClose(): void;
  modelName: string;
  live: boolean;
  text: string;
  stats: ReasoningRunStats | null;
  translation: string | null;
  translating: boolean;
  translateError: string;
  showTranslation: boolean;
  onTranslate(): void;
  onToggleTranslation(): void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Follow the stream while the model is thinking.
    if (live && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [text, live]);
  if (!open) return null;
  const shown = showTranslation && translation ? translation : text;
  return (
    <aside className="reasoning-overlay" aria-label="Raisonnement du modèle">
      <div className="reasoning-panel">
        <header className="reasoning-header">
          <div>
            <strong>Raisonnement</strong>
            {live && <span className="reasoning-live">En cours…</span>}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Fermer le panneau de raisonnement"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <dl className="reasoning-stats">
          <div>
            <dt>Modèle</dt>
            <dd className="reasoning-model">{modelName}</dd>
          </div>
          <div>
            <dt>Temps</dt>
            <dd>{stats ? formatMs(stats.durationMs) : '—'}</dd>
          </div>
          <div>
            <dt>Input</dt>
            <dd>{stats ? formatTokens(stats.promptTokens) : '—'}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{stats ? formatTokens(stats.completionTokens) : '—'}</dd>
          </div>
          <div>
            <dt>tok/s</dt>
            <dd>
              {stats?.tokensPerSecond != null
                ? stats.tokensPerSecond.toFixed(1)
                : '—'}
            </dd>
          </div>
          <div>
            <dt>Coût (estim.)</dt>
            <dd>
              {stats?.costUsd != null ? `$${stats.costUsd.toFixed(4)}` : '—'}
            </dd>
          </div>
        </dl>
        <div className="reasoning-toolbar">
          <span className="reasoning-eyebrow">Raisonnement</span>
          {translation ? (
            <button
              type="button"
              className="reasoning-translate"
              onClick={onToggleTranslation}
            >
              <Languages size={13} />
              {showTranslation ? 'Voir l’original' : 'Voir la traduction'}
            </button>
          ) : (
            <button
              type="button"
              className="reasoning-translate"
              onClick={onTranslate}
              disabled={translating || !text.trim()}
            >
              <Languages size={13} />
              {translating ? 'Traduction…' : 'Traduire'}
            </button>
          )}
        </div>
        {translateError && (
          <p className="reasoning-error" role="alert">
            {translateError}
          </p>
        )}
        <div ref={bodyRef} className="reasoning-body">
          {shown || (live ? 'Réflexion en cours…' : 'Aucun raisonnement.')}
        </div>
      </div>
    </aside>
  );
}
