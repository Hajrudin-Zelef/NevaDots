import { pageReviewSchema } from '../shared/page-review.js';
import { Hono } from 'hono';
import type { AppVariables } from './request-context.js';
import { z } from 'zod';
import { PageError, pageInput, pagePatch } from './pages.js';
import { errorResponse } from './error-response.js';
export function pageRoutes() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.get('/conversations/:id/reviewed-page/:toolCallId', (c) => {
    const thread = c.get('workspace').requireThread(c.req.param('id'));
    const receipt = c
      .get('workspace')
      .pages.reviewReceipt(thread.id, c.req.param('toolCallId'));
    if (!receipt) return c.json(null);
    if (!c.get('workspace').canAccessSpace(thread.dotId, receipt.spaceId))
      return c.json(
        { error: 'This Dot no longer has access to the selected Space.' },
        403,
      );
    const { pageId, spaceId, draft: reviewDraft } = receipt;
    // The receipt outlives its page so a retried approval cannot recreate it.
    if (!c.get('workspace').pages.exists(spaceId, pageId))
      return c.json({ deleted: true, pageId, spaceId, reviewDraft });
    return c.json({
      ...c.get('workspace').pages.get(spaceId, pageId),
      reviewDraft,
    });
  });
  app.post('/conversations/:id/reviewed-page', async (c) => {
    const data = pageReviewSchema
      .extend({ toolCallId: z.string().min(1).max(200) })
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json({ error: 'Enter a valid page draft.' }, 400);
    const thread = c.get('workspace').requireThread(c.req.param('id'));
    if (!c.get('workspace').canAccessSpace(thread.dotId, data.data.spaceId))
      return c.json(
        { error: 'This Dot no longer has access to the selected Space.' },
        403,
      );
    const { spaceId, toolCallId, ...draft } = data.data;
    return c.json(
      c
        .get('workspace')
        .pages.createReviewed(spaceId, draft, thread.id, toolCallId),
      201,
    );
  });
  app.get('/conversations/:id/page-context', (c) => {
    const thread = c.get('workspace').requireThread(c.req.param('id'));
    const dot = c.get('workspace').dot(thread.dotId)!;
    const page = c.get('workspace').pages.forThread(thread.id);
    return c.json(
      page && c.get('workspace').canAccessSpace(dot.id, page.spaceId)
        ? { id: page.id, spaceId: page.spaceId, title: page.title }
        : null,
    );
  });
  app.get('/spaces/:spaceId/pages', (c) =>
    c.json(c.get('workspace').pages.list(c.req.param('spaceId'))),
  );
  app.get('/spaces/:spaceId/pages/:id', (c) =>
    c.json(
      c.get('workspace').pages.get(c.req.param('spaceId'), c.req.param('id')),
    ),
  );
  app.post('/spaces/:spaceId/pages', async (c) => {
    const data = pageInput.safeParse(await c.req.json());
    if (!data.success)
      return c.json(
        {
          error:
            'Enter a title (160 characters max) and Markdown content (100,000 max).',
        },
        400,
      );
    return c.json(
      c.get('workspace').pages.create(c.req.param('spaceId'), data.data),
      201,
    );
  });
  app.patch('/spaces/:spaceId/pages/:id', async (c) => {
    const data = pagePatch.safeParse(await c.req.json());
    if (!data.success)
      return c.json(
        { error: 'A valid page patch and expectedRevision are required.' },
        400,
      );
    return c.json(
      c
        .get('workspace')
        .pages.update(c.req.param('spaceId'), c.req.param('id'), data.data),
    );
  });
  app.delete('/spaces/:spaceId/pages/:id', (c) => {
    const deleted = c
      .get('workspace')
      .pages.delete(c.req.param('spaceId'), c.req.param('id'));
    if (!deleted)
      return c.json({ error: 'Page not found in this Space.' }, 404);
    return c.json({ ok: true });
  });
  app.post('/spaces/:spaceId/pages/:id/conversation', async (c) => {
    const data = z
      .object({ dotId: z.string().min(1) })
      .strict()
      .safeParse(await c.req.json());
    if (!data.success) return c.json({ error: 'Choose a specialist.' }, 400);
    return c.json(
      await c
        .get('pages')
        .conversation(
          c.req.param('spaceId'),
          c.req.param('id'),
          data.data.dotId,
        ),
    );
  });
  app.post('/conversations/:id/page', async (c) => {
    const data = z
      .object({
        title: z.string().trim().min(1).max(160),
        parentId: z.string().nullable().default(null),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!data.success)
      return c.json({ error: 'Enter a valid page title and parent.' }, 400);
    return c.json(
      await c
        .get('pages')
        .saveConversation(
          c.req.param('id'),
          data.data.title,
          data.data.parentId,
        ),
      201,
    );
  });
  app.onError((error, c) => {
    if (error instanceof SyntaxError)
      return c.json({ error: 'Invalid JSON request.' }, 400);
    if (error instanceof PageError)
      return c.json({ error: error.message }, error.status as never);
    const text = error instanceof Error ? error.message : '';
    if (text === 'Conversation does not belong to this Dot and owner.')
      return c.json({ error: text }, 404);
    return errorResponse(error, c, {
      zodMessage: 'Invalid page request.',
      isSafe: () => false,
      fallback:
        'Page operation could not complete. Retry; your draft has not been discarded.',
      fallbackStatus: 503,
      logLabel: 'page',
    });
  });
  return app;
}
