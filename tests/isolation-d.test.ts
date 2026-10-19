/**
 * Phase D — session maître + sessions parallèles + mémoire unifiée.
 * La maître est PAR USER : la 1ère conversation du compte est la maître,
 * les suivantes sont des parallèles. Si la maître est fermée, la prochaine
 * conversation créée devient la nouvelle maître. La mémoire est unifiée
 * (par compte, pas par session).
 */
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const A = 'user-a';
const B = 'user-b';

function fixture() {
  const wsDb = new DatabaseSync(':memory:');
  const wsA = new WorkspaceStore(wsDb, A);
  const wsB = new WorkspaceStore(wsDb, B);
  const storeDb = new DatabaseSync(':memory:');
  const storeA = new Store(storeDb, A);
  const storeB = new Store(storeDb, B);
  const spaceA = wsA.createSpace('Atelier A', '');
  const dotA = wsA.createDot(spaceA.id, 'Dot A', 'Help', true, true);
  return {
    wsDb,
    wsA,
    wsB,
    storeA,
    storeB,
    dotA,
    close: () => {
      wsDb.close();
      storeDb.close();
    },
  };
}

it('La 1ère conversation du compte est la maître, les suivantes sont parallèles', () => {
  const { wsA, wsB, dotA, close } = fixture();
  try {
    const first = wsA.bindThread('t1', dotA.id, 'Première');
    expect(first.isMaster).toBe(true);
    const second = wsA.bindThread('t2', dotA.id, 'Deuxième');
    expect(second.isMaster).toBe(false);
    const conversations = wsA.conversations();
    expect(conversations.find((t) => t.id === 't1')?.isMaster).toBe(true);
    expect(conversations.find((t) => t.id === 't2')?.isMaster).toBe(false);
    // Isolation : la maître de A est invisible pour B.
    expect(wsB.conversations()).toHaveLength(0);
  } finally {
    close();
  }
});

it('Fermer la maître : la prochaine conversation créée devient la nouvelle maître', () => {
  const { wsA, dotA, close } = fixture();
  try {
    wsA.bindThread('t1', dotA.id, 'Maître');
    wsA.bindThread('t2', dotA.id, 'Parallèle');
    expect(wsA.deleteThread('t1')).toBe(true);
    const next = wsA.bindThread('t3', dotA.id, 'Nouvelle maître');
    expect(next.isMaster).toBe(true);
    expect(wsA.conversations().find((t) => t.id === 't2')?.isMaster).toBe(
      false,
    );
  } finally {
    close();
  }
});

it('Une conversation de page ne devient jamais maître (opt-out bindThread)', () => {
  const { wsA, dotA, close } = fixture();
  try {
    const page = wsA.bindThread('t-page', dotA.id, 'Page', {
      master: false,
    });
    expect(page.isMaster).toBe(false);
    // Sans maître, la prochaine conversation de chat devient la maître.
    const chat = wsA.bindThread('t-chat', dotA.id, 'Chat');
    expect(chat.isMaster).toBe(true);
  } finally {
    close();
  }
});

it('claimOrphans : la plus ancienne conversation legacy devient la maître', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ws = new WorkspaceStore(db, A);
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    db.exec(
      `INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, isMaster)
       VALUES ('t-old', 'dot-x', 'legacy-owner', 'Ancienne', 100, 0),
              ('t-new', 'dot-x', 'legacy-owner', 'Récente', 200, 0)`,
    );
    ws.claimOrphans(A);
    const conversations = ws.conversations();
    expect(conversations.find((t) => t.id === 't-old')?.isMaster).toBe(true);
    expect(conversations.find((t) => t.id === 't-new')?.isMaster).toBe(false);
  } finally {
    db.close();
  }
});

it('Mémoire unifiée : supprimer une parallèle ne touche ni la mémoire ni la maître', () => {
  const { wsA, storeA, dotA, close } = fixture();
  try {
    wsA.bindThread('t1', dotA.id, 'Maître');
    wsA.bindThread('t2', dotA.id, 'Parallèle');
    const memory = storeA.saveMemory('Préférence : réponses courtes.');
    expect(wsA.deleteThread('t2')).toBe(true);
    expect(storeA.memories().map((m) => m.id)).toContain(memory.id);
    const conversations = wsA.conversations();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.id).toBe('t1');
    expect(conversations[0]?.isMaster).toBe(true);
  } finally {
    close();
  }
});
