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
 * Barre d'actions sous une réponse de l'assistant : copier, réessayer
 * (dernière réponse uniquement), avis local, lecture vocale via la synthèse
 * du navigateur (`speechSynthesis`, voix FR si disponible).
 */
export function MessageActions({
  messageId,
  text,
  isLast,
  running,
  onRetry,
}: {
  messageId: string;
  text: string;
  isLast: boolean;
  running: boolean;
  onRetry: () => void;
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

  const castVote = (value: 1 | -1) => {
    const next = vote === value ? 0 : value;
    setVote(next);
    try {
      const votes = readVotes();
      if (next === 0) delete votes[messageId];
      else votes[messageId] = next;
      localStorage.setItem(VOTES_KEY, JSON.stringify(votes));
    } catch {
      /* avis best-effort */
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
        aria-label="Mauvaise réponse"
        aria-pressed={vote === -1}
        title="Je n’aime pas"
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
    </div>
  );
}
