# syntax=docker/dockerfile:1.6

# ─── Build stage ────────────────────────────────────────────────────────────
# Bun handles the workspace install and both package builds.
FROM oven/bun:1 AS builder
WORKDIR /repo

# Copy the whole monorepo (respects .dockerignore to skip node_modules, dist,
# local dev data, etc). A minimal-manifest pre-copy would speed cache misses,
# but this keeps the Dockerfile simple and gets the job done.
COPY . .

RUN bun install --frozen-lockfile
RUN bun run --filter '@dashcommerce/core' build
RUN bun run --filter '@dashcommerce/starter' build

# ─── Runtime stage ──────────────────────────────────────────────────────────
# Staying on Bun keeps native module resolution (better-sqlite3) consistent
# with the build stage and avoids shuffling workspace symlinks.
FROM oven/bun:1 AS runtime
WORKDIR /app

COPY --from=builder /repo /app

WORKDIR /app/packages/starter

# Data + uploads live on named volumes in compose. The SQLITE_URL env lets
# you point at any path without editing the source (Postgres via
# DATABASE_URL also works — see astro.config.mjs).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    SQLITE_URL=file:/data/data.db

VOLUME ["/data", "/app/packages/starter/uploads"]
EXPOSE 4321

CMD ["bun", "./dist/server/entry.mjs"]
