import { describe, expect, it } from 'vitest';
import {
  formatBrainSummary,
  resolveBrainPath,
} from '../src/server/operator-brain';

describe('operator-brain (phase 8)', () => {
  it('resolveBrainPath bloque le path traversal', () => {
    expect(resolveBrainPath('user', '../secret.md')).toBeNull();
    expect(resolveBrainPath('user', '../../etc/passwd')).toBeNull();
    expect(resolveBrainPath('user', 'a/../../b.md')).toBeNull();
    expect(resolveBrainPath('user', '/absolu.md')).toBeNull();
    expect(resolveBrainPath('user', 'notes.txt')).toBeNull();
    expect(resolveBrainPath('user', '')).toBeNull();
    const ok = resolveBrainPath('user', 'specs/api.md');
    expect(ok).not.toBeNull();
    expect(ok!.endsWith('.operator/user/specs/api.md')).toBe(true);
  });

  it('formatBrainSummary gère les partitions vides', () => {
    expect(
      formatBrainSummary([
        { partition: 'user', files: [], index: null },
        { partition: 'project', files: [], index: null },
        { partition: 'shared', files: [], index: null },
      ]),
    ).toBe('aucun');
    const formatted = formatBrainSummary([
      {
        partition: 'user',
        files: ['memories.md', 'specs/api.md'],
        index: '# Index\nRègles.',
      },
      { partition: 'project', files: [], index: null },
      { partition: 'shared', files: [], index: null },
    ]);
    expect(formatted).toContain('[user]');
    expect(formatted).toContain('memories.md');
    expect(formatted).not.toContain('[project]');
  });
});
