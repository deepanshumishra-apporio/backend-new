import { Prisma } from "../../generated/prisma/client.ts";
import { HttpError } from "../utils/http-error.ts";
import { istToday } from "../utils/money.ts";

/** Rechecked at creation and confirmation; mandate approval can change between them. */
export function assertSipMandate(mandate: {
  mandateStatus: string;
  providerName: string | null;
  mandateLimit: Prisma.Decimal;
  validFrom: Date | null;
  validTo: Date | null;
}, amount: string, now = new Date()): void {
  if (mandate.mandateStatus !== "APPROVED")
    throw HttpError.badRequest("The mandate must be approved before it can fund a SIP");
  if (mandate.providerName !== "CYBRILLAPOA")
    throw HttpError.badRequest("Choose a CYBRILLAPOA mandate for this SIP");
  const value = new Prisma.Decimal(amount);
  if (!value.isFinite() || value.lte(0) || value.decimalPlaces() > 2)
    throw HttpError.badRequest("Enter a positive SIP amount with at most two decimal places");
  if (mandate.mandateLimit.lt(value))
    throw HttpError.badRequest("SIP installment amount exceeds the mandate limit");
  const today = istToday(now);
  if ((mandate.validFrom && mandate.validFrom.toISOString().slice(0, 10) > today) ||
      (mandate.validTo && mandate.validTo.toISOString().slice(0, 10) < today))
    throw HttpError.conflict("Mandate is outside its validity period");
}

export function assertSipSchedule(frequency: string, day: number | undefined, count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > 1200)
    throw HttpError.badRequest("Enter between 1 and 1200 installments");
  if (frequency === "MONTHLY") {
    if (!Number.isInteger(day) || day! < 1 || day! > 28)
      throw HttpError.badRequest("Choose an installment day between 1 and 28");
  } else if (frequency === "DAILY" || frequency === "CALENDAR_DAY_DAILY") {
    if (day !== undefined) throw HttpError.badRequest("A daily SIP takes no installment day");
  } else throw HttpError.badRequest("ONDC SIP supports monthly and daily frequencies only");
}
