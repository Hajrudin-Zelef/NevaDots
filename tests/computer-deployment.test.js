import { expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { hardenSupervisorEnvironment } from '../deployment/computers/harden-supervisor.mjs';
import {
  patchDockerEnsureOptions,
  patchDockerHostConfig,
  patchIndexCpus,
} from '../deployment/computers/cpu-cap-supervisor.mjs';
import { computerCpus } from '../deployment/computers/computer-cpus.ts';

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

it('parses COMPUTER_CPUS strictly into nanocpus', () => {
  expect(computerCpus(undefined)).toEqual({
    ok: true,
    nanoCpus: undefined,
  });
  expect(computerCpus('')).toEqual({ ok: true, nanoCpus: undefined });
  expect(computerCpus('2')).toEqual({ ok: true, nanoCpus: 2_000_000_000 });
  expect(computerCpus('1.5')).toEqual({ ok: true, nanoCpus: 1_500_000_000 });
  expect(computerCpus('0')).toEqual({ ok: false, reason: expect.any(String) });
  expect(computerCpus('2cpus')).toEqual({
    ok: false,
    reason: expect.any(String),
  });
  expect(computerCpus('-1')).toEqual({
    ok: false,
    reason: expect.any(String),
  });
});

const dockerFixture = `export type EnsureOptions = {
  image: string;
  memoryBytes?: number;
};
const host = {
    // A runaway Bot is a resource problem for itself.
    ...(options.memoryBytes ? { Memory: options.memoryBytes } : {}),
    PidsLimit: options.pidsLimit ?? 512,
};`;

it('adds a NanoCpus cap next to the memory cap', () => {
  const options = patchDockerEnsureOptions(dockerFixture);
  expect(options).toContain('nanoCpus?: number;');
  const host = patchDockerHostConfig(dockerFixture);
  expect(host).toContain(
    '...(options.nanoCpus ? { NanoCpus: options.nanoCpus } : {}),',
  );
});

const indexFixture = `import { computerMemoryBytes } from "./computer-memory-bytes";
const memoryBytes = resolvedMemory.bytes;
ensure(names, {
      ...(memoryBytes ? { memoryBytes } : {}),
});`;

it('wires COMPUTER_CPUS from env to ensure options', () => {
  const patched = patchIndexCpus(indexFixture);
  expect(patched).toContain('import { computerCpus } from "./computer-cpus";');
  expect(patched).toContain('computerCpus(process.env.COMPUTER_CPUS)');
  expect(patched).toContain('...(nanoCpus ? { nanoCpus } : {}),');
});

it('refuses missing or ambiguous CPU patch targets', () => {
  expect(() => patchDockerEnsureOptions('changed upstream')).toThrow(
    /contract changed/,
  );
  expect(() => patchDockerHostConfig('changed upstream')).toThrow(
    /contract changed/,
  );
  expect(() => patchIndexCpus('changed upstream')).toThrow(/contract changed/);
  expect(() => patchDockerEnsureOptions(dockerFixture + dockerFixture)).toThrow(
    /contract changed/,
  );
});
it('pins the dev image on the exact base and lists the toolchain', async () => {
  const { readFileSync } = await import('node:fs');
  const dockerfile = readFileSync(
    new URL('../deployment/computers/computer-dev.Dockerfile', import.meta.url),
    'utf8',
  );
  expect(dockerfile).toMatch(/^FROM opendots-computer:b6932d3\n/m);
  for (const pkg of [
    'git',
    'openssh-client',
    'python3',
    'python3-pip',
    'python3-venv',
    'build-essential',
    'pkg-config',
    'cmake',
    'ripgrep',
    'jq',
    'tree',
  ])
    expect(dockerfile).toContain(pkg);
  expect(dockerfile).toContain('rm -rf /var/lib/apt/lists');
});
