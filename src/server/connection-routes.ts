import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppVariables } from './request-context.js';
import { z } from 'zod';
import {
  APPROVAL_TTL_MS,
  connectionActionSchema,
  type PendingApproval,
} from '../shared/connection-types.js';
import { connectionInput, isUserFacingConnectionError } from './connections.js';
import { errorResponse } from './error-response.js';
export function connectionRoutes() {
  const app = new Hono<{ Variables: AppVariables }>();
  type Ctx = Context<{ Variables: AppVariables }>;
  const ws = (c: Ctx) => c.get('workspace');
  const conn = (c: Ctx) => c.get('connections');
  app.onError((error, c) =>
    errorResponse(error, c, {
      zodMessage: 'Invalid connection request.',
      isSafe: isUserFacingConnectionError,
      fallback: 'The connected-service request could not be completed.',
      fallbackStatus: 503,
      logLabel: 'connection',
    }),
  );
  const requireDot = (c: Ctx, id: string) => {
    if (!ws(c).dot(id)) throw new Error('Dot not found.');
    return id;
  };
  const owned = (c: Ctx, id: string) => {
    const connection = conn(c).store.get(id);
    if (!connection) throw new Error('Connection not found.');
    return connection;
  };
  app.get('/dots/:id/connections', (c) =>
    c.json(conn(c).store.list(requireDot(c, c.req.param('id')))),
  );
  app.post('/dots/:id/connections', async (c) =>
    c.json(
      await conn(c).add(
        requireDot(c, c.req.param('id')),
        connectionInput.parse(await c.req.json()),
      ),
      201,
    ),
  );
  app.post('/connections/:id/refresh', async (c) =>
    c.json(await conn(c).refresh(owned(c, c.req.param('id')).id)),
  );
  app.patch('/connections/:id/tools/:name', async (c) => {
    const patch = z
      .object({
        enabled: z.boolean().optional(),
        requiresApproval: z.boolean().optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      conn(c).setTool(
        owned(c, c.req.param('id')).id,
        c.req.param('name'),
        patch,
      ),
    );
  });
  app.delete('/connections/:id', (c) => {
    conn(c).store.remove(owned(c, c.req.param('id')).id);
    return c.json({ ok: true });
  });
  // An approval record is usable only from its own conversation, for an
  // hour, and only while the Dot still has that exact tool enabled.
  const approvalFor = (c: Ctx, threadId: string, approvalId: string) => {
    const approval = conn(c).store.approval(approvalId);
    if (!approval || approval.threadId !== threadId)
      throw new Error('Approval request not found.');
    if (Date.now() - approval.createdAt > APPROVAL_TTL_MS)
      throw new Error(
        'This approval request expired. Ask the Dot to try again.',
      );
    return {
      approval,
      exposed: conn(c).bound(
        approval.dotId,
        approval.connectionId,
        approval.tool,
      ),
    };
  };
  app.get('/conversations/:id/connection-approvals/:approvalId', (c) => {
    const thread = ws(c).requireThread(c.req.param('id'));
    const { approval, exposed } = approvalFor(
      c,
      thread.id,
      c.req.param('approvalId'),
    );
    return c.json({
      id: approval.id,
      connection: exposed.connection.name,
      title: exposed.tool.title,
      description: exposed.tool.description,
      arguments: approval.arguments,
      expiresAt: approval.createdAt + APPROVAL_TTL_MS,
    } satisfies PendingApproval);
  });
  app.get('/conversations/:id/connection-actions/:toolCallId', (c) => {
    const thread = ws(c).requireThread(c.req.param('id'));
    return c.json(
      conn(c).store.action(thread.id, c.req.param('toolCallId')) ?? null,
    );
  });
  // The only path that runs an approval-gated tool: the owner approving a
  // stored request. It runs that request's connection, tool, and arguments,
  // never ones supplied with the approval.
  app.post('/conversations/:id/connection-actions', async (c) => {
    const body = connectionActionSchema
      .omit({ summary: true })
      .extend({ toolCallId: z.string().min(1).max(200) })
      .parse(await c.req.json());
    const thread = ws(c).requireThread(c.req.param('id'));
    // A saved result is returned only for the approval that produced it.
    const recovered = () => {
      const previous = conn(c).store.action(thread.id, body.toolCallId);
      if (!previous) return undefined;
      if (previous.approvalId !== body.approvalId)
        return c.json(
          { error: 'This action belongs to a different approval request.' },
          409,
        );
      return previous.result
        ? c.json(previous.result)
        : c.json({ error: 'This action is already running.' }, 409);
    };
    const earlier = recovered();
    if (earlier) return earlier;
    const { approval, exposed } = approvalFor(c, thread.id, body.approvalId);
    // Single-use approval: the first (threadId, toolCallId) pair owns the
    // approvalId. A replay under another call is rejected without executing.
    // The identical pair falls through to the action claim below, which
    // returns the running/recovered receipt (idempotent retry).
    if (
      conn(c).store.claimApproval(approval.id, thread.id, body.toolCallId) ===
      'different'
    )
      return c.json(
        { error: 'This approval was already used by another action.' },
        409,
      );
    if (
      !conn(c).store.claimAction(
        thread.id,
        body.toolCallId,
        approval.id,
        exposed.connection.id,
        exposed.tool.name,
      )
    )
      return recovered()!;
    // Not tied to the request: once approved, finish even if the tab closes.
    const result = await conn(c).call(exposed, approval.arguments);
    conn(c).store.finishAction(thread.id, body.toolCallId, result);
    return c.json(result);
  });
  return app;
}
