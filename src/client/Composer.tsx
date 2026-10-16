import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import {
  ArrowUp,
  Brain,
  CircleHelp,
  Globe,
  Link2,
  Plus,
  X,
} from 'lucide-react';
import { api } from './api';
import { shouldSubmitComposerOnKeyDown } from './chat-composer';
import { modelKey, parseModelKey, type ModelsResponse } from '../shared/models';

export interface ComposerProps {
  // --- Text input ---
  text: string;
  onTextChange: (value: string) => void;
  placeholder: string;
  inputDisabled?: boolean;
  inputAriaLabel: string;
  /** Gate for Enter-to-submit (e.g. configured && !busy && !!text.trim()). */
  canSubmitOnEnter: boolean;

  // --- Form submit ---
  onSubmit: () => void;
  submitDisabled: boolean;
  submitTitle: string;
  submitAriaLabel: string;

  // --- Source page ---
  sourceOpen: boolean;
  onToggleSource: () => void;
  source: string;
  onSourceChange: (value: string) => void;

  // --- Tools menu (+) ---
  menuOpen: boolean;
  onToggleMenu: () => void;
  menu: ReactNode;

  // --- Prompt suggestions (?) ---
  promptMenuOpen: boolean;
  onTogglePromptMenu: () => void;
  promptMenu: ReactNode;

  // --- Model select (shared logic: PUT /dots/:id/model) ---
  dotId: string;
  modelValue: string;
  modelOptions: ModelsResponse;
  defaultModelLabel: string | null;
  onModelSaved: () => Promise<void> | void;
  onModelError: (message: string) => void;

  // --- Reasoning (DeepThink) ---
  reasoningEffort: string | null | undefined;
  reasoningLabel: string;
  onCycleReasoning: () => void;
  reasoningDisabled?: boolean;

  // --- Contextual extras ---
  /** Voice button (new conversation). */
  voiceButton?: ReactNode;
  /** Stop button (chat, while running). */
  stopButton?: ReactNode;

  // --- Attachments (Phase 2) ---
  /** File cards row, rendered above the textarea. */
  attachmentCards?: ReactNode;

  // --- Note under the composer ---
  note: ReactNode;
}

/**
 * Single shared composer used by both the new-conversation screen and the
 * ongoing chat session (Phase 1 — chat unifié). Same skeleton, same full
 * button set; only the submit behavior and contextual extras differ.
 */
export function Composer(props: ComposerProps) {
  const {
    text,
    onTextChange,
    placeholder,
    inputDisabled,
    inputAriaLabel,
    canSubmitOnEnter,
    onSubmit,
    submitDisabled,
    submitTitle,
    submitAriaLabel,
    sourceOpen,
    onToggleSource,
    source,
    onSourceChange,
    menuOpen,
    onToggleMenu,
    menu,
    promptMenuOpen,
    onTogglePromptMenu,
    promptMenu,
    dotId,
    modelValue,
    modelOptions,
    defaultModelLabel,
    onModelSaved,
    onModelError,
    reasoningEffort,
    reasoningLabel,
    onCycleReasoning,
    reasoningDisabled,
    voiceButton,
    stopButton,
    attachmentCards,
    note,
  } = props;

  // Auto-agrandissement du textarea : suit le contenu jusqu'à max-height (120px),
  // puis le texte défile à l'intérieur. Sans ça, un long message reste écrasé
  // sur une ligne et le texte « casse » visuellement.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [text]);

  return (
    <form
      className="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {sourceOpen && (
        <div className="source-input">
          <Link2 size={15} />
          <input
            aria-label="URL de la page à consulter"
            type="url"
            value={source}
            onChange={(event) => onSourceChange(event.target.value)}
            placeholder="https://example.com/page"
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Retirer la source"
            onClick={() => {
              onToggleSource();
              onSourceChange('');
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {menuOpen && menu}
      {promptMenuOpen && promptMenu}
      {attachmentCards}
      <div className="chat-compose-row">
        <textarea
          ref={textareaRef}
          aria-label={inputAriaLabel}
          placeholder={placeholder}
          value={text}
          rows={1}
          maxLength={4000}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (shouldSubmitComposerOnKeyDown(e)) {
              e.preventDefault();
              if (canSubmitOnEnter) e.currentTarget.form?.requestSubmit();
            }
          }}
          disabled={inputDisabled}
        />
        <div className="chat-compose-tools">
          <button
            type="button"
            className={`icon-button ${menuOpen ? 'active' : ''}`}
            aria-label="Ouvrir les outils du composer"
            title="Ajouter"
            aria-expanded={menuOpen}
            onClick={onToggleMenu}
          >
            <Plus size={17} />
          </button>
          <button
            type="button"
            className={`icon-button ${sourceOpen ? 'active' : ''}`}
            aria-label="Ajouter une page web"
            title="Ajouter une page web"
            aria-expanded={sourceOpen}
            onClick={onToggleSource}
          >
            <Globe size={17} />
          </button>
          <button
            type="button"
            className={`icon-button ${promptMenuOpen ? 'active' : ''}`}
            aria-label="Aide pour rédiger un prompt"
            title="Suggestions de prompts"
            aria-expanded={promptMenuOpen}
            onClick={onTogglePromptMenu}
          >
            <CircleHelp size={17} />
          </button>
          {voiceButton}
          {modelOptions.providers.length > 0 && (
            <select
              className="model-select"
              aria-label="Modèle pour ce Dot"
              title="Modèle pour ce Dot"
              value={modelValue}
              onChange={async (event) => {
                const parsed = parseModelKey(event.target.value);
                onModelError('');
                try {
                  await api(
                    `/dots/${dotId}/model`,
                    'PUT',
                    parsed ?? { model: null },
                  );
                  await onModelSaved();
                } catch (cause) {
                  onModelError(
                    cause instanceof Error
                      ? cause.message
                      : 'Impossible de changer de modèle.',
                  );
                }
              }}
            >
              <option value="">
                {defaultModelLabel ? `Défaut · ${defaultModelLabel}` : 'Défaut'}
              </option>
              {modelOptions.providers.map((provider) => (
                <optgroup
                  key={provider.id}
                  label={`${provider.label}${
                    provider.configured ? '' : ' (non configuré)'
                  }`}
                >
                  {provider.models.map((model) => (
                    <option key={model} value={modelKey(provider.id, model)}>
                      {model}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
          <button
            type="button"
            className={`icon-button reasoning-button ${
              reasoningEffort && reasoningEffort !== 'none' ? 'active' : ''
            }`}
            aria-label={`Réflexion : ${reasoningLabel}`}
            title={`Réflexion : ${reasoningLabel} — cliquez pour changer`}
            onClick={() => void onCycleReasoning()}
            disabled={reasoningDisabled}
          >
            <Brain size={17} />
          </button>
          {stopButton}
          <button
            className="send-button"
            aria-label={submitAriaLabel}
            title={submitTitle}
            disabled={submitDisabled}
          >
            <ArrowUp size={19} />
          </button>
        </div>
      </div>
      <div className="chat-compose-note">{note}</div>
    </form>
  );
}
