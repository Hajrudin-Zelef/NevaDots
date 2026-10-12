import { afterEach, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';

const stores: WorkspaceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

it('records and reads a conversation outcome and activity', () => {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const dot = workspace.dots()[0];
  const created = workspace.bindThread('thread-activity', dot.id, 'Hello');
  expect(created.summary ?? null).toBeNull();
  expect(created.updatedAt ?? null).toBeNull();

  const updated = workspace.recordThreadActivity('thread-activity', {
    summary: 'Terminé : 3 sites livrés.',
    activity: [{ id: 'e1', kind: 'command', label: 'Commande terminal' }],
  });
  expect(updated.summary).toBe('Terminé : 3 sites livrés.');
  expect(typeof updated.updatedAt).toBe('number');

  expect(workspace.threadActivity('thread-activity')).toEqual([
    { id: 'e1', kind: 'command', label: 'Commande terminal' },
  ]);
  expect(workspace.conversations()[0].summary).toBe(
    'Terminé : 3 sites livrés.',
  );
  expect(workspace.conversations()[0].updatedAt).toBe(updated.updatedAt);
});

it('rejects activity for an unknown conversation', () => {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  expect(() =>
    workspace.recordThreadActivity('missing', { summary: null, activity: [] }),
  ).toThrow();
});

it('clears stored activity when a conversation is deleted', () => {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread-delete', dot.id, 'Bye');
  workspace.recordThreadActivity('thread-delete', {
    summary: 'x',
    activity: [{ id: 'e' }],
  });
  workspace.deleteThread('thread-delete');
  expect(workspace.conversations().some((c) => c.id === 'thread-delete')).toBe(
    false,
  );
  expect(() => workspace.threadActivity('thread-delete')).toThrow();
});
