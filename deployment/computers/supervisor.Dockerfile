# Source comes from the exact OpenBot revision in compose.computers.yml.
FROM oven/bun:1.3.14-alpine
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
EXPOSE 4300
CMD ["bun", "src/index.ts"]
