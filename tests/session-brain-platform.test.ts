import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';

const roots: string[] = [];
const saved = process.env.SESSION_BRAIN_DIR;

afterEach(() => {
  roots
    .splice(0)
    .reverse()
    .forEach((dir) => rmSync(dir, { recursive: true }));
  if (saved === undefined) delete process.env.SESSION_BRAIN_DIR;
  else process.env.SESSION_BRAIN_DIR = saved;
});

it('supprime la session du cerveau : RAM vidée, disque conservé dans trash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-brain-platform-'));
  roots.push(root);
  process.env.SESSION_BRAIN_DIR = root;
  const store = new Store(':memory:').forUser('owner');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  workspace.ensureSeed();
  const platform = new Platform(store, workspace, {
    apiKey: 'fixture',
    model: 'fixture-model',
    baseUrl: 'https://unused.invalid/v1',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  });
  try {
    const dot = workspace.dots()[0];
    const conversation = await platform.createConversation(
      'owner',
      dot.id,
      'Session',
    );
    const scope = {
      userId: 'owner',
      dotId: dot.id,
      threadId: conversation.id,
    };
    await platform.sessionBrains.append(scope, 'note à conserver');
    await platform.sessionBrains.flushNow();
    await platform.deleteConversation('owner', conversation.id);
    expect(await platform.sessionBrains.read(scope)).toBe('');
    expect(
      readdirSync(join(root, 'trash', 'owner', dot.id)).length,
    ).toBeGreaterThan(0);
    expect(workspace.conversations()).toHaveLength(0);
  } finally {
    await platform.stop();
    store.close();
    workspace.close();
  }
});
