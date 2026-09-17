import { Prisma } from "../../generated/prisma/client.ts";

// Decimal.toJSON() drops trailing zeros ("100.00" -> "100"), so always format
// explicitly. Strings, not numbers: JSON numbers are doubles and lose precision.
const fixed = (v: Prisma.Decimal | null | undefined, dp: number) =>
  v === null || v === undefined ? null : new Prisma.Decimal(v).toFixed(dp);

export const asAmount = (v: Prisma.Decimal | null | undefined) => fixed(v, 2);
export const asNav = (v: Prisma.Decimal | null | undefined) => fixed(v, 4);
/** Fund units. FP allots to 3dp; we carry 4 and render what we stored. */
export const asUnits = (v: Prisma.Decimal | null | undefined) => fixed(v, 4);
/** A percentage stored as percent, so 1.2500 means 1.25%. */
export const asPercent = (v: Prisma.Decimal | null | undefined) => fixed(v, 4);
/** Nominee allocation, 0.00-100.00. */
export const asAllocation = (v: Prisma.Decimal | null | undefined) => fixed(v, 2);

/** yyyy-mm-dd, the format every FP date field uses. */
export const asDate = (v: Date | null | undefined) =>
  v === null || v === undefined ? null : v.toISOString().slice(0, 10);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Today, on the calendar FP is keeping.
 *
 * Every date FP sends is an IST calendar date stored at UTC midnight, so a
 * "today" taken from `toISOString()` is a day behind for the five and a half
 * hours after IST midnight. Comparing the two made a mandate issued this
 * morning look like it started tomorrow, and every SIP on it was refused with
 * "Mandate is outside its validity period" until the sun came up.
 */
export const istToday = (now: Date = new Date()) =>
  new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
