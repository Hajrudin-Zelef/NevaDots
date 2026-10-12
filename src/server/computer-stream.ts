import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { ComputerService } from './computer-service.js';

/**
 * Proxies the browser's same-origin WebSocket to a Dot's computer `/stream`
 * endpoint (OpenBot's CDP screencast). The browser cannot set upgrade headers,
 * so it authenticates with the owner token in the query; the app then attaches
 * the per-Dot computer credential on the upstream connection. Nothing but the
 * proxied frames crosses this boundary.
 */

function matches(provided: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const STREAM_PATH = /^\/api\/dots\/([^/]+)\/computer\/stream$/;

interface UpgradeServer {
  on(
    event: 'upgrade',
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
}

export function attachComputerStream(
  server: UpgradeServer,
  computers: ComputerService,
  ownerToken: string | undefined,
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
      const match = STREAM_PATH.exec(url.pathname);
      if (!match) {
        socket.destroy();
        return;
      }
      if (!matches(url.searchParams.get('token') ?? '', ownerToken)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const dotId = decodeURIComponent(match[1]);
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
        for (const item of pending.splice(0)) socket.send(item.data, {
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
