// Prisma CLI configuration (Prisma 7).
//
// Connection URLs live here, not in schema.prisma — the datasource `url`,
// `directUrl` and `shadowDatabaseUrl` fields are deprecated in v7.
//
// No `dotenv/config` import: every Prisma command in package.json runs through
// `bunx --bun`, and Bun loads .env itself. Under plain Node you would need to
// add `import "dotenv/config"` as the first line here.
import { defineConfig, env } from "prisma/config";

// This file configures the CLI only — migrate, studio and seed. The
// application reads DATABASE_URL directly (see src/db/client.ts).
//
// So when a direct, non-pooled URL is available, the CLI should use it:
// migrations issue DDL and take advisory locks, neither of which survives
// PgBouncer transaction-mode pooling. The app keeps using the pooled URL.
//
// Note `env()` THROWS on an unset variable rather than returning undefined, so
// the name is chosen before being passed in.
const cliDatabaseUrl = process.env.DIRECT_DATABASE_URL
  ? "DIRECT_DATABASE_URL"
  : "DATABASE_URL";

export default defineConfig({
  schema: "prisma/schema.prisma",

  migrations: {
    path: "prisma/migrations",
    seed: "bun run prisma/seed.ts",
  },

  datasource: {
    url: env(cliDatabaseUrl),
  },
});
