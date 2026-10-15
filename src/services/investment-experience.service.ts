// The investor's self-declared investing experience, from the profile screen.
//
// Ours alone: FP's KYC form and investor profile carry no such field, so it is
// never sent upstream. Each change is audit-logged with the old and new value,
// because a suitability answer that changes silently cannot be relied on.
import { db } from "../db/client.ts";
import type { InvestmentExperienceDto, InvestmentExperienceValue } from "../types/investor.types.ts";

const select = { investmentExperience: true, investmentExperienceUpdatedAt: true } as const;

const toDto = (row: { investmentExperience: InvestmentExperienceValue | null; investmentExperienceUpdatedAt: Date | null }): InvestmentExperienceDto => ({
  value: row.investmentExperience,
  updatedAt: row.investmentExperienceUpdatedAt?.toISOString() ?? null,
});

export async function getInvestmentExperience(userId: string): Promise<InvestmentExperienceDto> {
  return toDto(await db.user.findUniqueOrThrow({ where: { id: userId }, select }));
}

export async function setInvestmentExperience(
  userId: string,
  value: InvestmentExperienceValue,
): Promise<InvestmentExperienceDto> {
  return db.$transaction(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({ where: { id: userId }, select });
    if (before.investmentExperience === value) return toDto(before);
    const after = await tx.user.update({
      where: { id: userId },
      data: { investmentExperience: value, investmentExperienceUpdatedAt: new Date() },
      select,
    });
    await tx.auditLog.create({
      data: {
        actorId: userId,
        actorRole: "INVESTOR",
        action: "INVESTMENT_EXPERIENCE_UPDATED",
        entityType: "user",
        entityId: userId,
        metadata: { from: before.investmentExperience, to: value },
      },
      select: { id: true },
    });
    return toDto(after);
  });
}
