/**
 * Moteur de lecture vocale unifié (navigateur + neuronal).
 * - `prepareSpeechBlocks` : Markdown → blocs texte + pauses (titres annoncés,
 *   listes/tableaux/code/URLs nettoyés, abréviations étendues).
 * - Navigateur : `speakBrowser` enchaîne des phrases courtes (pas de coupure
 *   Chrome), voix FR triées, pauses calibrées, watchdog anti-blocage.
 * - Neuronal : `groupBlocksForApi` découpe en requêtes ≤3000 car. et
 *   `playAudioQueue` enchaîne les blobs audio reçus du serveur.
 */

/** Un morceau à lire, suivi d'une pause calibrée. */
export interface SpeechBlock {
  text: string;
  /** Pause après ce bloc, en ms (phrase vs paragraphe). */
  pauseAfterMs: number;
}

export interface SpeechPauses {
  sentenceMs: number;
  paragraphMs: number;
}

const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bex\./g, 'exemple'],
  [/\bMme\b/g, 'Madame'],
  [/\bMlle\b/g, 'Mademoiselle'],
  [/\bDr\b/g, 'Docteur'],
  [/\bPr\b/g, 'Professeur'],
  [/\bM\.(?=\s+[A-ZÀ-Þ])/g, 'Monsieur'],
  [/\bSt\b/g, 'Saint'],
  [/\bSte\b/g, 'Sainte'],
  [/\bcf\./g, 'confer'],
];

function expandAbbreviations(text: string): string {
  let out = text;
  for (const [pattern, replacement] of ABBREVIATIONS)
    out = out.replace(pattern, replacement);
  return out;
}

/** Résume un tableau GFM en phrases lisibles (en-têtes + lignes). */
function tableToSpeech(lines: string[]): string[] {
  const rows = lines
    .map((line) => line.trim())
    .filter((line) => /^\|.*\|$/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim().replace(/\*\*/g, '')),
    )
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
  if (!rows.length) return [];
  const [header, ...body] = rows;
  const out = [`Tableau de ${body.length} ligne${body.length > 1 ? 's' : ''}.`];
  const colNames = header.map((cell, i) => cell || `colonne ${i + 1}`);
  body.slice(0, 20).forEach((cells, index) => {
    const parts = cells.map(
      (cell, i) => `${colNames[i] ?? `colonne ${i + 1}`} : ${cell || 'vide'}`,
    );
    out.push(`Ligne ${index + 1} : ${parts.join(', ')}.`);
  });
  return out;
}

/**
 * Convertit du Markdown en blocs lisibles : conserve la structure qui
 * porte la prosodie (titres, paragraphes, listes), neutralise le reste
 * (code, tableaux résumés, URLs réduites, emojis supprimés).
 */
export function prepareSpeechBlocks(
  markdown: string,
  pauses: SpeechPauses,
): SpeechBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const parts: { text: string; paragraph: boolean }[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Bloc de code : résumé (court = lu, long = annoncé seulement).
    if (/^```/.test(line.trim())) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // clôture
      const code = body.join('\n').trim();
      parts.push({
        text:
          code && code.length <= 120
            ? `Bloc de code : ${code}`
            : 'Bloc de code.',
        paragraph: true,
      });
      continue;
    }
    // Tableau GFM : résumé ligne par ligne.
    if (/^\|.*\|$/.test(line.trim())) {
      const table: string[] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        table.push(lines[i]);
        i += 1;
      }
      for (const sentence of tableToSpeech(table))
        parts.push({ text: sentence, paragraph: true });
      continue;
    }
    // Titre : annoncé.
    const heading = /^(#{1,3})\s+(.*)$/.exec(line.trim());
    if (heading) {
      parts.push({ text: `Titre : ${heading[2].trim()}`, paragraph: true });
      i += 1;
      continue;
    }
    // Ligne vide = respiration de paragraphe (fusionnée ensuite).
    if (!line.trim()) {
      parts.push({ text: '', paragraph: true });
      i += 1;
      continue;
    }
    parts.push({ text: line, paragraph: false });
    i += 1;
  }
  const cleaned = parts
    .map((part) => {
      const text = part.text
        // Images → texte alternatif.
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        // Liens → intitulé (+ domaine si l'URL est informative).
        .replace(
          /\[([^\]]+)\]\(([^)]+)\)/g,
          (_m, label: string, url: string) => {
            const host = /^https?:\/\/([^/]+)/i.exec(url)?.[1];
            return host && !label.includes(host)
              ? `${label}, lien ${host}`
              : label;
          },
        )
        // Code inline → lu tel quel.
        .replace(/`([^`]+)`/g, '$1')
        // Puces et citations en tête de ligne.
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/^\s*>+\s?/gm, '')
        // Gras/italique/barré.
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1$2')
        .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1$2')
        .replace(/~~(.*?)~~/g, '$1')
        // Emojis et symboles décoratifs supprimés.
        .replace(/\p{Extended_Pictographic}/gu, '')
        .replace(/[\u2600-\u27BF\u2B00-\u2BFF]/g, '')
        .replace(/[*_~|#]/g, '')
        .trim();
      return { text: expandAbbreviations(text), paragraph: part.paragraph };
    })
    .filter((part) => part.text.length > 0);
  // Découpe en phrases (jamais au milieu d'un mot), ≤200 caractères.
  const blocks: SpeechBlock[] = [];
  const pushSentences = (text: string, paragraph: boolean) => {
    const sentences = text
      .split(/(?<=[.!?…])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const sentence of sentences) {
      if (sentence.length <= 200) {
        blocks.push({
          text: sentence,
          pauseAfterMs: paragraph ? pauses.paragraphMs : pauses.sentenceMs,
        });
        continue;
      }
      const chunks = sentence.split(/[,;:]\s+/);
      let current = '';
      const flush = () => {
        if (current.trim()) {
          blocks.push({
            text: current.trim(),
            pauseAfterMs: pauses.sentenceMs,
          });
          current = '';
        }
      };
      for (const chunk of chunks) {
        if (`${current} ${chunk}`.trim().length > 200) flush();
        current = `${current} ${chunk}`.trim();
      }
      flush();
      if (blocks.length)
        blocks[blocks.length - 1].pauseAfterMs = paragraph
          ? pauses.paragraphMs
          : pauses.sentenceMs;
    }
  };
  let pendingParagraph = false;
  for (const part of cleaned) {
    // Les lignes d'un même paragraphe se lisent à la suite.
    pushSentences(part.text, part.paragraph);
    pendingParagraph = part.paragraph;
  }
  void pendingParagraph;
  return blocks.filter((block) => block.text.length > 0);
}

/** Tri des voix FR : naturelles d'abord (Google > Microsoft), puis locales. */
export function pickFrenchVoice(
  voices: ReadonlyArray<{
    name: string;
    lang: string;
    voiceURI: string;
    localService?: boolean;
  }>,
  preferredURI?: string,
): string | null {
  if (preferredURI && voices.some((voice) => voice.voiceURI === preferredURI))
    return preferredURI;
  const scored = voices
    .filter((voice) => voice.lang.toLowerCase().startsWith('fr'))
    .map((voice) => {
      const name = voice.name.toLowerCase();
      let score = voice.lang.toLowerCase() === 'fr-fr' ? 5 : 3;
      if (name.includes('google') && name.includes('fran')) score += 10;
      else if (name.includes('hortense') || name.includes('denise')) score += 8;
      else if (!voice.localService) score += 2;
      return { voice, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.voice.voiceURI ?? null;
}

/** Voix françaises disponibles, naturelles d'abord puis ordre
 *  alphabétique (déterministe pour les Réglages). */
export function listFrenchVoices(
  voices: ReadonlyArray<{
    name: string;
    lang: string;
    voiceURI: string;
    localService?: boolean;
  }>,
): { uri: string; name: string; lang: string; natural: boolean }[] {
  return voices
    .filter((voice) => voice.lang.toLowerCase().startsWith('fr'))
    .map((voice) => {
      const name = voice.name.toLowerCase();
      const natural =
        (name.includes('google') && name.includes('fran')) ||
        name.includes('hortense') ||
        name.includes('denise') ||
        voice.localService === false;
      return {
        uri: voice.voiceURI,
        name: voice.name,
        lang: voice.lang,
        natural,
      };
    })
    .sort(
      (a, b) =>
        Number(b.natural) - Number(a.natural) || a.name.localeCompare(b.name),
    );
}

/** Toutes les voix du navigateur, françaises d'abord (même tri que
 *  `listFrenchVoices`), puis les autres par langue puis nom — avec badge
 *  de langue pour le sélecteur opt-in « Toutes les langues ». */
export function listAllVoices(
  voices: ReadonlyArray<{
    name: string;
    lang: string;
    voiceURI: string;
    localService?: boolean;
  }>,
): { uri: string; name: string; lang: string; natural: boolean }[] {
  const french = new Set(listFrenchVoices(voices).map((voice) => voice.uri));
  const others = voices
    .filter((voice) => !french.has(voice.voiceURI))
    .map((voice) => ({
      uri: voice.voiceURI,
      name: voice.name,
      lang: voice.lang,
      natural: false,
    }))
    .sort(
      (a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name),
    );
  return [...listFrenchVoices(voices), ...others];
}
export function groupBlocksForApi(
  blocks: SpeechBlock[],
  maxChars = 3000,
): string[] {
  const groups: string[] = [];
  let current = '';
  for (const block of blocks) {
    const candidate = current ? `${current} ${block.text}` : block.text;
    if (candidate.length > maxChars && current) {
      groups.push(current);
      current = block.text;
    } else {
      current = candidate;
    }
  }
  if (current) groups.push(current);
  return groups;
}

/** Contrôle d'une lecture en cours (pause/reprise/arrêt). */
export interface PlaybackControl {
  pause(): void;
  resume(): void;
  stop(): void;
}

interface SynthLike {
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
}

/**
 * Lit des blocs via la synthèse du navigateur, enchaînés phrase par
 * phrase avec les pauses calibrées (pas un seul bloc : pas de coupure
 * Chrome, prosodie conservée). Watchdog anti-blocage toutes les 4 s.
 */
export function speakBrowser(
  blocks: SpeechBlock[],
  options: {
    synth?: SynthLike;
    voice?: SpeechSynthesisVoice;
    rate?: number;
    onend?: () => void;
    onerror?: (error: Error) => void;
    onblock?: (index: number) => void;
  } = {},
): PlaybackControl {
  const synth = options.synth ?? window.speechSynthesis;
  const rate = options.rate ?? 1;
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let userPaused = false;
  let cancelled = false;
  let inGap = false;
  const cleanup = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (watchdog !== undefined) {
      clearInterval(watchdog);
      watchdog = undefined;
    }
  };
  const finish = () => {
    cleanup();
    options.onend?.();
  };
  const next = () => {
    if (cancelled || userPaused) return;
    if (index >= blocks.length) {
      finish();
      return;
    }
    inGap = false;
    const block = blocks[index];
    const utter = new SpeechSynthesisUtterance(block.text);
    utter.lang = 'fr-FR';
    utter.rate = rate;
    if (options.voice) utter.voice = options.voice;
    utter.onend = () => {
      if (cancelled) return;
      index += 1;
      options.onblock?.(index);
      if (index >= blocks.length) {
        finish();
        return;
      }
      inGap = true;
      timer = setTimeout(() => {
        timer = undefined;
        next();
      }, block.pauseAfterMs);
    };
    utter.onerror = (event) => {
      // cancel() local déclenche 'canceled'/'interrupted' : ignorer.
      if (cancelled) return;
      if (
        event.error === 'canceled' ||
        event.error === 'interrupted' ||
        userPaused
      )
        return;
      const error = new Error(`Lecture vocale impossible (${event.error}).`);
      options.onerror?.(error);
    };
    synth.speak(utter);
  };
  watchdog = setInterval(() => {
    if (!cancelled && !userPaused && synth.paused) synth.resume();
  }, 4000);
  next();
  return {
    pause() {
      userPaused = true;
      synth.pause();
    },
    resume() {
      if (cancelled) return;
      userPaused = false;
      if (inGap) {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        next();
        return;
      }
      synth.resume();
    },
    stop() {
      cancelled = true;
      userPaused = false;
      cleanup();
      synth.cancel();
    },
  };
}

/**
 * Enchaîne des blobs audio (voix neuronale) dans un seul élément audio :
 * pause/reprise natives, vitesse via playbackRate.
 */
export function playAudioQueue(
  blobs: Blob[],
  options: {
    audio?: HTMLAudioElement;
    rate?: number;
    onend?: () => void;
    onerror?: (error: Error) => void;
  } = {},
): PlaybackControl {
  const audio = options.audio ?? new Audio();
  const urls = blobs.map((blob) => URL.createObjectURL(blob));
  let index = 0;
  let cancelled = false;
  audio.playbackRate = options.rate ?? 1;
  audio.onerror = () => {
    if (cancelled) return;
    cleanup();
    options.onerror?.(new Error('Lecture audio impossible.'));
  };
  audio.onended = () => {
    if (cancelled) return;
    URL.revokeObjectURL(urls[index]);
    index += 1;
    if (index >= urls.length) {
      cleanup();
      options.onend?.();
      return;
    }
    audio.src = urls[index];
    void audio.play().catch(() => {
      if (!cancelled) {
        cleanup();
        options.onerror?.(new Error('Lecture audio impossible.'));
      }
    });
  };
  const cleanup = () => {
    for (let i = index; i < urls.length; i += 1) {
      try {
        URL.revokeObjectURL(urls[i]);
      } catch {
        /* déjà révoquée */
      }
    }
  };
  if (!urls.length) {
    options.onend?.();
  } else {
    audio.src = urls[0];
    void audio.play().catch(() => {
      if (!cancelled) {
        cleanup();
        options.onerror?.(new Error('Lecture audio impossible.'));
      }
    });
  }
  return {
    pause() {
      audio.pause();
    },
    resume() {
      if (cancelled) return;
      void audio.play().catch(() => {});
    },
    stop() {
      cancelled = true;
      audio.pause();
      audio.removeAttribute('src');
      cleanup();
    },
  };
}
