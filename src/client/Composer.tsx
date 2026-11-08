import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Brain,
  CircleHelp,
  Globe,
  Link2,
  Plus,
  Smile,
  X,
} from 'lucide-react';
import { shouldSubmitComposerOnKeyDown } from './chat-composer';
import { EMOJI_CATEGORIES } from './emoji';
import { type ModelsResponse } from '../shared/models';
import { ModelSelector } from './ModelSelector';

export interface ComposerProps {
  // --- Text input ---
  text: string;
  onTextChange: (value: string) => void;
  placeholder: string;
  inputDisabled?: boolean;
  inputAriaLabel: string;
  /** Gate for Ctrl/Cmd+Enter to submit (e.g. configured && !busy && !!text.trim()). */
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

  // --- Focus programmé (citation « Répondre », suggestions) ---
  textareaRef?: { current: HTMLTextAreaElement | null };
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
    textareaRef,
  } = props;

  // Auto-agrandissement du textarea : suit le contenu jusqu'à max-height (120px),
  // puis le texte défile à l'intérieur. Sans ça, un long message reste écrasé
  // sur une ligne et le texte « casse » visuellement.
  const innerRef = useRef<HTMLTextAreaElement>(null);
  const emojiWrapRef = useRef<HTMLSpanElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiTab, setEmojiTab] = useState(0);
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [text]);
  useEffect(() => {
    if (!emojiOpen || typeof document === 'undefined') return;
    const outside = (event: PointerEvent) => {
      if (!emojiWrapRef.current?.contains(event.target as Node | null))
        setEmojiOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEmojiOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [emojiOpen]);
  /** Insère l'emoji au curseur (fin du texte en repli sans vrai DOM). */
  const insertEmoji = (emoji: string) => {
    const el = innerRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    onTextChange(text.slice(0, start) + emoji + text.slice(end));
    if (typeof requestAnimationFrame === 'undefined') return;
    requestAnimationFrame(() => {
      const target = innerRef.current;
      if (!target) return;
      target.focus();
      const pos = start + emoji.length;
      try {
        target.setSelectionRange(pos, pos);
      } catch {
        /* repli : curseur en fin de champ */
      }
    });
  };

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
          ref={(el) => {
            innerRef.current = el;
            if (textareaRef) textareaRef.current = el;
          }}
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
            onClick={() => onTogglePromptMenu()}
          >
            <CircleHelp size={17} />
          </button>
          <span className="emoji-wrap" ref={emojiWrapRef}>
            <button
              type="button"
              className={`icon-button ${emojiOpen ? 'active' : ''}`}
              aria-label="Insérer un emoji"
              title="Emojis"
              aria-expanded={emojiOpen}
              onClick={() => setEmojiOpen((open) => !open)}
            >
              <Smile size={17} />
            </button>
            {emojiOpen && (
              <div className="emoji-panel" role="dialog" aria-label="Emojis">
                <div className="emoji-tabs" role="tablist">
                  {EMOJI_CATEGORIES.map((category, index) => (
                    <button
                      key={category.label}
                      type="button"
                      role="tab"
                      aria-selected={index === emojiTab}
                      className={index === emojiTab ? 'active' : ''}
                      title={category.label}
                      onClick={() => setEmojiTab(index)}
                    >
                      {category.items[0]}
                    </button>
                  ))}
                </div>
                <div className="emoji-grid">
                  {EMOJI_CATEGORIES[emojiTab].items.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="emoji-item"
                      aria-label={`Insérer ${emoji}`}
                      onClick={() => {
                        insertEmoji(emoji);
                        setEmojiOpen(false);
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </span>
          {voiceButton}
          {modelOptions.providers.length > 0 && (
            <ModelSelector
              dotId={dotId}
              modelValue={modelValue}
              modelOptions={modelOptions}
              defaultModelLabel={defaultModelLabel}
              onModelSaved={onModelSaved}
              onModelError={onModelError}
            />
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
