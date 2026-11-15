import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Brouillon persisté du composer (Lot 5, étape 2).
 *
 * Clés `nevadots:draft:thread:<id>` / `nevadots:draft:home:<dotId>` — même
 * convention que les pièces jointes (`nevadots:attachments:<scope>`).
 * Cap LRU 20 brouillons : au-delà, le plus ancien est effacé du stockage.
 *
 * Règles de vie du brouillon :
 * - chargé au montage (ou au changement de contexte) ;
 * - sauvé à chaque frappe (debounce léger, 150 ms) ;
 * - vidé seulement après `addMessage` réussi (via `clearDraft`) ;
 * - restauré en cas d'échec si le composer n'a pas changé depuis
 *   (via `restoreDraft`, écriture immédiate, pas de debounce).
 */

export const DRAFT_LRU_KEY = 'nevadots:drafts:lru';
export const MAX_DRAFTS = 20;
const DRAFT_DEBOUNCE_MS = 150;

export function draftKey(scope: string): string {
  return `nevadots:draft:${scope}`;
}

function storageAvailable(): boolean {
  return typeof localStorage !== 'undefined';
}

function readLru(): string[] {
  if (!storageAvailable()) return [];
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(DRAFT_LRU_KEY) ?? '[]',
    );
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is string =>
            typeof entry === 'string' && entry.length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

function writeLru(keys: string[]): void {
  if (!storageAvailable()) return;
  try {
    localStorage.setItem(DRAFT_LRU_KEY, JSON.stringify(keys));
  } catch {
    // Quota dépassé ou stockage indisponible : on continue sans LRU.
  }
}

/** Remet la clé en tête de file LRU et évince les plus anciennes au-delà du cap. */
function touchDraftKey(key: string): void {
  const keys = readLru().filter((entry) => entry !== key);
  keys.push(key);
  while (keys.length > MAX_DRAFTS) {
    const evicted = keys.shift();
    if (evicted && evicted !== key) {
      try {
        localStorage.removeItem(evicted);
      } catch {
        // Ignoré : la clé évincée sera simplement re-proposée vide.
      }
    }
  }
  writeLru(keys);
}

function untouchDraftKey(key: string): void {
  writeLru(readLru().filter((entry) => entry !== key));
}

export function loadDraft(scope: string): string {
  if (!storageAvailable()) return '';
  try {
    return localStorage.getItem(draftKey(scope)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(scope: string, text: string): void {
  if (!storageAvailable()) return;
  const key = draftKey(scope);
  try {
    if (!text) {
      localStorage.removeItem(key);
      untouchDraftKey(key);
      return;
    }
    localStorage.setItem(key, text);
    touchDraftKey(key);
  } catch {
    // Quota dépassé ou stockage indisponible : on continue sans persistance.
  }
}

export function clearDraft(scope: string): void {
  saveDraft(scope, '');
}

export interface PromptDraft {
  /** Brouillon courant (chargé au montage, sauvé à chaque frappe). */
  draft: string;
  /** Valeur courante sans re-rendu (pour les callbacks async d'envoi). */
  draftRef: { current: string };
  /** Met à jour le brouillon (sauvegarde debouncée). */
  setDraft: (value: string | ((current: string) => string)) => void;
  /** Vide le brouillon (état + stockage), après envoi réussi. */
  clearDraft: () => void;
  /** Réécrit le brouillon immédiatement (restauration après échec). */
  restoreDraft: (text: string) => void;
}

/**
 * Brouillon persisté pour un contexte (`thread:<id>` ou `home:<dotId>`).
 * Le changement de `scope` recharge le brouillon du nouveau contexte.
 */
export function usePromptDraft(scope: string): PromptDraft {
  const [draft, setDraftState] = useState(() => loadDraft(scope));
  const scopeRef = useRef(scope);
  const draftRef = useRef(draft);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    scopeRef.current = scope;
    const loaded = loadDraft(scope);
    draftRef.current = loaded;
    setDraftState(loaded);
  }, [scope]);

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    },
    [],
  );

  const setDraft = useCallback(
    (value: string | ((current: string) => string)) => {
      setDraftState((current) => {
        const next = typeof value === 'function' ? value(current) : value;
        draftRef.current = next;
        if (timerRef.current !== undefined) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(
          () => saveDraft(scopeRef.current, next),
          DRAFT_DEBOUNCE_MS,
        );
        return next;
      });
    },
    [],
  );

  const clear = useCallback(() => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    draftRef.current = '';
    setDraftState('');
    clearDraft(scopeRef.current);
  }, []);

  const restore = useCallback((text: string) => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    draftRef.current = text;
    setDraftState(text);
    saveDraft(scopeRef.current, text);
  }, []);

  return {
    draft,
    draftRef,
    setDraft,
    clearDraft: clear,
    restoreDraft: restore,
  };
}
