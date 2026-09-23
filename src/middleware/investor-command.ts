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
  // `/provision` joins `/refresh` and `/transaction-otp` in being exempt.
  //
  // It is idempotent by construction — every stage re-reads what already exists
  // before creating anything — so there is no unknown write here to protect,
  // and the app calls it after every answer in the journey. Recording its
  // response was actively harmful: the client keeps one key per logical step
  // for the life of the install, so the first answer was replayed for ever.
  // "Skip nomination" was the casualty — it returned 200 without recording
  // anything, and every later press replayed that 200 instead of reaching the
  // code that now writes the declaration.
  if (
    !["POST", "PATCH", "PUT", "DELETE"].includes(req.method) ||
    req.path.endsWith("/refresh") ||
    // A pure transform with no persistent side effect: it encrypts a PDF the
    // client already rendered and returns it. Recording the response would
    // persist the whole statement (base64) as a command row per download —
    // unbounded growth of large rows holding the investor's financial data —
    // for no idempotency benefit, since there is no write to protect.
    req.path.endsWith("/statements/lock") ||
    req.path === "/investors/provision" ||
    req.path.startsWith("/transaction-otp")
  ) return next();
  const key = req.get("Idempotency-Key");
  if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw HttpError.badRequest("Idempotency-Key must contain 16-128 letters, digits, underscores or hyphens");
  const userId = investorId(req);
  const route = `${req.method} ${req.path}`;
  const requestHash = createHash("sha256").update(canonicalJson({ route, body: req.body ?? {}, query: req.query })).digest("hex");
  const id = crypto.randomUUID();
  let claim = await db.investorCommand.createMany({ data: [{ id, userId, key, requestHash, route }], skipDuplicates: true });
  if (!claim.count) {
    const previous = await db.investorCommand.findUniqueOrThrow({ where: { userId_key: { userId, key } } });
    if (previous.requestHash !== requestHash) throw HttpError.conflict("Idempotency-Key was already used for a different request");
    if (previous.statusCode === null) throw HttpError.conflict("Request is in progress or requires reconciliation; do not submit a new key", { commandId: previous.id });
    if (previous.statusCode >= 400) {
      // A stored failure is not an outcome worth protecting — see the note on
      // 4xx below. Rows written before that rule existed are still out there,
      // and because the client keeps one key per logical step for the life of
      // the install, replaying them made the failure permanent: "skip
      // nomination" answered the same rejection for ever, however many times
      // it was pressed. Clear it and let this attempt run.
      await db.investorCommand.delete({ where: { id: previous.id } }).catch(() => undefined);
      claim = await db.investorCommand.createMany({ data: [{ id, userId, key, requestHash, route }], skipDuplicates: true });
      // Someone else re-claimed it in between; theirs is in flight, not ours.
      if (!claim.count) throw HttpError.conflict("Request is in progress; retry in a moment");
    } else {
      res.setHeader("Idempotency-Replayed", "true");
      res.status(previous.statusCode).json(previous.response);
      return;
    }
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
    // A 4xx is a *known* failure: the write did not happen, so the invariant
    // this middleware exists for — never retry an unknown write — does not
    // apply. Recording it made the key permanently poisoned, and the client
    // reuses one key per logical step, so the same error replayed for ever.
    //
    // `/investors/provision` is the one that hurt: it is idempotent by design
    // and called after every answer, so one rejected call left the nomination
    // unrecordable and the resume route showed the nominee screen again on
    // every pass. Releasing the claim lets the same key be tried again; an
    // unknown outcome (5xx, or no response at all) still keeps it and still
    // demands reconciliation.
    if (statusCode >= 400) {
      void db.investorCommand.delete({ where: { id } }).then(
        () => send(body),
        () => send(body),
      );
      return res;
    }
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
