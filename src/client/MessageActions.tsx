import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { api } from './api';

/** Avis stockés côté navigateur (pas de backend) : messageId → 1 | -1. */
const VOTES_KEY = 'nevadots-votes';
function readVotes(): Record<string, 1 | -1> {
  try {
    const raw = localStorage.getItem(VOTES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const votes: Record<string, 1 | -1> = {};
    for (const [key, value] of Object.entries(parsed))
      if (value === 1 || value === -1) votes[key] = value;
    return votes;
  } catch {
    return {};
  }
}

/** Texte brut approximatif pour la lecture vocale (sans symboles Markdown). */
function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' bloc de code ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[>\s-]+/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

/**
 * Barre d'actions sous une réponse de l'assistant : copier, régénérer
 * (dernière réponse uniquement), avis (persisté serveur pour correction),
 * lecture vocale via la synthèse du navigateur (`speechSynthesis`, voix FR
 * si disponible). Un « je n'aime pas » ouvre un formulaire : le commentaire
 * explique quoi corriger.
 */
export function MessageActions({
  messageId,
  text,
  isLast,
  running,
  onRetry,
  threadId,
  dotId,
  model,
}: {
  messageId: string;
  text: string;
  isLast: boolean;
  running: boolean;
  onRetry: () => void;
  threadId?: string;
  dotId?: string;
  model?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [vote, setVote] = useState<1 | -1 | 0>(() => {
    try {
      return readVotes()[messageId] ?? 0;
    } catch {
      return 0;
    }
  });
  const [formOpen, setFormOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(
    () => () => {
      window.speechSynthesis?.cancel();
    },
    [],
  );

  const copy = async () => {
    await copyText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const toggleSpeech = () => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(stripForSpeech(text));
    utter.lang = 'fr-FR';
    const voice = synth
      .getVoices()
      .find((entry) => entry.lang.toLowerCase().startsWith('fr'));
    if (voice) utter.voice = voice;
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    synth.speak(utter);
    setSpeaking(true);
  };

  const persistLocal = (next: 1 | -1 | 0) => {
    try {
      const votes = readVotes();
      if (next === 0) delete votes[messageId];
      else votes[messageId] = next;
      localStorage.setItem(VOTES_KEY, JSON.stringify(votes));
    } catch {
      /* avis best-effort */
    }
  };

  /** Envoie le vote au serveur (volet Feedback) ; l'avis local reste
   *  affiché même si l'envoi échoue. */
  const postFeedback = async (value: 1 | -1, text?: string) => {
    try {
      await api('/feedback', 'POST', {
        messageId,
        vote: value,
        comment: text ?? null,
        threadId: threadId ?? null,
        dotId: dotId ?? null,
        model: model ?? null,
      });
    } catch {
      /* best-effort */
    }
  };

  const castVote = (value: 1 | -1) => {
    const next = vote === value ? 0 : value;
    if (value === -1 && next === -1) {
      // Dislike : on demande pourquoi avant d'enregistrer.
      setFormError('');
      setFormOpen(true);
      return;
    }
    setFormOpen(false);
    setVote(next);
    persistLocal(next);
    if (next === 0) {
      void api(`/feedback/${encodeURIComponent(messageId)}`, 'DELETE').catch(
        () => {},
      );
    } else void postFeedback(next);
  };

  const submitFeedback = async () => {
    if (sending) return;
    setSending(true);
    setFormError('');
    try {
      await api('/feedback', 'POST', {
        messageId,
        vote: -1,
        comment: comment.trim() || null,
        threadId: threadId ?? null,
        dotId: dotId ?? null,
        model: model ?? null,
      });
      setVote(-1);
      persistLocal(-1);
      setFormOpen(false);
      setComment('');
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : 'Envoi impossible.',
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="message-actions" role="toolbar" aria-label="Actions">
      <button
        type="button"
        className="icon-button"
        aria-label={copied ? 'Copié' : 'Copier la réponse'}
        title={copied ? 'Copié' : 'Copier'}
        onClick={() => void copy()}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      {isLast && (
        <button
          type="button"
          className="icon-button"
          aria-label="Régénérer la réponse"
          title="Régénérer"
          disabled={running}
          onClick={onRetry}
        >
          <RotateCcw size={14} />
        </button>
      )}
      <button
        type="button"
        className={`icon-button ${vote === 1 ? 'active' : ''}`}
        aria-label="Bonne réponse"
        aria-pressed={vote === 1}
        title="J’aime"
        onClick={() => castVote(1)}
      >
        <ThumbsUp size={14} />
      </button>
      <button
        type="button"
        className={`icon-button ${vote === -1 ? 'active' : ''}`}
        aria-label="Je n’aime pas cette réponse"
        aria-pressed={vote === -1}
        title="Je n’aime pas — dire pourquoi"
        onClick={() => castVote(-1)}
      >
        <ThumbsDown size={14} />
      </button>
      <button
        type="button"
        className={`icon-button ${speaking ? 'active' : ''}`}
        aria-label={speaking ? 'Arrêter la lecture' : 'Lire à voix haute'}
        title={speaking ? 'Arrêter' : 'Lire à voix haute'}
        onClick={toggleSpeech}
      >
        {speaking ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </button>
      {formOpen && (
        <form
          className="feedback-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitFeedback();
          }}
        >
          <label htmlFor={`feedback-${messageId}`}>
            Qu’est-ce qui ne va pas ? (ça nous aide à corriger)
          </label>
          <textarea
            id={`feedback-${messageId}`}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Ex. : la commande ne marche pas sur Debian…"
            rows={2}
            maxLength={2000}
            autoFocus
          />
          {formError && (
            <p className="feedback-error" role="alert">
              {formError}
            </p>
          )}
          <div className="feedback-actions">
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setFormOpen(false);
                setFormError('');
              }}
            >
              Annuler
            </button>
            <button type="submit" className="primary" disabled={sending}>
              {sending ? 'Envoi…' : 'Envoyer le retour'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
