import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { db } from "../db/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { investorId } from "./investor-auth.ts";
import type { Prisma } from "../../generated/prisma/client.ts";

export function canonicalJson(value: unknown): string {
  if (Buffer.isBuffer(value)) return JSON.stringify(value.toString("base64"));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Persist the command before any upstream side effect. Never retry an unknown write. */
export const investorCommand: RequestHandler = async (req, res, next) => {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(req.method) || req.path.endsWith("/refresh") || req.path.startsWith("/transaction-otp")) return next();
  const key = req.get("Idempotency-Key");
  if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw HttpError.badRequest("Idempotency-Key must contain 16-128 letters, digits, underscores or hyphens");
  const userId = investorId(req);
  const route = `${req.method} ${req.path}`;
  const requestHash = createHash("sha256").update(canonicalJson({ route, body: req.body ?? {}, query: req.query })).digest("hex");
  const id = crypto.randomUUID();
  const claim = await db.investorCommand.createMany({ data: [{ id, userId, key, requestHash, route }], skipDuplicates: true });
  if (!claim.count) {
    const previous = await db.investorCommand.findUniqueOrThrow({ where: { userId_key: { userId, key } } });
    if (previous.requestHash !== requestHash) throw HttpError.conflict("Idempotency-Key was already used for a different request");
    if (previous.statusCode === null) throw HttpError.conflict("Request is in progress or requires reconciliation; do not submit a new key", { commandId: previous.id });
    res.setHeader("Idempotency-Replayed", "true");
    res.status(previous.statusCode).json(previous.response);
    return;
  }
  // Stable provider reference for order/plan creates, including after response loss.
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !req.body.sourceRefId) req.body.sourceRefId = id;
  res.locals["commandId"] = id;
  const send = res.json.bind(res);
  let sending = false;
  res.json = ((body: unknown) => {
    if (sending) return res;
    sending = true;
    const statusCode = res.statusCode;
    if (statusCode >= 500) { send(body); return res; }
    void db.investorCommand.update({ where: { id }, data: {
      statusCode, response: JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue, completedAt: new Date(),
    } }).then(() => send(body), () => {
      res.status(503);
      send({ error: { code: "RECONCILIATION_REQUIRED", message: "Request outcome could not be saved; retry with the same key", commandId: id } });
    });
    return res;
  }) as typeof res.json;
  next();
};
