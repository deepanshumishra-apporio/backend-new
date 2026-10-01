// Body parsing shared by the staff and investor support endpoints. Pure.
import { RELATED_TYPES, type TicketRelatedType } from "../types/support.types.ts";
import { HttpError } from "./http-error.ts";
import { isUuid } from "./query.ts";
import { asBody, oneOf, requiredString } from "./validate.ts";

/** `{ type, id }` naming the order, plan or payment a ticket is about. Ownership is the service's to check. */
export function parseRelated(body: Record<string, unknown>): { type: TicketRelatedType; id: string } | undefined {
  const raw = body["related"];
  if (raw === undefined || raw === null) return undefined;
  const related = asBody(raw);
  const type = oneOf(related, "type", RELATED_TYPES) as TicketRelatedType;
  const id = requiredString(related, "id");
  if (!isUuid(id)) throw HttpError.badRequest("related.id must be a uuid");
  return { type, id };
}
