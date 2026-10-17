import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Single source of truth for SSRF network boundaries (browser lane, Parallel
 * sources, computer_navigate, MCP endpoints). Every caller delegates here —
 * no duplicated allow/deny lists, so they cannot drift apart again.
 */
export function isPublicAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192) {
      if (b === 168) return false;
      // 192.0.0.0/24, 192.0.2.0/24 (TEST-NET-1). The rest of 192.0.x.x and
      // 192.2.x.x is ordinary public space — no blanket /16 block.
      if (b === 0 && (c === 0 || c === 2)) return false;
      // AS112 / AMT / deprecated 6to4-relay infrastructure.
      if (b === 31 && c === 196) return false;
      if (b === 52 && c === 193) return false;
      if (b === 88 && c === 99) return false;
      if (b === 175 && c === 48) return false;
    }
    if (a === 198) {
      if (b === 18 || b === 19) return false;
      if (b === 51 && c === 100) return false;
    }
    // 203.0.0.0/24 and 203.0.113.0/24 (TEST-NET-3) only — not the /16.
    if (a === 203 && b === 0 && (c === 0 || c === 113)) return false;
    return true;
  }
  if (isIP(ip) === 6) {
    const normalized = new URL(`http://[${ip}]`).hostname.slice(1, -1);
    const second = Number.parseInt(normalized.split(':')[1] || '0', 16);
    if (normalized.startsWith('2001:') && second < 0x200) return false;
    return (
      /^[23][0-9a-f]{3}:/.test(normalized) &&
      !/^(2001:(0:|db8:|10:|20:)|2002:|2620:4f:8000:|3fff:)/.test(normalized)
    );
  }
  return false;
}

export interface ValidatedUrl {
  url: URL;
  address: string;
  family: number;
}

export async function validateUrl(
  input: string,
  options?: { ports?: 'web' | 'any' },
): Promise<ValidatedUrl> {
  const url = new URL(input);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      'Only public HTTP(S) URLs without credentials are allowed.',
    );
  if (
    url.port &&
    !(options?.ports === 'any' || ['80', '443'].includes(url.port))
  )
    throw new Error('Only standard web ports are allowed.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  )
    throw new Error('Local addresses are blocked.');
  const addresses = await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicAddress(item.address))
  )
    throw new Error('Private or special network addresses are blocked.');
  return { url, ...addresses[0] };
}

/** Owner-trusted loopback names: a locally-run MCP server. Any port. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * MCP endpoint check. The configuring principal is the owner (trusted), so a
 * loopback server on any port stays usable; anything else must be a public
 * address (no port restriction — the risk is the host, and custom ports are
 * the reason loopback-adjacent setups exist). Residual: DNS is checked now,
 * the SDK re-resolves per fetch (TOCTOU, documented).
 */
export async function validateMcpUrl(input: string): Promise<ValidatedUrl> {
  const url = new URL(input);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      'Only public HTTP(S) URLs without credentials are allowed.',
    );
  if (isLoopbackHostname(url.hostname))
    return { url, address: url.hostname, family: 0 };
  return validateUrl(input, { ports: 'any' });
}
