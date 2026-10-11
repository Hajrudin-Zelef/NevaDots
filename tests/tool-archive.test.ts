import { describe, expect, it } from 'vitest';
import {
  archiveResult,
  hasArchives,
  recallArchived,
  searchArchived,
} from '../src/server/tool-archive.js';

describe('tool archive', () => {
  it('archives once and dedupes identical keys', () => {
    const first = archiveResult('t1', 'call-1', 'tool result', 'alpha bravo');
    const again = archiveResult('t1', 'call-1', 'tool result', 'alpha bravo');
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id);
    expect(recallArchived(first.id)?.text).toBe('alpha bravo');
  });

  it('tracks per-thread archives', () => {
    expect(hasArchives('thread-x')).toBe(false);
    archiveResult('thread-x', 'k', 'tool result', 'content');
    expect(hasArchives('thread-x')).toBe(true);
    expect(hasArchives('thread-y')).toBe(false);
  });

  it('searches archived results scoped to a thread', () => {
    archiveResult('t2', 'a', 'tool result', 'the terminal listed files');
    archiveResult('t2', 'b', 'tool result', 'unrelated payload');
    archiveResult('t3', 'c', 'tool result', 'files in another thread');
    const found = searchArchived('t2', 'files terminal');
    expect(found.map((entry) => entry.id)).toHaveLength(1);
    expect(found[0].text).toContain('terminal listed files');
  });

  it('returns no matches for short or unknown terms', () => {
    expect(searchArchived('t2', 'a')).toHaveLength(0);
  });
});
