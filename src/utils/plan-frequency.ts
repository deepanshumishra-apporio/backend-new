// How many instalments of each plan frequency fall in an average month, so
// plans of different frequencies can be added up as one monthly figure. Pure.
//
// One table, read three ways: by TypeScript (Prisma enum names), and by SQL
// through `monthlyFactorSql` (FP's wire values, which is what the columns hold).
import { Prisma } from "../../generated/prisma/client.ts";

export const MONTHLY_FACTOR = {
  DAILY: { wire: "daily", perMonth: 21 }, // business days
  CALENDAR_DAY_DAILY: { wire: "calendar_day_daily", perMonth: 30 },
  DAY_IN_A_WEEK: { wire: "day_in_a_week", perMonth: 52 / 12 },
  FOUR_TIMES_A_MONTH: { wire: "four_times_a_month", perMonth: 4 },
  DAY_IN_A_FORTNIGHT: { wire: "day_in_a_fortnight", perMonth: 26 / 12 },
  TWICE_A_MONTH: { wire: "twice_a_month", perMonth: 2 },
  MONTHLY: { wire: "monthly", perMonth: 1 },
  QUARTERLY: { wire: "quarterly", perMonth: 1 / 3 },
  HALF_YEARLY: { wire: "half_yearly", perMonth: 1 / 6 },
  YEARLY: { wire: "yearly", perMonth: 1 / 12 },
} as const;

export function instalmentsPerMonth(frequency: string): number {
  return (MONTHLY_FACTOR as Record<string, { perMonth: number }>)[frequency]?.perMonth ?? 0;
}

/** `CASE <column> WHEN 'monthly' THEN 1 … END` over a plan_frequency column. */
export function monthlyFactorSql(column: Prisma.Sql): Prisma.Sql {
  const arms = Object.values(MONTHLY_FACTOR).map(
    ({ wire, perMonth }) => Prisma.sql`WHEN ${wire} THEN ${perMonth}::numeric`,
  );
  return Prisma.sql`(CASE ${column}::text ${Prisma.join(arms, " ")} ELSE 0 END)`;
}
