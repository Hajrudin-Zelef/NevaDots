import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Fail closed if the pinned upstream contract changes. Only child authentication
// changes; OpenBot retains ownership of container creation, volumes and lifecycle.
export function hardenSupervisorEnvironment(source) {
  const before =
    'const computerToken = env.COMPUTER_TOKEN?.trim() || undefined;';
  if (source.split(before).length !== 2)
    throw new Error(
      'Pinned OpenBot environment contract changed; review before building.',
    );
  // Forward the browser idle sweep setting to each computer so a deployment can
  // keep Chromium resident (`COMPUTER_BROWSER_IDLE_MS=0`), which avoids the
  // wedged relaunch after the idle sweep closes it. It rides the
  // existing EGRESS_PROXY passthrough filter rather than a new allow-list path.
  const passthrough = 'key.startsWith("EGRESS_PROXY")';
  if (source.split(passthrough).length !== 2)
    throw new Error(
      'Pinned OpenBot passthrough contract changed; review before building.',
    );
  const withAuth = `import { createHmac } from "node:crypto";\n${source.replace(
    before,
    `const master = env.COMPUTER_TOKEN?.trim();
  if (!master || master.length < 24) throw new Error("COMPUTER_TOKEN must contain at least 24 characters.");
  const computerToken = createHmac("sha256", master).update("opendots-computer:" + botId).digest("hex");`,
  )}`;
  return withAuth.replace(
    passthrough,
    `${passthrough} || key === "COMPUTER_BROWSER_IDLE_MS"`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const path = process.argv[2];
  if (!path) throw new Error('Pass the pinned supervisor environment.ts path.');
  await writeFile(
    path,
    hardenSupervisorEnvironment(await readFile(path, 'utf8')),
  );
}
