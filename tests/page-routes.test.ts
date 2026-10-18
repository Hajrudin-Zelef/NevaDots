import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { PageService } from '../src/server/page-service.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { AuthStore } from '../src/server/auth-store.js';
import { isNotFoundMessage } from '../src/server/workspace-routes.js';
import { loginSession } from './auth-helpers.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
// Phase B (comptes) : la fixture ouvre une session (loginSession) et
// renvoie `api` (requêtes avec le cookie de session) + `app` (brut, pour
// les cas 401 sans session).
async function fixture() {
  const store = new Store(':memory:').forUser('owner');
  const ws = new WorkspaceStore(':memory:', 'owner');
  ws.ensureSeed();
  const auth = new AuthStore(':memory:');
  cleanup.push(() => {
    store.close();
    ws.close();
    auth.close();
  });
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, ws, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    auth,
  });
  const cookie = await loginSession(app, auth);
  const api = (url: string, init?: RequestInit) =>
    app.request(url, {
      ...init,
      headers: {
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
        Cookie: cookie,
      },
    });
  return { ws, platform, app, auth, api, cookie };
}
const request = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

it('saves Learning settings through the owner API and rejects malformed container IDs', async () => {
  const { ws, api, app } = await fixture();
  const dot = ws.dots()[0];
  const body = {
    name: dot.name,
    instructions: dot.instructions,
    researchAllowed: true,
    memoryAllowed: true,
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  };
  expect((await api(`/api/dots/${dot.id}`, request(body, 'PUT'))).status).toBe(
    200,
  );
  expect(ws.dot(dot.id)).toMatchObject({
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  expect(
    (
      await api(
        `/api/dots/${dot.id}`,
        request({ ...body, learningContainerId: 'bad--id' }, 'PUT'),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await api(
        `/api/dots/${dot.id}`,
        request({ ...body, learningContainerId: null }, 'PUT'),
      )
    ).status,
  ).toBe(400);
  const created = await api(
    '/api/dots',
    request({ ...body, spaceId: dot.spaceId }),
  );
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  // Sans session → 401.
  expect(
    (await app.request(`/api/dots/${dot.id}`, request(body, 'PUT'))).status,
  ).toBe(401);
});
it('supports manual pages without credentials and returns validation, scope and conflict statuses', async () => {
  const { ws, api } = await fixture();
  const space = ws.spaces()[0].id;
  const path = `/api/spaces/${space}/pages`;
  expect((await api(path, request({ title: '' }))).status).toBe(400);
  expect((await api('/api/spaces/missing/pages')).status).toBe(404);
  const result = await api(path, request({ title: 'Document' }));
  expect(result.status).toBe(201);
  const page = await result.json();
  expect(
    (
      await api(
        `${path}/${page.id}`,
        request({ expectedRevision: 1, content: 'First' }, 'PATCH'),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await api(
        `${path}/${page.id}`,
        request({ expectedRevision: 1, content: 'Stale' }, 'PATCH'),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await api(
        `${path}/${page.id}/conversation`,
        request({ dotId: ws.dots()[0].id }),
      )
    ).status,
  ).toBe(200);
  expect(ws.pages.get(space, page.id).content).toBe('First');
  expect(
    (
      await api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
    ).status,
  ).toBe(400);
});
it('keeps page routes behind session authentication and browser origin checks', async () => {
  const { ws, api, app } = await fixture();
  const path = `/api/spaces/${ws.spaces()[0].id}/pages`;
  expect((await app.request(path)).status).toBe(401);
  expect((await api(path)).status).toBe(200);
  expect(
    (
      await api(path, {
        ...request({ title: 'Cross-origin' }),
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.example',
        },
      })
    ).status,
  ).toBe(403);
});

it('saves reviewed drafts once and rechecks the Dot’s Space access', async () => {
  const { ws, api } = await fixture();
  const dot = ws.dots()[0];
  ws.bindThread('review-thread', dot.id, 'Review');
  const draft = {
    title: 'Launch brief',
    content: 'A reviewed draft.',
    spaceId: dot.spaceId,
    toolCallId: 'review-1',
  };
  const path = '/api/conversations/review-thread/reviewed-page';
  const first = await api(path, request(draft));
  expect(first.status).toBe(201);
  const saved = await first.json();
  const retry = await api(path, request(draft));
  expect((await retry.json()).id).toBe(saved.id);
  expect(
    (await api(path, request({ ...draft, title: '  Launch brief  ' }))).status,
  ).toBe(201);
  expect(saved.reviewDraft).toEqual({
    title: draft.title,
    content: draft.content,
    spaceId: dot.spaceId,
  });
  for (const changed of [
    { ...draft, title: 'Different title' },
    { ...draft, content: 'Different content.' },
  ]) {
    const conflict = await api(path, request(changed));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: expect.stringContaining('different draft'),
    });
  }
  expect(ws.pages.list(dot.spaceId)).toHaveLength(1);
  ws.pages.update(dot.spaceId, saved.id, {
    expectedRevision: 1,
    content: 'The saved page was edited later.',
  });
  const restored = await api(`${path}/review-1`);
  expect(await restored.json()).toMatchObject({
    content: 'The saved page was edited later.',
    reviewDraft: {
      title: draft.title,
      content: draft.content,
      spaceId: dot.spaceId,
    },
  });
  const retryAfterEdit = await api(path, request(draft));
  expect((await retryAfterEdit.json()).id).toBe(saved.id);
  const authorizedOther = ws.createSpace('Authorized other', '');
  ws.updateDot(dot.id, {
    ...dot,
    spaceIds: [dot.spaceId, authorizedOther.id],
  });
  expect(
    (await api(path, request({ ...draft, spaceId: authorizedOther.id })))
      .status,
  ).toBe(409);
  const other = ws.createSpace('Other', '');
  ws.updateDot(dot.id, { ...dot, spaceId: other.id, spaceIds: [other.id] });
  expect((await api(path, request(draft))).status).toBe(403);
  expect(ws.pages.list(dot.spaceId)).toHaveLength(1);
});

it('restores review receipts through the owner API with current thread and Space authorization', async () => {
  const { ws, api, app } = await fixture();
  const dot = ws.dots()[0];
  ws.bindThread('review-restore', dot.id, 'Review');
  const base = '/api/conversations/review-restore/reviewed-page';
  expect((await app.request(`${base}/call`)).status).toBe(401);
  expect(await (await api(`${base}/call`)).json()).toBeNull();
  const saved = ws.pages.createReviewed(
    dot.spaceId,
    { title: 'Saved', content: 'Evidence' },
    'review-restore',
    'call',
  );
  expect(await (await api(`${base}/call`)).json()).toMatchObject({
    id: saved.id,
    spaceId: dot.spaceId,
  });
  ws.bindThread('other-thread', dot.id, 'Other');
  expect(
    await (
      await api('/api/conversations/other-thread/reviewed-page/call')
    ).json(),
  ).toBeNull();
  expect(
    (await api('/api/conversations/missing-thread/reviewed-page/call')).status,
  ).not.toBe(200);
  const other = ws.createSpace('Other', '');
  ws.updateDot(dot.id, { ...dot, spaceId: other.id, spaceIds: [other.id] });
  expect((await api(`${base}/call`)).status).toBe(403);
});

it('answers malformed JSON and invalid Space access with 400 on workspace routes', async () => {
  const { ws, api } = await fixture();
  const dot = ws.dots()[0];
  for (const path of ['/api/spaces', '/api/dots', '/api/conversations']) {
    const response = await api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(response.status).toBe(400);
  }
  const body = {
    name: dot.name,
    instructions: dot.instructions,
    researchAllowed: true,
    memoryAllowed: true,
  };
  expect(
    (await api('/api/dots', request({ ...body, spaceId: 'missing-space' })))
      .status,
  ).toBe(400);
  expect(
    (
      await api(
        `/api/dots/${dot.id}`,
        request({ ...body, spaceIds: ['missing-space'] }, 'PUT'),
      )
    ).status,
  ).toBe(400);
});

it('keeps upstream JSON parsing failures on workspace routes as 503', async () => {
  const { api } = await fixture();
  // Les routes travaillent sur le workspace porté (nouvelle instance) :
  // espionner le prototype, pas l'instance de la fixture.
  const spy = vi
    .spyOn(WorkspaceStore.prototype, 'createSpace')
    .mockImplementation(() => {
      throw new SyntaxError('Unexpected token in upstream response');
    });
  try {
    const response = await api(
      '/api/spaces',
      request({ name: 'Valid', description: '' }),
    );
    expect(response.status).toBe(503);
  } finally {
    spy.mockRestore();
  }
});

it('deletes pages through the API and returns 404 for missing pages or spaces', async () => {
  const { ws, api } = await fixture();
  const space = ws.spaces()[0].id;
  const page = ws.pages.create(space, { title: 'To Delete' });
  const path = `/api/spaces/${space}/pages/${page.id}`;

  const res = await api(path, request(undefined, 'DELETE'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(ws.pages.list(space)).toHaveLength(0);

  const missing = await api(path, request(undefined, 'DELETE'));
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({
    error: 'Page not found in this Space.',
  });

  const missingSpace = await api(
    `/api/spaces/missing-space/pages/${page.id}`,
    request(undefined, 'DELETE'),
  );
  expect(missingSpace.status).toBe(404);
  expect(await missingSpace.json()).toEqual({ error: 'Space not found.' });
});

it('reports a deleted reviewed page instead of failing or recreating it', async () => {
  const { ws, api } = await fixture();
  const dot = ws.dots()[0];
  ws.bindThread('review-deleted', dot.id, 'Review');
  const base = '/api/conversations/review-deleted/reviewed-page';
  const saved = ws.pages.createReviewed(
    dot.spaceId,
    { title: 'Saved', content: 'Evidence' },
    'review-deleted',
    'call',
  );
  expect(ws.pages.delete(dot.spaceId, saved.id)).toBe(true);
  expect(await (await api(`${base}/call`)).json()).toEqual({
    deleted: true,
    pageId: saved.id,
    spaceId: dot.spaceId,
    reviewDraft: {
      title: 'Saved',
      content: 'Evidence',
      spaceId: dot.spaceId,
    },
  });
  const retry = await api(
    base,
    request(
      {
        title: 'Saved',
        content: 'Evidence',
        spaceId: dot.spaceId,
        toolCallId: 'call',
      },
      'POST',
    ),
  );
  expect(retry.status).toBe(404);
  expect(ws.pages.list(dot.spaceId)).toHaveLength(0);
});

it.each([
  ['GET', '/reviewed-page/tool'],
  ['POST', '/reviewed-page'],
  ['GET', '/page-context'],
  ['POST', '/page'],
])(
  'returns 404 for an unknown conversation on %s %s',
  async (method, suffix) => {
    const { ws, api } = await fixture();
    const body =
      suffix === '/reviewed-page'
        ? {
            title: 'Draft',
            content: 'Text',
            spaceId: ws.spaces()[0].id,
            toolCallId: 'tool',
          }
        : { title: 'Draft' };
    const response = await api(
      `/api/conversations/missing${suffix}`,
      method === 'GET' ? undefined : request(body),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Conversation does not belong to this Dot and owner.',
    });
  },
);

it('keeps real Intelligence failures as 503 without exposing details', async () => {
  const { ws, api } = await fixture();
  ws.bindThread('valid-thread', ws.dots()[0].id, 'Conversation');
  // Les routes travaillent sur le PageService porté (nouvelle instance).
  const spy = vi
    .spyOn(PageService.prototype, 'saveConversation')
    .mockRejectedValueOnce(new Error('Provider secret'));
  try {
    const response = await api(
      '/api/conversations/valid-thread/page',
      request({ title: 'Draft' }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        'Page operation could not complete. Retry; your draft has not been discarded.',
    });
  } finally {
    spy.mockRestore();
  }
});

it('answers 404, not 503, for a conversation or call that does not exist', async () => {
  const { api } = await fixture();
  for (const path of [
    '/api/conversations/missing/capture',
    '/api/voice/calls/missing',
  ]) {
    const response = await api(path);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /not found|does not belong/,
    );
  }
});

it('maps Conversation not found to 404 in onError', () => {
  expect(isNotFoundMessage('Conversation not found.')).toBe(true);
  expect(isNotFoundMessage('Conversation not found')).toBe(true);
  expect(isNotFoundMessage('Dot not found.')).toBe(true);
  expect(isNotFoundMessage('Call not found.')).toBe(true);
  expect(
    isNotFoundMessage('Conversation does not belong to this Dot and owner.'),
  ).toBe(true);
  expect(isNotFoundMessage('Conversation failed.')).toBe(false);
  expect(isNotFoundMessage('Provider secret')).toBe(false);
});

it('POST /dots puts the avatar in the avatar slot, not the model slot', async () => {
  const { api } = await fixture();
  const spaceRes = await api(
    '/api/spaces',
    request({ name: 'Design', description: '' }),
  );
  expect(spaceRes.status).toBe(201);
  const space = (await spaceRes.json()) as { id: string };
  const res = await api(
    '/api/dots',
    request({
      spaceId: space.id,
      name: 'Scout',
      instructions: 'Be concise',
      researchAllowed: false,
      memoryAllowed: true,
      avatar: 'leo',
    }),
  );
  expect(res.status).toBe(201);
  const dot = (await res.json()) as {
    avatar: string | null;
    model: string | null;
  };
  expect(dot.avatar).toBe('leo');
  expect(dot.model).toBeNull();
});
