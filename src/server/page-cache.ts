import { randomUUID } from 'node:crypto';

/**
 * Server-side cache of pages read during a turn. Tools return a compact
 * outline plus a short head excerpt and a `pageId`; the model retrieves the
 * parts it needs with `read_page_slice` / `grep_page` instead of receiving the
 * whole page in every prompt iteration. Entries are ephemeral (memory only).
 */
export interface CachedPage {
  id: string;
  title: string;
  url: string;
  text: string;
  lines: string[];
  createdAt: number;
}

const PAGE_TTL_MS = 10 * 60 * 1000;
const MAX_PAGES = 40;
const HEAD_CHARS = 1500;
const MAX_HEADINGS = 60;
const SLICE_DEFAULT = 120;
const SLICE_MAX = 500;
const GREP_MAX = 25;
const GREP_CONTEXT = 1;

const pages = new Map<string, CachedPage>();

function sweep(now = Date.now()) {
  for (const [id, page] of pages)
    if (now - page.createdAt > PAGE_TTL_MS) pages.delete(id);
}

export function cachePage(title: string, url: string, text: string): CachedPage {
  sweep();
  const page: CachedPage = {
    id: randomUUID().slice(0, 8),
    title,
    url,
    text,
    lines: text.split('\n'),
    createdAt: Date.now(),
  };
  pages.set(page.id, page);
  while (pages.size > MAX_PAGES) {
    const oldest = pages.keys().next().value;
    if (oldest === undefined) break;
    pages.delete(oldest);
  }
  return page;
}

export function cachedPage(id: string): CachedPage | undefined {
  sweep();
  return pages.get(id);
}

function headingsOf(lines: string[]): string[] {
  const headings: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (match) headings.push(`${index + 1}: ${match[2].slice(0, 120)}`);
    if (headings.length >= MAX_HEADINGS) break;
  }
  return headings;
}

export interface PageSummary {
  title: string;
  url: string;
  pageId: string;
  lines: number;
  chars: number;
  headings: string[];
  head: string;
  note: string;
}

export function summarizePage(page: CachedPage): PageSummary {
  const headings = headingsOf(page.lines);
  const omitted = Math.max(0, page.text.length - HEAD_CHARS);
  return {
    title: page.title,
    url: page.url,
    pageId: page.id,
    lines: page.lines.length,
    chars: page.text.length,
    headings,
    head: page.text.slice(0, HEAD_CHARS),
    note: omitted
      ? `${omitted} more characters omitted. Use read_page_slice or grep_page with pageId "${page.id}" to read specific line ranges.`
      : 'This page is short and shown in full.',
  };
}

export function slicePage(id: string, from: number, to?: number) {
  const page = cachedPage(id);
  if (!page) throw new Error('That pageId is unknown or expired. Read the page again.');
  const total = page.lines.length;
  const start = Math.max(1, Math.floor(from));
  const end = Math.min(total, Math.max(start, Math.floor(to ?? start + SLICE_DEFAULT - 1)));
  if (end - start + 1 > SLICE_MAX)
    throw new Error(`Request at most ${SLICE_MAX} lines per slice.`);
  return {
    pageId: id,
    url: page.url,
    from: start,
    to: end,
    totalLines: total,
    text: page.lines.slice(start - 1, end).join('\n'),
    note:
      end < total
        ? `${total - end} lines below remain; call read_page_slice again with from=${end + 1}.`
        : 'End of page reached.',
  };
}

export function grepPage(id: string, query: string) {
  const page = cachedPage(id);
  if (!page) throw new Error('That pageId is unknown or expired. Read the page again.');
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error('Provide a non-empty search query.');
  const matches: { line: number; text: string }[] = [];
  for (let index = 0; index < page.lines.length; index++) {
    if (!page.lines[index].toLowerCase().includes(needle)) continue;
    const start = Math.max(0, index - GREP_CONTEXT);
    const end = Math.min(page.lines.length, index + GREP_CONTEXT + 1);
    matches.push({
      line: start + 1,
      text: page.lines.slice(start, end).join('\n').slice(0, 600),
    });
    if (matches.length >= GREP_MAX) break;
  }
  return {
    pageId: id,
    query,
    totalLines: page.lines.length,
    matches,
    note: matches.length
      ? 'Use read_page_slice with the shown line numbers for more context.'
      : 'No line matched. Try a different or shorter keyword.',
  };
}
