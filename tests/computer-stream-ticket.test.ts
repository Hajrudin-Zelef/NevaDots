import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import { computerRoutes } from '../src/server/computer-routes.js';
import {
  attachComputerStream,
  checkStreamUpgrade,
} from '../src/server/computer-stream.js';

const stores: WorkspaceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function fixture() {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const id = workspace.dots()[0].id;
  const service = new ComputerService(
    workspace,
    {
      baseUrl: 'https://example.com',
      voiceName: 'voice',
      slackUsers: [],
      runtimeUrl: 'http://localhost',
      computerSupervisorUrl: 'http://127.0.0.1:4312',
      computerSupervisorToken: 'supervisor-secret',
      computerToken: 'master-secret',
    },
    () => false,
    async () => Response.json({ computers: [] }),
  );
  return { workspace, id, service };
}

const consumeNone = () => null;
const noHeaders = {};

it('mint un ticket lié au Dot, consommé une seule fois', () => {
  const { id, service } = fixture();
  const ticket = service.mintStreamTicket(id);
  expect(ticket).toMatch(/^[0-9a-f]{64}$/);
  expect(service.consumeStreamTicket(ticket)).toBe(id);
  // Rejeu : le ticket est brûlé.
  expect(service.consumeStreamTicket(ticket)).toBeNull();
  expect(service.consumeStreamTicket('0'.repeat(64))).toBeNull();
});

it('un ticket expiré ne passe plus', () => {
  const { id, service } = fixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const ticket = service.mintStreamTicket(id);
    vi.setSystemTime(Date.now() + 31_000);
    expect(service.consumeStreamTicket(ticket)).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('un ticket minté pour un Dot inconnu est refusé', () => {
  const { service } = fixture();
  expect(() => service.mintStreamTicket('nope')).toThrow();
});

it("la route émet un ticket et l'upgrade le valide une fois", async () => {
  const { id, service } = fixture();
  const routes = computerRoutes(service);
  const minted = await routes.request(`/dots/${id}/computer/stream-ticket`, {
    method: 'POST',
  });
  expect(minted.status).toBe(200);
  const { ticket } = (await minted.json()) as { ticket: string };
  expect(ticket).toMatch(/^[0-9a-f]{64}$/);
  const seen = new Map<string, string>();
  const first = checkStreamUpgrade(
    `/api/dots/${id}/computer/stream`,
    ticket,
    noHeaders,
    undefined,
    (t) => service.consumeStreamTicket(t),
  );
  expect(first).toEqual({ status: 'ok', dotId: id });
  seen.set(ticket, id);
  expect(seen.size).toBe(1);
  // Même ticket rejoué : refusé.
  expect(
    checkStreamUpgrade(
      `/api/dots/${id}/computer/stream`,
      ticket,
      noHeaders,
      undefined,
      (t) => service.consumeStreamTicket(t),
    ).status,
  ).toBe('bad-ticket');
  // L'ancien ?token= ne passe plus : sans ticket, refus.
  expect(
    checkStreamUpgrade(
      `/api/dots/${id}/computer/stream`,
      null,
      noHeaders,
      undefined,
      consumeNone,
    ).status,
  ).toBe('bad-ticket');
  // Chemin non-UTF8 : 401 sans crasher, ticket non consommé.
  const fresh = service.mintStreamTicket(id);
  expect(
    checkStreamUpgrade(
      '/api/dots/%FF/computer/stream',
      fresh,
      noHeaders,
      undefined,
      (t) => service.consumeStreamTicket(t),
    ).status,
  ).toBe('bad-ticket');
  expect(
    checkStreamUpgrade(
      `/api/dots/${id}/computer/stream`,
      fresh,
      noHeaders,
      undefined,
      (t) => service.consumeStreamTicket(t),
    ),
  ).toEqual({ status: 'ok', dotId: id });
});

it("un ticket d'un autre Dot ne passe pas sur ce chemin", () => {
  const { id, service, workspace } = fixture();
  const other = workspace.createDot(
    workspace.spaces()[0].id,
    'Other',
    'Other dot.',
    true,
    true,
  );
  const ticket = service.mintStreamTicket(other.id);
  expect(
    checkStreamUpgrade(
      `/api/dots/${id}/computer/stream`,
      ticket,
      noHeaders,
      undefined,
      (t) => service.consumeStreamTicket(t),
    ).status,
  ).toBe('bad-ticket');
});

it('mauvaise origine et cross-site sont refusés sans brûler le ticket', () => {
  const { id, service } = fixture();
  const ticket = service.mintStreamTicket(id);
  const consume = (t: string) => service.consumeStreamTicket(t);
  expect(
    checkStreamUpgrade(
      `/api/dots/${id}/computer/stream`,
      ticket,
      { origin: 'https://evil.example.com' },
      undefined,
      consume,
    ).status,
  ).toBe('bad-origin');
  // Host forgé ne rend plus l'origine légitime : app.example.com n'est ni
  // une origine configurée ni loopback (anciennes assertions corrigées :
  // elles validaient l'origine dérivée de Host).
  expect(
    checkStreamUpgrade(
      `/api/dots/${id}/computer/stream`,
      ticket,
      { origin: 'http://app.example.com' },
      undefined,
      consume,
    ).status,
  ).toBe('bad-origin');
  // Le ticket survit aux refus d'origine : l'origine loopback passe ensuite.
  expect(
    checkStreamUpgrade(
      `/api/dots/${id}/computer/stream`,
      ticket,
      { origin: 'http://127.0.0.1:4310' },
      undefined,
      consume,
    ),
  ).toEqual({ status: 'ok', dotId: id });
  // X-Forwarded-Proto ne rend plus l'origine légitime non plus.
  const ticket3 = service.mintStreamTicket(id);
  expect(
    checkStreamUpgrade(
      `/api/dots/${id}/computer/stream`,
      ticket3,
      { origin: 'https://app.example.com' },
      undefined,
      consume,
    ).status,
  ).toBe('bad-origin');
  const ticket2 = service.mintStreamTicket(id);
  expect(
    checkStreamUpgrade(
      `/api/dots/${id}/computer/stream`,
      ticket2,
      {
        origin: 'https://app.example.com',
        fetchSite: 'cross-site',
      },
      undefined,
      consume,
    ).status,
  ).toBe('bad-origin');
});

it('origines loopback acceptées, pièges de suffixe et schémas refusés', () => {
  const { id, service } = fixture();
  const consume = (t: string) => service.consumeStreamTicket(t);
  const check = (origin: string) =>
    checkStreamUpgrade(
      `/api/dots/${id}/computer/stream`,
      service.mintStreamTicket(id),
      { origin },
      undefined,
      consume,
    ).status;
  expect(check('http://localhost:4310')).toBe('ok');
  expect(check('https://localhost:4310')).toBe('ok');
  expect(check('http://[::1]:4310')).toBe('ok');
  // Suffixe : localhost.evil.com n'est PAS localhost.
  expect(check('http://localhost.evil.com')).toBe('bad-origin');
  expect(check('http://127.0.0.1.evil.com')).toBe('bad-origin');
  expect(check('http://evil127.0.0.1')).toBe('bad-origin');
  // Schéma non http(s).
  expect(check('ftp://127.0.0.1')).toBe('bad-origin');
  // Origine malformée.
  expect(check('pas-une-origine')).toBe('bad-origin');
  // Non-loopback, non configurée.
  expect(check('http://example.com')).toBe('bad-origin');
});

describe('bridge (upgrade réel)', () => {
  async function harness(stub: {
    consumeStreamTicket: (ticket: string) => string | null;
    streamTarget: (dotId: string) => Promise<unknown>;
  }) {
    const server = createServer();
    attachComputerStream(server, stub as unknown as ComputerService, undefined);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;
    return { server, port };
  }

  function connect(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/dots/dot-1/computer/stream?ticket=abc`,
        { headers: { Origin: `http://127.0.0.1:${port}` } },
      );
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  it('ferme en 1011 quand le tampon pending déborde avant ouverture upstream', async () => {
    const stub = {
      consumeStreamTicket: () => 'dot-1',
      streamTarget: () => new Promise(() => {}),
    };
    const { server, port } = await harness(stub);
    try {
      const ws = await connect(port);
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        ws.once('close', (code, reason) =>
          resolve({ code, reason: reason.toString() }),
        ),
      );
      for (let i = 0; i < 60; i++) ws.send('x');
      const { code, reason } = await closed;
      expect(code).toBe(1011);
      expect(reason).toBe('Computer stream failed.');
    } finally {
      server.close();
    }
  });

  it('fermeture WS avec message générique quand la cible échoue', async () => {
    const stub = {
      consumeStreamTicket: () => 'dot-1',
      streamTarget: () =>
        Promise.reject(new Error('internal detail host:1234 token=secret')),
    };
    const { server, port } = await harness(stub);
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/dots/dot-1/computer/stream?ticket=abc`,
        { headers: { Origin: `http://127.0.0.1:${port}` } },
      );
      const { code, reason } = await new Promise<{
        code: number;
        reason: string;
      }>((resolve) =>
        ws.once('close', (code, reason) =>
          resolve({ code, reason: reason.toString() }),
        ),
      );
      expect(code).toBe(1011);
      expect(reason).toBe('Computer stream failed.');
      expect(reason).not.toContain('internal');
    } finally {
      server.close();
    }
  });
});

it('chemin inconnu refusé, origine configurée acceptée (dev Vite)', () => {
  const { id, service } = fixture();
  const consume = (t: string) => service.consumeStreamTicket(t);
  expect(
    checkStreamUpgrade('/api/nope', 'x', noHeaders, undefined, consumeNone)
      .status,
  ).toBe('bad-path');
  const ticket = service.mintStreamTicket(id);
  expect(
    checkStreamUpgrade(
      `/api/dots/${id}/computer/stream`,
      ticket,
      { origin: 'http://localhost:5173' },
      ['http://localhost:5173', 'http://127.0.0.1:5173'],
      consume,
    ),
  ).toEqual({ status: 'ok', dotId: id });
});
