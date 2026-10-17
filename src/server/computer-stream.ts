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
  host?: string | null;
  forwardedProto?: string | null;
  fetchSite?: string | null;
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
  if (origin) {
    const host = headers.host ?? '';
    const proto = headers.forwardedProto?.split(',')[0]?.trim() || 'http';
    const allowed = new Set([...(origins ?? []), `${proto}://${host}`]);
    if (!allowed.has(origin)) return { status: 'bad-origin' };
  }
  if (headers.fetchSite === 'cross-site') return { status: 'bad-origin' };
  if (!ticket) return { status: 'bad-ticket' };
  const bound = consumeTicket(ticket);
  if (!bound || bound !== decodeURIComponent(match[1]))
    return { status: 'bad-ticket' };
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
          host: headers.host ?? null,
          forwardedProto:
            (Array.isArray(headers['x-forwarded-proto'])
              ? headers['x-forwarded-proto'][0]
              : (headers['x-forwarded-proto'] as string | undefined)) ?? null,
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

function bridge(client: WebSocket, computers: ComputerService, dotId: string) {
  let upstream: WebSocket | undefined;
  let upstreamOpen = false;
  let closed = false;
  const pending: { data: RawData; binary: boolean }[] = [];
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
    else pending.push({ data, binary });
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
    } catch (error) {
      if (client.readyState === WebSocket.OPEN)
        client.close(
          1011,
          (error instanceof Error
            ? error.message
            : 'Computer stream failed.'
          ).slice(0, 120),
        );
    }
  })();
}
