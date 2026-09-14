// Server entry point.
//
// Run with: bun run dev
import { createApp } from "./src/app.ts";
import { disconnectDatabase } from "./src/db/client.ts";

const port = Number(process.env["PORT"] ?? 3000);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`PORT must be a positive integer (got "${process.env["PORT"]}")`);
}

const server = createApp().listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
});

/**
 * Shut down in the right order: stop accepting connections, let the in-flight
 * ones finish, then close the database pool. Closing the pool first would fail
 * the requests that are still running.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);

  // Do not wait for ever on a hung connection — a stuck request must not block
  // a deploy.
  const forceExit = setTimeout(() => {
    console.error("[server] forced exit after shutdown timeout");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectDatabase();
  clearTimeout(forceExit);
  console.log("[server] stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
