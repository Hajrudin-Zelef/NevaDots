import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Fail closed if the pinned upstream contract changes. Caps container logs
// (json-file 10m x 3 files): without rotation a chatty Bot grows its log
// forever and fills the host disk, and ext4/overlayfs offers no per-container
// disk quota to catch it. Only the log config changes; OpenBot retains
// ownership of container creation, volumes and lifecycle.
export function patchDockerLogCap(source) {
  const before = '    ShmSize: 1_073_741_824,';
  if (source.split(before).length !== 2)
    throw new Error(
      'Pinned OpenBot docker contract changed; review before building.',
    );
  return source.replace(
    before,
    `${before}\n    // Logs bornes : un Bot bavard ne remplit pas le disque de l'hote (json-file sans rotation = croissance infinie).\n    LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const path = process.argv[2] ?? '/app/src/docker.ts';
  await writeFile(path, patchDockerLogCap(await readFile(path, 'utf8')));
}
