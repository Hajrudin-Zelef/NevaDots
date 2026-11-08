import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Pause,
  Play,
  RotateCcw,
  Square,
  ThumbsDown,
  ThumbsUp,
  Volume2,
} from 'lucide-react';
import { api } from './api';
import {
  groupBlocksForApi,
  pickFrenchVoice,
  playAudioQueue,
  prepareSpeechBlocks,
  speakBrowser,
  type PlaybackControl,
} from './speech-engine';
import type { Settings } from '../shared/types';

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

/** Une seule lecture à la fois dans tout le transcript. */
let activeStop: (() => void) | null = null;

/** Coupe toute lecture en cours (envoi, régénération, démontage). */
export function stopAllSpeech(): void {
  activeStop?.();
  activeStop = null;
}

export type SpeechPhase = 'idle' | 'loading' | 'speaking' | 'paused';

/** Réglages voix consommés par la lecture (issus des Réglages globaux). */
export interface SpeechTtsSettings {
  mode: Settings['ttsMode'];
  voice: string;
  rate: number;
  pauseSentenceMs: number;
  pauseParagraphMs: number;
  provider: string | null;
  model: string | null;
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
 * lecture vocale structurée (pauses calibrées, voix triées, neuronal si
 * configuré). Un « je n'aime pas » ouvre un formulaire : le commentaire
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
  tts,
}: {
  messageId: string;
  text: string;
  isLast: boolean;
  running: boolean;
  onRetry: () => void;
  threadId?: string;
  dotId?: string;
  model?: string;
  /** Réglages voix (Réglages globaux) ; absents = valeurs sûres navigateur. */
  tts?: SpeechTtsSettings;
}) {
  const [copied, setCopied] = useState(false);
  const [phase, setPhase] = useState<SpeechPhase>('idle');
  const [speechError, setSpeechError] = useState('');
  const controlRef = useRef<PlaybackControl | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const ttsSettings: SpeechTtsSettings = tts ?? {
    mode: 'browser',
    voice: '',
    rate: 1,
    pauseSentenceMs: 300,
    pauseParagraphMs: 600,
    provider: null,
    model: null,
  };
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
      abortRef.current?.abort();
      controlRef.current?.stop();
      activeStop = null;
    },
    [],
  );

  const copy = async () => {
    await copyText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const finishSpeech = () => {
    controlRef.current = null;
    abortRef.current = null;
    setPhase('idle');
  };

  const failSpeech = (error: Error) => {
    controlRef.current = null;
    abortRef.current = null;
    setPhase('idle');
    setSpeechError(error.message);
  };

  const speak = async () => {
    if (phase === 'speaking' || phase === 'loading') return;
    setSpeechError('');
    activeStop?.();
    const blocks = prepareSpeechBlocks(text, {
      sentenceMs: ttsSettings.pauseSentenceMs,
      paragraphMs: ttsSettings.pauseParagraphMs,
    });
    if (!blocks.length) {
      setSpeechError('Rien à lire.');
      return;
    }
    const useModel =
      ttsSettings.mode === 'model' && ttsSettings.provider && ttsSettings.model;
    if (!useModel) {
      const synth = window.speechSynthesis;
      if (!synth) {
        setSpeechError('Synthèse vocale indisponible dans ce navigateur.');
        return;
      }
      const voiceUri = pickFrenchVoice(synth.getVoices(), ttsSettings.voice);
      const voice =
        synth.getVoices().find((v) => v.voiceURI === voiceUri) ?? undefined;
      if (!voice) {
        setSpeechError(
          'Aucune voix française installée. Installez une voix FR pour écouter.',
        );
        return;
      }
      const control = speakBrowser(blocks, {
        synth,
        voice,
        rate: ttsSettings.rate,
        onend: finishSpeech,
        onerror: failSpeech,
      });
      controlRef.current = control;
      activeStop = () => control.stop();
      setPhase('speaking');
      return;
    }
    // Neuronal : découpe en requêtes ≤3000 car., lecture enchaînée.
    setPhase('loading');
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const groups = groupBlocksForApi(blocks);
      const blobs: Blob[] = [];
      for (const group of groups) {
        if (abort.signal.aborted) return;
        const response = await fetch('/api/tts', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: group,
            voice: ttsSettings.voice || undefined,
            model: ttsSettings.model,
            provider: ttsSettings.provider,
            speed: ttsSettings.rate,
          }),
          signal: abort.signal,
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(
            body.error ?? `Voix neuronale indisponible (${response.status}).`,
          );
        }
        blobs.push(await response.blob());
      }
      if (abort.signal.aborted || !blobs.length) return;
      const control = playAudioQueue(blobs, {
        rate: ttsSettings.rate,
        onend: finishSpeech,
        onerror: failSpeech,
      });
      controlRef.current = control;
      activeStop = () => control.stop();
      setPhase('speaking');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      failSpeech(
        error instanceof Error ? error : new Error('Lecture impossible.'),
      );
    }
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
      // Retrait par (compte, message) : route auteur, pas l'id de ligne (H3).
      void api(
        `/api/feedback/by-message/${encodeURIComponent(messageId)}`,
        'DELETE',
      ).catch(() => {});
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
      {phase === 'idle' && (
        <button
          type="button"
          className="icon-button"
          aria-label="Lire à voix haute"
          title="Lire à voix haute"
          onClick={() => void speak()}
        >
          <Volume2 size={14} />
        </button>
      )}
      {phase === 'loading' && (
        <span className="muted" role="status">
          Préparation…
        </span>
      )}
      {phase === 'speaking' && (
        <button
          type="button"
          className="icon-button"
          aria-label="Mettre la lecture en pause"
          title="Pause"
          onClick={() => {
            controlRef.current?.pause();
            setPhase('paused');
          }}
        >
          <Pause size={14} />
        </button>
      )}
      {phase === 'paused' && (
        <button
          type="button"
          className="icon-button"
          aria-label="Reprendre la lecture"
          title="Reprendre"
          onClick={() => {
            controlRef.current?.resume();
            setPhase('speaking');
          }}
        >
          <Play size={14} />
        </button>
      )}
      {(phase === 'speaking' || phase === 'paused') && (
        <button
          type="button"
          className="icon-button"
          aria-label="Arrêter la lecture"
          title="Arrêter"
          onClick={() => {
            abortRef.current?.abort();
            controlRef.current?.stop();
            finishSpeech();
          }}
        >
          <Square size={14} />
        </button>
      )}
      {speechError && (
        <p className="feedback-error" role="alert">
          {speechError}
        </p>
      )}
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
