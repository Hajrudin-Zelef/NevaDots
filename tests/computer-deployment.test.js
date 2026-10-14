import { expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { hardenSupervisorEnvironment } from '../deployment/computers/harden-supervisor.mjs';

const upstream = `export function environmentFor(botId, env) {
  const computerToken = env.COMPUTER_TOKEN?.trim() || undefined;
  const passthrough = Object.entries(env)
    .filter(([key]) =>
      key.startsWith("EGRESS_PROXY"),
    )
    .map(([key, value]) => \`\${key}=\${value}\`);
  return [\`COMPUTER_BOT_ID=\${botId}\`, \`COMPUTER_TOKEN=\${computerToken}\`, ...passthrough];
}`;

const load = (source) =>
  import(`data:text/javascript,${encodeURIComponent(source)}`);

it('gives each child its own credential without forwarding the master', async () => {
  const module = await load(hardenSupervisorEnvironment(upstream));
  const master = 'fixture-master-only-for-this-test';
  const first = module.environmentFor('dot-a', { COMPUTER_TOKEN: master });
  const second = module.environmentFor('dot-b', { COMPUTER_TOKEN: master });
  expect(first[1]).toBe(
    `COMPUTER_TOKEN=${createHmac('sha256', master).update('opendots-computer:dot-a').digest('hex')}`,
  );
  expect(first[1]).not.toBe(second[1]);
  expect(first.join()).not.toContain(master);
  expect(() =>
    module.environmentFor('dot-a', { COMPUTER_TOKEN: 'short' }),
  ).toThrow();
});

it('forwards COMPUTER_BROWSER_IDLE_MS to each child', async () => {
  const module = await load(hardenSupervisorEnvironment(upstream));
  const master = 'fixture-master-only-for-this-test';
  const child = module.environmentFor('dot-a', {
    COMPUTER_TOKEN: master,
    COMPUTER_BROWSER_IDLE_MS: '0',
    EGRESS_PROXY_URL: 'http://proxy:8080',
    UNRELATED: 'nope',
  });
  expect(child.join()).toContain('COMPUTER_BROWSER_IDLE_MS=0');
  // unrelated vars are still not forwarded
  expect(child.join()).not.toContain('UNRELATED=');
});

it('refuses missing or ambiguous upstream patch targets', () => {
  expect(() => hardenSupervisorEnvironment('changed upstream')).toThrow(
    /contract changed/,
  );
  expect(() => hardenSupervisorEnvironment(upstream + upstream)).toThrow(
    /contract changed/,
  );
});
