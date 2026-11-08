import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { ArrowUp, Brain, Globe, Link2, Plus, X } from 'lucide-react';
import { shouldSubmitComposerOnKeyDown } from './chat-composer';
import { reasoningEffortLabel } from './useDotModelControls';
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
  /** Libellé du bouton d'envoi (ex. « Démarrer » sur l'écran d'accueil).
   *  Absent = pastille flèche seule (conversation en cours). */
  submitLabel?: string;

  // --- Source page ---
  sourceOpen: boolean;
  onToggleSource: () => void;
  source: string;
  onSourceChange: (value: string) => void;

  // --- Tools menu (+) ---
  menuOpen: boolean;
  onToggleMenu: () => void;
  menu: ReactNode;

  // --- Model select (shared logic: PUT /dots/:id/model) ---
  dotId: string;
  modelValue: string;
  modelOptions: ModelsResponse;
  defaultModelLabel: string | null;
  onModelSaved: () => Promise<void> | void;
  onModelError: (message: string) => void;

  // --- Reasoning (variantes natives + Défaut auto) ---
  reasoningEffort: string | null | undefined;
  onSetReasoningEffort: (effort: string | null) => void;
  reasoningDisabled?: boolean;
  /** Niveaux natifs du modèle courant (null = en attente/pending). */
  reasoningLevels?: string[] | null;
  /** Modèle à raisonnement obligatoire (désactivation refusée). */
  reasoningMandatory?: boolean;

  // --- Contextual extras ---
  /** Voice button (new conversation). */
  voiceButton?: ReactNode;
  /** Recherche web classique (hors computer) — fourni = le globe devient
   *  un interrupteur, absent = comportement source historique. */
  webSearchOn?: boolean;
  onToggleWebSearch?: () => void;
  webSearchDisabled?: boolean;
  /** Stop button (chat, while running). */
  stopButton?: ReactNode;
  /** Masque le bouton globe (source web) — accueil uniquement. */
  hideSource?: boolean;

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
    submitLabel,
    sourceOpen,
    onToggleSource,
    source,
    onSourceChange,
    menuOpen,
    onToggleMenu,
    menu,
    dotId,
    modelValue,
    modelOptions,
    defaultModelLabel,
    onModelSaved,
    onModelError,
    reasoningEffort,
    onSetReasoningEffort,
    reasoningDisabled,
    reasoningLevels,
    reasoningMandatory,
    voiceButton,
    stopButton,
    webSearchOn,
    onToggleWebSearch,
    webSearchDisabled,
    hideSource,
    attachmentCards,
    note,
    textareaRef,
  } = props;

  // Auto-agrandissement du textarea : suit le contenu jusqu'à max-height (120px),
  // puis le texte défile à l'intérieur. Sans ça, un long message reste écrasé
  // sur une ligne et le texte « casse » visuellement.
  const innerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = innerRef.current;
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
          {onToggleWebSearch ? (
            <button
              type="button"
              className={`icon-button globe-toggle ${webSearchOn ? 'active' : ''}`}
              aria-label="Recherche web"
              title={
                webSearchDisabled
                  ? 'Recherche web désactivée dans Réglages'
                  : webSearchOn
                    ? 'Recherche web activée (méthode classique, sans ordinateur) — cliquez pour désactiver'
                    : 'Recherche web désactivée — cliquez pour activer (méthode classique, sans ordinateur)'
              }
              aria-pressed={webSearchOn ?? false}
              disabled={webSearchDisabled}
              onClick={onToggleWebSearch}
            >
              <Globe size={17} />
            </button>
          ) : (
            !hideSource && (
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
            )
          )}
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
            aria-label={`Réflexion : ${reasoningEffortLabel(reasoningEffort)}`}
            title={`Réflexion : ${reasoningEffortLabel(reasoningEffort)} — cliquez pour revenir au Standard (auto)`}
            onClick={() => onSetReasoningEffort(null)}
            disabled={reasoningDisabled}
          >
            <Brain size={17} />
          </button>
          {reasoningLevels === null ? (
            <select
              className="model-select reasoning-select"
              aria-label="Variantes de raisonnement"
              title="En attente — source native pas encore ajoutée pour ce provider"
              disabled
              value="auto"
            >
              <option value="auto">Standard (auto)</option>
            </select>
          ) : (
            <select
              className="model-select reasoning-select"
              aria-label="Variante de raisonnement"
              title="Niveau natif du modèle ; grisé = non supporté nativement"
              value={reasoningEffort ?? 'auto'}
              disabled={reasoningDisabled}
              onChange={(e) =>
                onSetReasoningEffort(
                  e.target.value === 'auto' ? null : e.target.value,
                )
              }
            >
              <option value="auto">Standard (auto)</option>
              <option value="none" disabled={reasoningMandatory}>
                Désactivée
              </option>
              {(
                [
                  ['low', 'Basse'],
                  ['medium', 'Moyenne'],
                  ['high', 'Haute'],
                  ['max', 'Max'],
                ] as const
              ).map(([value, label]) => {
                const native =
                  reasoningLevels === undefined ||
                  reasoningLevels.includes(value);
                // Icône Brain : un appui revient toujours à la variante Défaut
                // (Standard, auto) — le select à côté sert au choix direct.

                return (
                  <option
                    key={value}
                    value={value}
                    disabled={!native}
                    title={
                      native
                        ? undefined
                        : `« ${label.toLowerCase()} » non supporté nativement par ce modèle`
                    }
                  >
                    {label}
                  </option>
                );
              })}
            </select>
          )}
          {stopButton}
          {submitLabel ? (
            <button
              className="send-button send-labeled"
              aria-label={submitAriaLabel}
              title={submitTitle}
              disabled={submitDisabled}
            >
              {submitLabel}
              <ArrowUp size={16} />
            </button>
          ) : (
            <button
              className="send-button"
              aria-label={submitAriaLabel}
              title={submitTitle}
              disabled={submitDisabled}
            >
              <ArrowUp size={19} />
            </button>
          )}
        </div>
      </div>
      <div className="chat-compose-note">{note}</div>
    </form>
  );
}
