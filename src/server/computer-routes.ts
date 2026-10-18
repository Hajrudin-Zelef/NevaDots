import { Hono } from 'hono';
import type { AppVariables } from './request-context.js';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import { isUserFacingComputerError } from './computer-service.js';
import { errorResponse } from './error-response.js';
import type {
  ComputerAction,
  ComputerActivityEvent,
} from '../shared/computer-types.js';
export function computerRoutes() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError((error, c) =>
    errorResponse(error, c, {
      zodMessage: 'Invalid computer request.',
      isSafe: isUserFacingComputerError,
      // C2 : un Dot d'un autre compte se comporte comme inexistant (404),
      // jamais comme une requête invalide (400).
      statusFor: (message) => (message === 'Dot not found.' ? 404 : 400),
      fallback:
        'The computer service could not complete this request. Try again.',
      fallbackStatus: 503,
      logLabel: 'computer',
    }),
  );
  app.get('/dots/:id/computer', async (c) =>
    c.json(await c.get('computers').status(c.req.param('id'))),
  );
  app.patch('/dots/:id/computer/permissions', async (c) =>
    c.json(
      await c
        .get('computers')
        .permissions(c.req.param('id'), await c.req.json()),
    ),
  );
  app.post('/dots/:id/computer/start', async (c) =>
    c.json(await c.get('computers').start(c.req.param('id'))),
  );
  app.post('/dots/:id/computer/stop', async (c) =>
    c.json(await c.get('computers').stop(c.req.param('id'))),
  );
  app.post('/dots/:id/computer/take', async (c) =>
    c.json(await c.get('computers').control(c.req.param('id'), 'take')),
  );
  app.post('/dots/:id/computer/release', async (c) =>
    c.json(await c.get('computers').control(c.req.param('id'), 'release')),
  );
  // Ticket WS à usage unique (30 s) : le navigateur le récupère ici, en-tête
  // Bearer via le middleware owner-token, puis le présente une fois dans la
  // query de l'upgrade. Le token owner ne transite plus jamais par l'URL.
  app.post('/dots/:id/computer/stream-ticket', async (c) =>
    c.json({ ticket: c.get('computers').mintStreamTicket(c.req.param('id')) }),
  );
  // Journal live du terminal (NDJSON) : `start` dès le lancement d'un exec,
  // `end` avec sortie bornée au retour. Couvert par le même middleware
  // owner-token que le reste de /api ; le client passe le Bearer en en-tête.
  app.get('/dots/:id/computer/activity', async (c) => {
    const dotId = c.req.param('id');
    // Le dot doit exister avant de souscrire (requireDot lève sinon).
    await c.get('computers').status(dotId);
    c.header('Content-Type', 'application/x-ndjson');
    c.header('Cache-Control', 'no-cache');
    return stream(c, async (writer) => {
      const rawSignal: AbortSignal | undefined = c.req.raw.signal;
      await writer.write(`:${' '.repeat(2048)}\n`);
      const unsubscribe = c
        .get('computers')
        .subscribeActivity(dotId, (event) => {
          void writer
            .write(`${JSON.stringify(event satisfies ComputerActivityEvent)}\n`)
            .catch(() => {});
        });
      const heartbeat = setInterval(() => {
        void writer.write('\n').catch(() => {});
      }, 20000);
      try {
        await new Promise<void>((resolve) => {
          writer.onAbort(() => resolve());
          if (rawSignal) {
            if (rawSignal.aborted) resolve();
            else
              rawSignal.addEventListener('abort', () => resolve(), {
                once: true,
              });
          }
        });
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });
  app.post('/dots/:id/computer/actions', async (c) => {
    const body = z
      .object({ action: z.string(), input: z.unknown() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await c
        .get('computers')
        .action(
          c.req.param('id'),
          body.action as ComputerAction,
          body.input,
          'owner',
          c.req.raw.signal,
        ),
    );
  });
  return app;
}
