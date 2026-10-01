// Server entry point.
//
// Run with: bun run dev
import { createApp } from "./src/app.ts";
import { disconnectDatabase } from "./src/db/client.ts";
import { closeEmailTransport } from "./src/integrations/email.client.ts";
import { startBackgroundJobs, stopBackgroundJobs } from "./src/services/background-jobs.service.ts";
import { startAdminProjection, stopAdminProjection } from "./src/services/admin-projection.service.ts";
import { startComplianceScan, stopComplianceScan } from "./src/services/compliance-alert.service.ts";
import { startAnnouncementDispatch, stopAnnouncementDispatch } from "./src/services/announcement.service.ts";

const port = Number(process.env["PORT"] ?? 3000);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`PORT must be a positive integer (got "${process.env["PORT"]}")`);
}

const server = createApp().listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
  // Reconcile paid orders (so their folio is saved even when nobody is looking)
  // and apply pending FP webhooks.
  if (startBackgroundJobs()) console.log("[jobs] order reconciliation and webhook processing started");
  // The admin portal's read model, on its own loop so it can never delay the money sweeps.
  if (startAdminProjection()) console.log("[admin-projection] started");
  // Compliance alerts: reads the mirror only, so it never competes with FP calls.
  if (startComplianceScan()) console.log("[compliance] scan started");
  if (startAnnouncementDispatch()) console.log("[announcements] delivery started");
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
  // Before the pool closes: a tick in progress still needs the database.
  await stopBackgroundJobs();
  await stopAdminProjection();
  await stopComplianceScan();
  await stopAnnouncementDispatch();
  await closeEmailTransport();
  await disconnectDatabase();
  clearTimeout(forceExit);
  console.log("[server] stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
