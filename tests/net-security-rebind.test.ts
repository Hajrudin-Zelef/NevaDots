import { describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

import { revalidateUrl, validateUrl } from '../src/server/net-security.js';

describe('DNS rebinding guard', () => {
  it('refuses when the address changes between validation and request', async () => {
    lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const first = await validateUrl('https://example.com/x');
    expect(first.address).toBe('93.184.216.34');

    // Same address at request time: allowed.
    lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    await expect(
      revalidateUrl('https://example.com/x', first.address),
    ).resolves.toBeDefined();

    // Address moved to another public host: refused (rebinding).
    lookup.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }]);
    await expect(
      revalidateUrl('https://example.com/x', first.address),
    ).rejects.toThrow(/rebinding/i);

    // Address moved to a private host: refused as well (any throw).
    lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(
      revalidateUrl('https://example.com/x', first.address),
    ).rejects.toThrow();
  });
});
