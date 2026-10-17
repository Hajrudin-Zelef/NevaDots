import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import { computerRoutes } from '../src/server/computer-routes.js';
import { checkStreamUpgrade } from '../src/server/computer-stream.js';

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
      { origin: 'https://evil.example.com', host: 'app.example.com' },
      undefined,
      consume,
    ).status,
  ).toBe('bad-origin');
  // Le ticket survit au refus d'origine : l'origine légitime passe ensuite.
  expect(
    checkStreamUpgrade(
      `/api/dots/${id}/computer/stream`,
      ticket,
      { origin: 'http://app.example.com', host: 'app.example.com' },
      undefined,
      consume,
    ),
  ).toEqual({ status: 'ok', dotId: id });
  // Derrière le reverse-proxy (x-forwarded-proto), l'origine https passe.
  const ticket3 = service.mintStreamTicket(id);
  expect(
    checkStreamUpgrade(
      `/api/dots/${id}/computer/stream`,
      ticket3,
      {
        origin: 'https://app.example.com',
        host: 'app.example.com',
        forwardedProto: 'https',
      },
      undefined,
      consume,
    ),
  ).toEqual({ status: 'ok', dotId: id });
  const ticket2 = service.mintStreamTicket(id);
  expect(
    checkStreamUpgrade(
      `/api/dots/${id}/computer/stream`,
      ticket2,
      {
        origin: 'https://app.example.com',
        host: 'app.example.com',
        fetchSite: 'cross-site',
      },
      undefined,
      consume,
    ).status,
  ).toBe('bad-origin');
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
      { origin: 'http://localhost:5173', host: '127.0.0.1:4310' },
      ['http://localhost:5173', 'http://127.0.0.1:5173'],
      consume,
    ),
  ).toEqual({ status: 'ok', dotId: id });
});
