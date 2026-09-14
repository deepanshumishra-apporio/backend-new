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
