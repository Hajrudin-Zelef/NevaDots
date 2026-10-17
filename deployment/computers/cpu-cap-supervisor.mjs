import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Fail closed if the pinned upstream contract changes. Only a CPU cap is
// added; OpenBot retains ownership of container creation, volumes and
// lifecycle. A computer that escapes its 2 CPUs is a resource problem for
// every Bot on the host, so an unrecognised contract refuses to build rather
// than run computers uncapped.
export function patchDockerEnsureOptions(source) {
  const before = '  memoryBytes?: number;';
  if (source.split(before).length !== 2)
    throw new Error(
      'Pinned OpenBot docker contract changed; review before building.',
    );
  return source.replace(
    before,
    `${before}\n  /** CPU cap in nanocpus, from COMPUTER_CPUS. Unset means no cap. */\n  nanoCpus?: number;`,
  );
}

export function patchDockerHostConfig(source) {
  const before =
    '    ...(options.memoryBytes ? { Memory: options.memoryBytes } : {}),';
  if (source.split(before).length !== 2)
    throw new Error(
      'Pinned OpenBot docker contract changed; review before building.',
    );
  return source.replace(
    before,
    `${before}\n    // Two CPUs per computer by default: a runaway Bot slows itself, not the host.\n    ...(options.nanoCpus ? { NanoCpus: options.nanoCpus } : {}),`,
  );
}

export function patchIndexCpus(source) {
  const importBefore =
    'import { computerMemoryBytes } from "./computer-memory-bytes";';
  if (source.split(importBefore).length !== 2)
    throw new Error(
      'Pinned OpenBot index contract changed; review before building.',
    );
  const parseBefore = 'const memoryBytes = resolvedMemory.bytes;';
  if (source.split(parseBefore).length !== 2)
    throw new Error(
      'Pinned OpenBot index contract changed; review before building.',
    );
  const passBefore = '      ...(memoryBytes ? { memoryBytes } : {}),';
  if (source.split(passBefore).length !== 2)
    throw new Error(
      'Pinned OpenBot index contract changed; review before building.',
    );
  return source
    .replace(
      importBefore,
      `${importBefore}\nimport { computerCpus } from "./computer-cpus";`,
    )
    .replace(
      parseBefore,
      `${parseBefore}\nconst resolvedCpus = computerCpus(process.env.COMPUTER_CPUS);\nif (!resolvedCpus.ok) {\n  console.error(resolvedCpus.reason);\n  process.exit(1);\n}\nconst nanoCpus = resolvedCpus.nanoCpus;`,
    )
    .replace(
      passBefore,
      `${passBefore}\n      ...(nanoCpus ? { nanoCpus } : {}),`,
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const dir = process.argv[2] ?? '/app/src';
  const dockerPath = `${dir}/docker.ts`;
  const indexPath = `${dir}/index.ts`;
  await writeFile(
    dockerPath,
    patchDockerHostConfig(
      patchDockerEnsureOptions(await readFile(dockerPath, 'utf8')),
    ),
  );
  await writeFile(indexPath, patchIndexCpus(await readFile(indexPath, 'utf8')));
}
