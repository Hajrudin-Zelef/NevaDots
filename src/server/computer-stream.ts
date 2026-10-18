import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { ComputerService } from './computer-service.js';

/**
 * Proxies the browser's same-origin WebSocket to a Dot's computer `/stream`
 * endpoint (OpenBot's CDP screencast). The browser cannot set upgrade headers,
 * so it fetches a short-lived single-use ticket over the authenticated API
 * and presents it once in the WS query — the owner token never lands in a
 * URL, proxy log, or browser history. The per-Dot computer credential is
 * attached only on the loopback hop to the container (headers and query, as
 * the OpenBot endpoint requires both); nothing but the proxied frames
 * crosses the browser boundary.
 */

const STREAM_PATH = /^\/api\/dots\/([^/]+)\/computer\/stream$/;

export type StreamUpgradeStatus =
  'ok' | 'bad-path' | 'bad-origin' | 'bad-ticket';

export interface StreamUpgradeHeaders {
  origin?: string | null;
  fetchSite?: string | null;
}

/** Hostnames loopback : l'Origin du navigateur même-hôte, tout port. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Origine autorisée : exactement une origine configurée, ou une origine
 * loopback (http/https). Jamais dérivée des en-têtes de la requête (Host /
 * X-Forwarded-Proto sont contrôlés par le client : un Host forgé rendait
 * n'importe quelle Origin « autorisée »). L'auth réelle reste le ticket
 * à usage unique ; ce contrôle n'est que de la défense en profondeur.
 */
function isAllowedOrigin(origin: string, origins: string[]): boolean {
  if (origins.includes(origin)) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return LOOPBACK_HOSTNAMES.has(parsed.hostname);
}

/**
 * Pure upgrade gate, unit-testable: path, then origin, then single-use
 * ticket. The ticket is consumed only after the origin checks pass, so a
 * rejected origin never burns a legitimate ticket.
 */
export function checkStreamUpgrade(
  pathname: string,
  ticket: string | null,
  headers: StreamUpgradeHeaders,
  origins: string[] | undefined,
  consumeTicket: (ticket: string) => string | null,
): { status: StreamUpgradeStatus; dotId?: string } {
  const match = STREAM_PATH.exec(pathname);
  if (!match) return { status: 'bad-path' };
  const origin = headers.origin ?? null;
  if (origin && !isAllowedOrigin(origin, origins ?? []))
    return { status: 'bad-origin' };
  if (headers.fetchSite === 'cross-site') return { status: 'bad-origin' };
  if (!ticket) return { status: 'bad-ticket' };
  // Chemin non-UTF8 ou % malformé : 401, ticket non consommé.
  let pathDot: string;
  try {
    pathDot = decodeURIComponent(match[1]);
  } catch {
    return { status: 'bad-ticket' };
  }
  const bound = consumeTicket(ticket);
  if (!bound || bound !== pathDot) return { status: 'bad-ticket' };
  return { status: 'ok', dotId: bound };
}

interface UpgradeServer {
  on(
    event: 'upgrade',
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
}

export function attachComputerStream(
  server: UpgradeServer,
  computers: ComputerService,
  origins: string[] | undefined,
): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on(
    'upgrade',
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      let url: URL;
      try {
        url = new URL(request.url ?? '', 'http://localhost');
      } catch {
        socket.destroy();
        return;
      }
      const headers = request.headers;
      const checked = checkStreamUpgrade(
        url.pathname,
        url.searchParams.get('ticket'),
        {
          origin: headers.origin ?? null,
          fetchSite: (headers['sec-fetch-site'] as string | undefined) ?? null,
        },
        origins,
        (ticket) => computers.consumeStreamTicket(ticket),
      );
      if (checked.status !== 'ok' || !checked.dotId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const dotId = checked.dotId;
      wss.handleUpgrade(request, socket, head, (client) => {
        bridge(client, computers, dotId);
      });
    },
  );
}

/** Plafonds du tampon pré-upstream : un client qui inonde avant l'ouverture upstream ne fait pas gonfler la mémoire sans limite. */
const PENDING_MAX_MESSAGES = 50;
const PENDING_MAX_BYTES = 1_048_576; // 1 Mio

function rawDataBytes(data: RawData): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0);
  return data.byteLength;
}

function bridge(client: WebSocket, computers: ComputerService, dotId: string) {
  let upstream: WebSocket | undefined;
  let upstreamOpen = false;
  let closed = false;
  const pending: { data: RawData; binary: boolean }[] = [];
  let pendingBytes = 0;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    try {
      if (upstream && upstream.readyState < WebSocket.CLOSING) upstream.close();
    } catch {
      /* already closing */
    }
    try {
      if (client.readyState < WebSocket.CLOSING) client.close();
    } catch {
      /* already closing */
    }
  };

  // Attach the client listener before awaiting so early input is buffered.
  client.on('message', (data: RawData, binary: boolean) => {
    if (upstream && upstreamOpen) upstream.send(data, { binary });
    else {
      pendingBytes += rawDataBytes(data);
      pending.push({ data, binary });
      if (
        pending.length > PENDING_MAX_MESSAGES ||
        pendingBytes > PENDING_MAX_BYTES
      ) {
        // Flood avant ouverture upstream : fermeture propre, message générique.
        try {
          client.close(1011, 'Computer stream failed.');
        } catch {
          /* already closing */
        }
        shutdown();
      }
    }
  });
  client.on('close', shutdown);
  client.on('error', shutdown);

  void (async () => {
    try {
      const target = await computers.streamTarget(dotId);
      const url = `${target.url}/stream?bot=${encodeURIComponent(dotId)}&token=${encodeURIComponent(target.token)}`;
      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${target.token}`,
          'x-openbot-bot-id': dotId,
        },
      });
      upstream = socket;
      socket.on('open', () => {
        upstreamOpen = true;
        for (const item of pending.splice(0))
          socket.send(item.data, {
            binary: item.binary,
          });
      });
      socket.on('message', (data: RawData, binary: boolean) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
      });
      socket.on('close', shutdown);
      socket.on('error', shutdown);
    } catch {
      // Message générique : le détail interne (hôte/port/URL du conteneur)
      // ne part pas au client.
      if (client.readyState === WebSocket.OPEN)
        client.close(1011, 'Computer stream failed.');
    }
  })();
}
