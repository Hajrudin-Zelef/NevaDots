/**
 * Phase C1 — isolation inter-comptes (NON NÉGOCIABLE) : A ne voit, ne
 * touche et ne supprime rien de B, et inversement. Chaque ressource
 * étrangère se comporte comme si elle n'existait pas (404 / undefined /
 * throw « not found »), jamais 403 (pas d'énumération).
 */
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Store } from '../src/server/store.js';

const A = 'user-a';
const B = 'user-b';

function fixture() {
  const wsDb = new DatabaseSync(':memory:');
  const wsA = new WorkspaceStore(wsDb, A);
  const wsB = new WorkspaceStore(wsDb, B);
  const storeDb = new DatabaseSync(':memory:');
  const storeA = new Store(storeDb, A);
  const storeB = new Store(storeDb, B);
  return {
    wsA,
    wsB,
    storeA,
    storeB,
    close: () => {
      wsDb.close();
      storeDb.close();
    },
  };
}

it('Dots et Spaces : A ne voit pas ceux de B', () => {
  const { wsA, wsB, close } = fixture();
  try {
    const spaceA = wsA.createSpace('Atelier A', '');
    const dotA = wsA.createDot(spaceA.id, 'Dot A', 'Help', true, true);
    expect(wsB.spaces()).toHaveLength(0);
    expect(wsB.dots()).toHaveLength(0);
    expect(wsB.space(spaceA.id)).toBeUndefined();
    expect(wsB.dot(dotA.id)).toBeUndefined();
    expect(() => wsB.updateDot(dotA.id, { ...dotA, name: 'Pirate' })).toThrow();
    expect(wsA.dot(dotA.id)?.name).toBe('Dot A');
  } finally {
    close();
  }
});

it('Conversations : le thread de A est introuvable pour B', () => {
  const { wsA, wsB, close } = fixture();
  try {
    const spaceA = wsA.createSpace('Atelier A', '');
    const dotA = wsA.createDot(spaceA.id, 'Dot A', 'Help', true, true);
    wsA.bindThread('thread-a', dotA.id, 'Conversation A');
    expect(wsB.conversations()).toHaveLength(0);
    expect(() => wsB.requireThread('thread-a')).toThrow();
  } finally {
    close();
  }
});

it('Pages : la page de A est introuvable pour B (le Space étranger rejette tout)', () => {
  const { wsA, wsB, close } = fixture();
  try {
    const spaceA = wsA.createSpace('Atelier A', '');
    const pageA = wsA.pages.create(spaceA.id, {
      title: 'Page A',
      content: 'Contenu A',
    });
    // Le Space de A n'existe pas pour B : chaque opération y lève.
    expect(() => wsB.pages.list(spaceA.id)).toThrow();
    expect(() => wsB.pages.get(spaceA.id, pageA.id)).toThrow();
    expect(() => wsB.pages.delete(spaceA.id, pageA.id)).toThrow();
    expect(wsA.pages.get(spaceA.id, pageA.id).title).toBe('Page A');
  } finally {
    close();
  }
});

it('Tâches et mémoires : B ne voit rien de A, et ne peut pas écraser sa mémoire', () => {
  const { storeA, storeB, close } = fixture();
  try {
    const taskA = storeA.createTask('Faire X', null, null);
    const memoryA = storeA.saveMemory('Secret de A');
    expect(storeB.tasks()).toHaveLength(0);
    expect(storeB.task(taskA.id)).toBeUndefined();
    expect(storeB.memories()).toHaveLength(0);
    expect(() => storeB.saveMemory('Écrasement', memoryA.id)).toThrow(
      'Memory not found.',
    );
    expect(storeA.memories().find((m) => m.id === memoryA.id)?.text).toBe(
      'Secret de A',
    );
    expect(storeB.deleteMemory(memoryA.id)).toBe(false);
    expect(storeA.memories().find((m) => m.id === memoryA.id)).toBeDefined();
  } finally {
    close();
  }
});

it('Réglages : chaque compte a les siens', () => {
  const { storeA, storeB, close } = fixture();
  try {
    expect(storeA.settings().paused).toBe(false);
    storeA.updateSettings({ paused: true });
    expect(storeA.settings().paused).toBe(true);
    expect(storeB.settings().paused).toBe(false);
  } finally {
    close();
  }
});

it('Connexions MCP : B ne voit pas celles de A', () => {
  const { wsA, wsB, close } = fixture();
  try {
    const spaceA = wsA.createSpace('Atelier A', '');
    const dotA = wsA.createDot(spaceA.id, 'Dot A', 'Help', true, true);
    const connA = wsA.connections.create(
      dotA.id,
      { name: 'MCP A', url: 'https://mcp-a.example.com' },
      [],
    );
    expect(wsB.connections.list(dotA.id)).toHaveLength(0);
    expect(wsB.connections.get(connA.id)).toBeUndefined();
    expect(wsB.connections.remove(connA.id)).toBe(false);
    expect(wsA.connections.get(connA.id)?.name).toBe('MCP A');
  } finally {
    close();
  }
});

it('Claim : les orphelins reviennent au premier compte, jamais au second', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // Le store crée les tables sur la connexion partagée ; la ligne
    // legacy est écrite directement, sans user_id (avant C1).
    new WorkspaceStore(db, A);
    db.prepare('INSERT INTO spaces VALUES (?, ?, ?, ?, NULL)').run(
      'legacy-space',
      'Ancien',
      '',
      Date.now(),
    );
    const wsA = new WorkspaceStore(db, A);
    wsA.claimOrphans(A);
    expect(wsA.space('legacy-space')?.name).toBe('Ancien');
    const wsB = new WorkspaceStore(db, B);
    expect(wsB.space('legacy-space')).toBeUndefined();
    wsB.claimOrphans(B);
    expect(wsB.space('legacy-space')).toBeUndefined();
    expect(wsA.space('legacy-space')).toBeDefined();
  } finally {
    db.close();
  }
});

it('Store non lié : fail-closed (rien lu, écritures refusées)', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const unbound = new WorkspaceStore(db);
    expect(unbound.spaces()).toHaveLength(0);
    expect(unbound.dots()).toHaveLength(0);
    expect(() => unbound.createSpace('X', '')).toThrow();
    const unboundStore = new Store(db);
    expect(unboundStore.tasks()).toHaveLength(0);
    expect(() => unboundStore.createTask('X')).toThrow();
  } finally {
    db.close();
  }
});
