# Source comes from the exact OpenBot revision in compose.computers.yml.
# Image épinglée par digest (Renovate : docker:pinDigests).
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0
WORKDIR /app
COPY --from=openbot supervisor/package.json supervisor/bun.lock ./
RUN bun install --frozen-lockfile
COPY --from=openbot supervisor/src ./src
COPY deployment/computers/LICENSE.openbot ./LICENSE.openbot
COPY deployment/computers/harden-supervisor.mjs /tmp/harden-supervisor.mjs
RUN bun /tmp/harden-supervisor.mjs /app/src/environment.ts && rm /tmp/harden-supervisor.mjs
COPY deployment/computers/computer-cpus.ts /app/src/computer-cpus.ts
COPY deployment/computers/cpu-cap-supervisor.mjs /tmp/cpu-cap-supervisor.mjs
RUN bun /tmp/cpu-cap-supervisor.mjs /app/src && rm /tmp/cpu-cap-supervisor.mjs
COPY deployment/computers/logcap-supervisor.mjs /tmp/logcap-supervisor.mjs
RUN bun /tmp/logcap-supervisor.mjs /app/src/docker.ts && rm /tmp/logcap-supervisor.mjs
EXPOSE 4300
CMD ["bun", "src/index.ts"]
