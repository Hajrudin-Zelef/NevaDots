import { describe, expect, it } from 'vitest';
import {
  isPublicAddress,
  validateMcpUrl,
  validateUrl,
} from '../src/server/net-security.js';
describe('browser network boundaries', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    '2001::1',
    '2001:100::1',
    '2002:7f00:1::',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '224.0.0.1',
    // RFC 6890 completions (Lot 3a).
    '192.31.196.1',
    '192.52.193.1',
    '192.88.99.1',
    '192.175.48.1',
    '2620:4f:8000::1',
    '3fff::1',
    '203.0.113.5',
    '203.0.0.5',
    '192.0.2.5',
  ])('rejects private or special address %s', (address) =>
    expect(isPublicAddress(address)).toBe(false),
  );
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '203.0.1.5'])(
    'accepts public address %s',
    (address) => expect(isPublicAddress(address)).toBe(true),
  );
  it('rejects non-http URLs and embedded credentials', async () => {
    await expect(validateUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(
      validateUrl('https://user:pass@example.com'),
    ).rejects.toThrow();
    await expect(validateUrl('http://127.0.0.1')).rejects.toThrow();
  });
  it('exempts loopback MCP endpoints on any port, gates the rest by host', async () => {
    // Owner-trusted local servers, custom ports included.
    await expect(
      validateMcpUrl('http://localhost:4312/mcp'),
    ).resolves.toMatchObject({ url: expect.any(URL) });
    await expect(
      validateMcpUrl('http://127.0.0.1:3000/x'),
    ).resolves.toBeDefined();
    await expect(validateMcpUrl('http://[::1]:8080/x')).resolves.toBeDefined();
    // Private hosts refused without any port restriction logic.
    await expect(validateMcpUrl('http://169.254.169.254/')).rejects.toThrow(
      'Private or special',
    );
    await expect(validateMcpUrl('http://10.0.0.5:3000/x')).rejects.toThrow(
      'Private or special',
    );
    // Public hosts pass on any port; credentials and schemes still gated.
    await expect(
      validateMcpUrl('https://8.8.8.8:8443/x'),
    ).resolves.toBeDefined();
    await expect(validateMcpUrl('ftp://8.8.8.8/x')).rejects.toThrow();
    await expect(validateMcpUrl('https://user:pw@8.8.8.8/x')).rejects.toThrow();
  });
});
