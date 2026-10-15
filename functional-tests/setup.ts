// Functional test harness — preloaded once for the whole run.
//
//   bun run test:functional
//
// Boots the real Express app against a throwaway in-memory Postgres (PGlite,
// served over the wire protocol by pglite-socket), with every migration in
// prisma/migrations applied and the committed scheme catalogue seeded. Nothing
// here touches the shared Neon databases. Calls that reach Fintech Primitives
// go to the FP *sandbox* configured in .env — this harness refuses any other host.
//
// Every test talks to the app over HTTP, exactly as the mobile app and the admin
// portal do. No module is mocked.
import { afterAll } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const ROOT = new URL("../", import.meta.url);

// --- environment ------------------------------------------------------------

if (process.env.FP_BASE_URL !== "https://s.finprim.com") {
  throw new Error(`Functional tests only run against the FP sandbox (FP_BASE_URL is "${process.env.FP_BASE_URL}")`);
}

export const DEV_OTP = "246810";
Object.assign(process.env, {
  NODE_ENV: "test",
  // A fixed code: the challenge, cooldowns, attempt caps and lockout all still
  // run — only the delivery is skipped. Refused at boot under production.
  OTP_DEV_CODE: DEV_OTP,
  OTP_LENGTH: "6",
  OTP_EMAIL_FALLBACK: "false",
  // Each test client sends its own X-Forwarded-For so the per-IP rate limiter
  // can be exercised deliberately without the rest of the run tripping it.
  TRUST_PROXY: "loopback",
  STAFF_MFA_ENABLED: "true",
  // Keys the bank-account fingerprint HMAC. A fixed test value is fine: the
  // run is throwaway and nothing outside it reads the fingerprints.
  BANK_FINGERPRINT_KEY: "+TYdvGBOILRFJshqqHDD7LhXtZtZfNYHMgfYDb7423w=",
  SANDBOX_AUTH_ENABLED: "true",
  CALLBACK_ALLOWED_ORIGINS: "https://app.example.test",
  // PGlite is one session: pglite-socket serves one client connection at a time.
  DATABASE_POOL_MAX: "1",
});

// --- database ---------------------------------------------------------------

const pg = new PGlite();
const migrationsDir = new URL("prisma/migrations/", ROOT);
const migrations = (await readdir(migrationsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
for (const name of migrations) {
  await pg.exec(await readFile(new URL(`${name}/migration.sql`, migrationsDir), "utf8"));
}

/**
 * A port the OS has just handed out. A guessed one can fall inside a range
 * Windows reserves (Hyper-V / WinNAT), and pglite-socket's start() then never
 * settles instead of rejecting — the whole run hangs.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function startSocket(): Promise<{ server: PGLiteSocketServer; port: number }> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const port = await freePort();
    const server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1" });
    const started = await Promise.race([
      server.start().then(() => true),
      Bun.sleep(10_000).then(() => false),
    ]);
    if (started) return { server, port };
    await server.stop().catch(() => undefined);
  }
  throw new Error("Could not start the PGlite socket server after 3 attempts");
}

const { server: socketServer, port: dbPort } = await startSocket();
console.log(`[functional] ${migrations.length} migrations applied; PGlite listening on :${dbPort}`);
const url = `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`;
process.env.DATABASE_URL = url;
process.env.DIRECT_DATABASE_URL = url;

// The committed FP sandbox catalogue, through the project's own seed script.
const seed = Bun.spawn([process.execPath, "run", "prisma/seed.ts"], {
  cwd: fileURLToPath(ROOT),
  env: process.env,
  stdout: "pipe",
  stderr: "pipe",
});
const seedTimeout = setTimeout(() => seed.kill(), 90_000);
const seedExit = await seed.exited;
clearTimeout(seedTimeout);
if (seedExit !== 0) {
  throw new Error(`Seeding the test database failed (exit ${seedExit}, killed after 90s if hung):\n${await new Response(seed.stderr).text()}`);
}
console.log("[functional] database seeded");

// --- app --------------------------------------------------------------------

const { createApp } = await import("../src/app.ts");
const { disconnectDatabase } = await import("../src/db/client.ts");

const server: Server = await new Promise((resolve) => {
  const s = createApp().listen(0, "127.0.0.1", () => resolve(s));
});
const { port } = server.address() as AddressInfo;
(globalThis as { __FT_BASE__?: string }).__FT_BASE__ = `http://127.0.0.1:${port}`;
console.log(`[functional] app listening on :${port}`);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectDatabase();
  await socketServer.stop();
  await pg.close();
});
