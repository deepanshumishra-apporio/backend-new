// The single Prisma Client for the process.
//
// Prisma 7 has no query engine binary: it talks to Postgres through a driver
// adapter (@prisma/adapter-pg -> pg), so the connection pool is pg's and must
// be configured explicitly here. Each PrismaClient owns one pool, so creating
// more than one per process multiplies your connection count against the
// database — hence the singleton.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.ts";

const isProduction = process.env.NODE_ENV === "production";

/** Queries slower than this are logged at warn level. */
const SLOW_QUERY_MS = 500;

/**
 * Validate DATABASE_URL before handing it to pg.
 *
 * pg only understands postgres:// and postgresql://. Given a
 * `prisma+postgres://` URL it does NOT throw — it parses it into a target with
 * no user, no password and no database, so the pool fails later with a
 * confusing error. Catch it here instead.
 */
function resolveConnectionString(): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) throw new Error("DATABASE_URL is not set");

  let protocol: string;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }

  if (protocol === "prisma+postgres:" || protocol === "prisma:") {
    throw new Error(
      `DATABASE_URL uses the "${protocol.replace(":", "")}" protocol, which the pg driver ` +
        `cannot read. Use the direct postgresql:// TCP connection string instead, or switch ` +
        `the adapter to @prisma/adapter-ppg, which does speak that protocol.`,
    );
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error(`DATABASE_URL must be a postgresql:// URL (got "${protocol.replace(":", "")}")`);
  }

  return raw;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

/** Never let a connection string reach the logs — it carries the password. */
function redact(text: string): string {
  return text.replace(/(postgres(?:ql)?:\/\/)[^:@\s]+:[^@\s]+@/gi, "$1[redacted]:[redacted]@");
}

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: resolveConnectionString(),
    // pg pool settings. Driver adapters inherit the driver's defaults, which
    // are not the same as Prisma v6's, so state them rather than inherit them.
    max: intFromEnv("DATABASE_POOL_MAX", 10),
    idleTimeoutMillis: intFromEnv("DATABASE_IDLE_TIMEOUT_MS", 30_000),
    // Serverless Postgres (Neon and friends) suspends idle compute, so the
    // first connect after a cold start can be slow.
    connectionTimeoutMillis: intFromEnv("DATABASE_CONNECT_TIMEOUT_MS", 15_000),
    statement_timeout: 30_000,
    application_name: "mutual-fund-api",
  });

  const client = new PrismaClient({
    adapter,
    log: [
      { level: "query", emit: "event" },
      { level: "warn", emit: "event" },
      { level: "error", emit: "event" },
    ],
    errorFormat: isProduction ? "minimal" : "pretty",
    transactionOptions: {
      maxWait: 5_000,
      timeout: 15_000,
    },
  });

  client.$on("query", (event) => {
    // Params can contain PII, so they are never logged.
    if (event.duration >= SLOW_QUERY_MS) {
      console.warn(`[prisma] slow query ${event.duration}ms: ${event.query}`);
    }
  });
  client.$on("warn", (event) => console.warn(`[prisma] ${redact(event.message)}`));
  client.$on("error", (event) => console.error(`[prisma] ${redact(event.message)}`));

  return client;
}

export type Db = ReturnType<typeof createPrismaClient>;

// Reuse the instance across Bun's --watch reloads. Without this, every reload
// leaks a pool and you eventually exhaust the database's connection limit —
// which on serverless Postgres happens fast.
const globalForPrisma = globalThis as typeof globalThis & { __prisma?: Db };

export const db: Db = globalForPrisma.__prisma ?? createPrismaClient();

if (!isProduction) {
  globalForPrisma.__prisma = db;
}

/** Close the pool. Call this from your process shutdown handler. */
export async function disconnectDatabase(): Promise<void> {
  await db.$disconnect();
}
