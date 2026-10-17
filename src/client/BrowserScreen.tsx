import { useEffect, useRef, useState } from 'react';
import { api } from './api';

type Frame = { type: 'frame'; data: string; width: number; height: number };

const modifiers = (event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

/**
 * Live, interactive view of a Dot's browser, streamed from the computer's CDP
 * screencast over a same-origin WebSocket. When `interactive`, mouse, wheel and
 * keyboard events are forwarded to the remote page.
 */
export function BrowserScreen({
  dotId,
  active,
  interactive,
}: {
  dotId: string;
  active: boolean;
  interactive: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) {
      setReady(false);
      return;
    }
    let closed = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const connect = async () => {
      // Ticket à usage unique (30 s) via l'API authentifiée : le token
      // owner ne transite jamais par l'URL du WebSocket.
      let ticket: string;
      try {
        ({ ticket } = await api<{ ticket: string }>(
          `/dots/${encodeURIComponent(dotId)}/computer/stream-ticket`,
          'POST',
        ));
      } catch {
        if (closed) return;
        setError('Flux indisponible');
        retry = setTimeout(connect, 1500);
        return;
      }
      if (closed) return;
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(
        `${scheme}://${location.host}/api/dots/${encodeURIComponent(dotId)}/computer/stream?ticket=${encodeURIComponent(ticket)}`,
      );
      socketRef.current = socket;
      socket.onopen = () => setError('');
      socket.onmessage = async (event) => {
        if (typeof event.data !== 'string') return;
        let frame: Frame;
        try {
          frame = JSON.parse(event.data) as Frame;
        } catch {
          return;
        }
        if (frame.type !== 'frame' || !frame.data) return;
        sizeRef.current = { width: frame.width, height: frame.height };
        const canvas = canvasRef.current;
        if (!canvas) return;
        if (canvas.width !== frame.width) canvas.width = frame.width;
        if (canvas.height !== frame.height) canvas.height = frame.height;
        try {
          const bytes = Uint8Array.from(atob(frame.data), (char) =>
            char.charCodeAt(0),
          );
          const bitmap = await createImageBitmap(
            new Blob([bytes], { type: 'image/jpeg' }),
          );
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
          bitmap.close();
          setReady(true);
        } catch {
          /* skip an unreadable frame */
        }
      };
      socket.onclose = () => {
        if (closed) return;
        setReady(false);
        retry = setTimeout(connect, 1500);
      };
      socket.onerror = () => {
        if (closed) return;
        setError('Flux indisponible');
        try {
          socket?.close();
        } catch {
          /* already closed */
        }
      };
    };
    void connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      socketRef.current = null;
    };
  }, [dotId, active]);

  const send = (message: unknown) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  };
  const point = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const size = sizeRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * size.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * size.height),
    };
  };

  return (
    <div className="browser-screen">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className={interactive ? 'interactive' : ''}
        aria-label="Vue du navigateur en direct"
        onPointerDown={(event) => {
          if (!interactive) return;
          event.currentTarget.focus();
          const { x, y } = point(event);
          send({
            type: 'mouse',
            event: 'pressed',
            x,
            y,
            button: 'left',
            clickCount: 1,
            modifiers: modifiers(event),
          });
        }}
        onPointerUp={(event) => {
          if (!interactive) return;
          const { x, y } = point(event);
          send({
            type: 'mouse',
            event: 'released',
            x,
            y,
            button: 'left',
            clickCount: 1,
            modifiers: modifiers(event),
          });
        }}
        onPointerMove={(event) => {
          if (!interactive) return;
          const { x, y } = point(event);
          send({
            type: 'mouse',
            event: 'moved',
            x,
            y,
            modifiers: modifiers(event),
          });
        }}
        onWheel={(event) => {
          if (!interactive) return;
          const { x, y } = point(event);
          send({
            type: 'wheel',
            x,
            y,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            modifiers: modifiers(event),
          });
        }}
        onKeyDown={(event) => {
          if (!interactive) return;
          event.preventDefault();
          send({
            type: 'key',
            event: 'down',
            key: event.key,
            code: event.code,
            text: event.key.length === 1 ? event.key : undefined,
            windowsVirtualKeyCode: event.keyCode || undefined,
            modifiers: modifiers(event),
          });
        }}
        onKeyUp={(event) => {
          if (!interactive) return;
          event.preventDefault();
          send({
            type: 'key',
            event: 'up',
            key: event.key,
            code: event.code,
            windowsVirtualKeyCode: event.keyCode || undefined,
            modifiers: modifiers(event),
          });
        }}
      />
      {!ready && (
        <div className="browser-screen-overlay">
          {error || 'Connexion au navigateur…'}
        </div>
      )}
      {ready && !interactive && (
        <div className="browser-screen-overlay subtle">
          Prenez le contrôle pour interagir
        </div>
      )}
    </div>
  );
}
