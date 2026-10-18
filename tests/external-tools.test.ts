import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalAccounts } from '../src/server/external-accounts.js';
import { externalAccountTools } from '../src/server/external-tools.js';
import {
  encryptSecret,
  type SecretConfigStore,
} from '../src/server/secrets.js';

const TEST_SECRET = 'test-secret-for-external-tools';

function memoryStore(): SecretConfigStore {
  const data = new Map<string, string>();
  return {
    configGet: (key) => data.get(key),
    configSet: (key, value) => {
      data.set(key, value);
    },
    configDelete: (key) => {
      data.delete(key);
    },
    configList: (prefix) =>
      [...data.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
  };
}

/** Seeds a connected account without hitting the network (no live validation). */
function seed(
  store: SecretConfigStore,
  id: string,
  values: Record<string, string>,
  login = 'test-login',
) {
  store.configSet(
    `external:${id}`,
    JSON.stringify({
      fieldsCipher: encryptSecret(JSON.stringify(values), TEST_SECRET),
      login,
    }),
  );
}

type Executor = (input: unknown) => Promise<string>;

describe('external_service_call', () => {
  let store: SecretConfigStore;
  let accounts: ExternalAccounts;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = memoryStore();
    accounts = new ExternalAccounts(store, TEST_SECRET);
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function tool(): Executor {
    const tools = externalAccountTools(
      accounts,
      () => {},
      new AbortController().signal,
    );
    expect(tools).toHaveLength(1);
    const execute = (tools[0] as { execute?: Executor }).execute;
    expect(typeof execute).toBe('function');
    return execute as Executor;
  }

  it('exposes no tool when nothing is connected', () => {
    expect(
      externalAccountTools(accounts, () => {}, new AbortController().signal),
    ).toHaveLength(0);
  });

  it('calls GitHub with a Bearer token', async () => {
    seed(store, 'github', { token: 'ghp_test' });
    const result = await tool()({
      service: 'github',
      method: 'GET',
      path: '/repos/octocat/hello-world',
    });
    expect(result).toContain('"ok":true');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://api.github.com/repos/octocat/hello-world',
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ghp_test',
    );
  });

  it('calls GitLab with the PRIVATE-TOKEN header', async () => {
    seed(store, 'gitlab', { token: 'glpat-test' });
    await tool()({ service: 'gitlab', method: 'GET', path: '/user' });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://gitlab.com/api/v4/user');
    expect((init.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe(
      'glpat-test',
    );
  });

  it('passes Trello credentials as query parameters', async () => {
    seed(store, 'trello', { key: 'k123', token: 't456' });
    await tool()({ service: 'trello', method: 'GET', path: '/members/me' });
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://api.trello.com/1/members/me?key=k123&token=t456',
    );
  });

  it('sends a JSON body on POST', async () => {
    seed(store, 'slack', { token: 'xoxb-test' });
    await tool()({
      service: 'slack',
      method: 'POST',
      path: '/chat.postMessage',
      body: { channel: 'C1', text: 'hi' },
    });
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(init.body).toBe(JSON.stringify({ channel: 'C1', text: 'hi' }));
  });

  it('rejects a service disconnected after the tool was built', async () => {
    seed(store, 'github', { token: 'ghp_test' });
    seed(store, 'gitlab', { token: 'glpat-test' });
    const run = tool();
    store.configDelete('external:gitlab');
    await expect(
      run({ service: 'gitlab', method: 'GET', path: '/user' }),
    ).rejects.toThrow('not connected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects absolute and protocol-relative paths without network access', async () => {
    seed(store, 'github', { token: 'ghp_test' });
    for (const path of ['https://evil.com/x', '//evil.com/x', '..\\windows']) {
      await expect(
        tool()({ service: 'github', method: 'GET', path }),
      ).rejects.toThrow('Invalid path');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects dot segments and separator smuggling after decoding', async () => {
    seed(store, 'github', { token: 'ghp_test' });
    for (const path of [
      '/../admin',
      '/a/../b',
      '/%2e%2e/admin',
      '/%2E%2E/admin',
      '/a/%2e%2e/b',
      '/a%2F..%2Fb',
      '/a%5C..%5Cb',
      '/a/%2e/b',
    ]) {
      await expect(
        tool()({ service: 'github', method: 'GET', path }),
      ).rejects.toThrow('Invalid path');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets authentication query parameters win over agent ones', async () => {
    seed(store, 'trello', { key: 'k123', token: 't456' });
    await tool()({
      service: 'trello',
      method: 'GET',
      path: '/members/me',
      query: { key: 'agent-key', token: 'agent-token', extra: 'x' },
    });
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.searchParams.get('key')).toBe('k123');
    expect(url.searchParams.get('token')).toBe('t456');
    expect(url.searchParams.get('extra')).toBe('x');
  });

  it('maps 401 to a reconnect hint without leaking the token', async () => {
    seed(store, 'github', { token: 'ghp_bad' });
    fetchMock.mockResolvedValueOnce(
      new Response('Bad credentials', { status: 401 }),
    );
    await expect(
      tool()({ service: 'github', method: 'GET', path: '/user' }),
    ).rejects.toThrow('rejected the stored credentials');
  });

  it('truncates oversized results', async () => {
    seed(store, 'github', { token: 'ghp_test' });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: 'x'.repeat(9000) }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await tool()({
      service: 'github',
      method: 'GET',
      path: '/x',
    });
    expect(result.length).toBeLessThanOrEqual(6100);
    expect(result).toContain('truncated');
  });

  it('streams a huge body bounded without buffering it all', async () => {
    seed(store, 'github', { token: 'ghp_test' });
    const CHUNK = new Uint8Array(1024).fill(0x78); // 'x'
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 4096) {
          controller.close();
          return;
        }
        controller.enqueue(CHUNK);
      },
    });
    // Declared length lies (small); the chunk cap must still bound memory.
    fetchMock.mockResolvedValueOnce(
      new Response(stream, { headers: { 'content-type': 'text/plain' } }),
    );
    const result = await tool()({
      service: 'github',
      method: 'GET',
      path: '/big',
    });
    expect(result.length).toBeLessThanOrEqual(6100);
    expect(result).toContain('truncated');
    // The reader was cancelled early: the body was not fully drained.
    expect(pulls).toBeLessThan(100);
  });

  it('returns an empty result for a body-less 204 response', async () => {
    seed(store, 'github', { token: 'ghp_test' });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await tool()({
      service: 'github',
      method: 'GET',
      path: '/empty',
    });
    expect(result).toBe('');
  });

  it('reports HTTP failures without echoing the response body', async () => {
    seed(store, 'github', { token: 'ghp_test' });
    fetchMock.mockResolvedValueOnce(
      new Response('internal detail token=leak', { status: 500 }),
    );
    let message = '';
    try {
      await tool()({ service: 'github', method: 'GET', path: '/x' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('HTTP 500');
    expect(message).not.toContain('internal detail');
    expect(message).not.toContain('leak');
  });

  it('refuses non-HTTP services such as MEGA', async () => {
    seed(store, 'mega', { email: 'a@b.c', password: 'x' }, 'a@b.c');
    // MEGA is connected but exposes no HTTP API: no tool is offered for it.
    expect(
      externalAccountTools(accounts, () => {}, new AbortController().signal),
    ).toHaveLength(0);
  });

  it('runs the abort check before any network access', async () => {
    seed(store, 'github', { token: 'ghp_test' });
    const tools = externalAccountTools(
      accounts,
      () => {
        throw new Error('aborted');
      },
      new AbortController().signal,
    );
    const execute = (tools[0] as { execute?: Executor }).execute as Executor;
    await expect(
      execute({ service: 'github', method: 'GET', path: '/' }),
    ).rejects.toThrow('aborted');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
