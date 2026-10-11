import { createHash } from 'node:crypto';

/**
 * Verbatim archive of large tool results that were truncated before being sent
 * back to the model. The model can retrieve them by id with `recall`, or search
 * across them with `recall_search`, so nothing is silently lost. Memory only.
 */
export interface ArchivedResult {
  id: string;
  threadId: string;
  label: string;
  text: string;
  createdAt: number;
}

const ARCHIVE_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 200;
const SEARCH_LIMIT = 5;
const SEARCH_MAX = 20;

const entries = new Map<string, ArchivedResult>();
const byThread = new Map<string, string[]>();

function sweep(now = Date.now()) {
  for (const [id, entry] of entries)
    if (now - entry.createdAt > ARCHIVE_TTL_MS) {
      entries.delete(id);
      const list = byThread.get(entry.threadId);
      if (list) byThread.set(entry.threadId, list.filter((x) => x !== id));
    }
}

export function archiveResult(
  threadId: string,
  key: string,
  label: string,
  text: string,
): { id: string; created: boolean } {
  sweep();
  const digest = createHash('sha1').update(key).digest('hex').slice(0, 8);
  const id = `r${digest}`;
  if (entries.has(id)) return { id, created: false };
  entries.set(id, { id, threadId, label, text, createdAt: Date.now() });
  const list = byThread.get(threadId) ?? [];
  list.push(id);
  byThread.set(threadId, list);
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    const entry = entries.get(oldest)!;
    entries.delete(oldest);
    const refs = byThread.get(entry.threadId);
    if (refs) byThread.set(entry.threadId, refs.filter((x) => x !== oldest));
  }
  return { id, created: true };
}

export function hasArchives(threadId: string): boolean {
  sweep();
  return (byThread.get(threadId)?.length ?? 0) > 0;
}

export function recallArchived(id: string): ArchivedResult | undefined {
  sweep();
  return entries.get(id);
}

export function searchArchived(
  threadId: string,
  query: string,
  limit = SEARCH_LIMIT,
): ArchivedResult[] {
  sweep();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1)
    .slice(0, 16);
  if (!terms.length) return [];
  const ids = byThread.get(threadId) ?? [];
  const scored = ids
    .map((id) => entries.get(id))
    .filter((entry): entry is ArchivedResult => Boolean(entry))
    .map((entry) => {
      const haystack = entry.text.toLowerCase();
      const score = terms.reduce(
        (total, term) => total + (haystack.split(term).length - 1),
        0,
      );
      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt)
    .slice(0, Math.min(limit, SEARCH_MAX));
  return scored.map(({ entry }) => entry);
}
