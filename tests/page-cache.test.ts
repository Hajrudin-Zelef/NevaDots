import { describe, expect, it } from 'vitest';
import {
  cachePage,
  cachedPage,
  grepPage,
  slicePage,
  summarizePage,
} from '../src/server/page-cache.js';

const doc = [
  '# Title',
  'Intro paragraph.',
  '## Section A',
  'Alpha detail line.',
  '## Section B',
  'Beta detail line.',
].join('\n');

describe('page cache', () => {
  it('summarizes a cached page with an outline, head and pageId', () => {
    const page = cachePage('Example', 'https://example.com', doc);
    const summary = summarizePage(page);
    expect(summary.pageId).toBe(page.id);
    expect(summary.url).toBe('https://example.com');
    expect(summary.lines).toBe(6);
    expect(summary.headings).toEqual(['1: Title', '3: Section A', '5: Section B']);
    expect(summary.head).toContain('Intro paragraph.');
    expect(summary.note).toContain('shown in full');
    expect(cachedPage(page.id)?.text).toBe(doc);
  });

  it('slices a line range and reports remaining lines', () => {
    const page = cachePage('Example', 'https://example.com', doc);
    const slice = slicePage(page.id, 3, 4);
    expect(slice.from).toBe(3);
    expect(slice.to).toBe(4);
    expect(slice.text).toBe('## Section A\nAlpha detail line.');
    expect(slice.note).toContain('2 lines below remain');
    expect(slice.note).toContain('from=5');
  });

  it('greps matching lines with line numbers', () => {
    const page = cachePage('Example', 'https://example.com', doc);
    const found = grepPage(page.id, 'beta');
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0].text).toContain('Beta detail line.');
    expect(found.matches[0].line).toBe(5);
  });

  it('rejects unknown or expired page ids', () => {
    expect(() => slicePage('nope', 1)).toThrow('unknown or expired');
    expect(() => grepPage('nope', 'x')).toThrow('unknown or expired');
  });
});
