// A lease for background jobs that must run on one instance at a time.
//
// A row in `projection_checkpoints` per job, not a Postgres advisory lock:
// session locks do not survive the transaction-mode pooler the app connects
// through. A lease expires on its own, so a crashed instance never wedges a job.
import { randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.ts";
import { db } from "../db/client.ts";

const holder = `${process.pid}-${randomUUID().slice(0, 8)}`;

/** Take the named lease for `ms`; true when this instance now holds it. */
export async function acquireJobLease(name: string, ms: number): Promise<boolean> {
  await db.$executeRaw`
    INSERT INTO projection_checkpoints (name, "updatedAt") VALUES (${name}, now()) ON CONFLICT (name) DO NOTHING`;
  const taken = await db.$executeRaw`
    UPDATE projection_checkpoints
    SET "leaseUntil" = now() + make_interval(secs => ${ms / 1000}), "leaseHolder" = ${holder}, "updatedAt" = now()
    WHERE name = ${name} AND ("leaseUntil" IS NULL OR "leaseUntil" < now() OR "leaseHolder" = ${holder})`;
  return taken > 0;
}

/** Give the lease back, recording when the job last completed if it did. */
export async function releaseJobLease(name: string, completedAt: Date | null): Promise<void> {
  await db.$executeRaw`
    UPDATE projection_checkpoints
    SET "leaseUntil" = NULL, "leaseHolder" = NULL, "updatedAt" = now()
        ${completedAt ? Prisma.sql`, watermark = ${completedAt}` : Prisma.empty}
    WHERE name = ${name} AND "leaseHolder" = ${holder}`;
}

/** When the job last completed, or null if it never has. */
export async function jobLastCompleted(name: string): Promise<Date | null> {
  const row = await db.projectionCheckpoint.findUnique({ where: { name }, select: { watermark: true } });
  return row?.watermark ?? null;
}

/**
 * A self-rescheduling loop: one tick at a time, so a slow tick delays the
 * next instead of overlapping it. `run` must not throw; it logs its own failures.
 */
export function jobLoop(run: () => Promise<void>, intervalMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = true;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = run().finally(() => {
        running = undefined;
        schedule();
      });
    }, intervalMs);
  };
  return {
    /** Start, running once straight away. False when disabled (interval 0) or already running. */
    start(): boolean {
      if (intervalMs === 0 || !stopped) return false;
      stopped = false;
      running = run().finally(() => {
        running = undefined;
        schedule();
      });
      return true;
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await running;
    },
  };
}

/** A non-negative integer interval from the environment, or the default. */
export function intervalFromEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallbackMs;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  return value;
}
