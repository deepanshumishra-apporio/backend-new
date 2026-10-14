# syntax=docker/dockerfile:1
#
# Production image. Built and pushed to GHCR by .github/workflows/pipeline.yml;
# the same image also runs `prisma migrate deploy` before each rollout, which is
# why the Prisma CLI ships in it.

# Bun version matches local development (`bun --version`). Bump both together.
FROM oven/bun:1.3.13-slim AS base
# openssl: the Prisma schema engine (migrate deploy) links against libssl.
# ca-certificates: TLS to Neon (sslmode=verify-full), FP and MSG91.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# prisma.config.ts resolves a datasource URL even for `generate`. Nothing
# connects to this placeholder; real URLs come from the server's env file.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" bun run db:generate

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000
COPY --from=build --chown=bun:bun /app /app
USER bun
EXPOSE 3000
# The deploy script waits for this to report healthy before retiring the old
# container, and rolls back if it never does.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Not `bun run start`: that wraps the server in a shell, which would swallow the
# SIGTERM that index.ts uses for its graceful shutdown.
CMD ["bun", "run", "index.ts"]
