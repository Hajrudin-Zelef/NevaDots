# OpenBot computer services

OpenDots builds the computer service and supervisor from CopilotKit/OpenBot revision `b6932d31a8d6e7896c15139dfc27a6c6911deb27` (MIT). Their source is downloaded by BuildKit from the pinned Git context; it is not resolved from a moving branch or a `latest` image.

The computer service is unchanged. The supervisor keeps its narrow ensure/stop/reset/list implementation and resource ownership checks. Its image omits the unused SPIRE CLI, and applies two fail-closed patches:

- `harden-supervisor.mjs`: each computer receives `HMAC-SHA256(COMPUTER_TOKEN, "opendots-computer:" + dotId)` instead of the master token. The application uses the same derivation. No supervisor token, model key, or master computer token is forwarded to a computer.
- `cpu-cap-supervisor.mjs` + `computer-cpus.ts`: each computer is capped at `COMPUTER_CPUS` CPUs (default `2` in `compose.computers.yml`, as `NanoCpus` in the HostConfig), parsed strictly at supervisor boot — garbage refuses to start rather than running uncapped. RAM keeps its `COMPUTER_MEMORY_BYTES` cap (default 2 GiB).

If the pinned upstream line changes, the patches refuse to build. Upgrades require reviewing the API contracts, ownership/volume behavior, and these patches together. On the next ensure request after a master-token change, the pinned supervisor replaces owned containers with the new credential while retaining their volumes. Do not delete profile or workspace volumes during normal updates.

## Dev toolchain image (P4, agentic coding)

`computer-dev.Dockerfile` extends the pinned `opendots-computer:b6932d3` image with one apt layer: `git python3 python3-pip python3-venv build-essential ripgrep jq less`. The base stays byte-identical to upstream; only this additive layer diverges. The supervisor runs the `opendots-computer:b6932d3-dev` tag (`COMPUTER_IMAGE` in `compose.computers.yml`).

Build order matters (the dev image resolves its `FROM` from local images):
`docker compose -f compose.computers.yml build computer-image computer-image-dev`,
then `up -d` the supervisor and recreate computers (`docker rm -f opendots-computer-<id>` + `POST /dots/:id/computer/start`) — volumes are retained.

See [computer setup](../../docs/COMPUTERS.md). OpenBot's MIT license is included in [LICENSE.openbot](LICENSE.openbot).
