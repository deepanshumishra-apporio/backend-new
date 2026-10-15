-- Mask full bank account numbers already stored, to the last four digits.
--
-- FP holds the full numbers; this database only ever needs to show the last
-- four (see src/utils/mask.ts). New rows are masked at write time by the FP
-- sync. IRREVERSIBLE by design: run only after confirming nothing outside
-- this codebase reads these columns.
UPDATE "pre_verification_bank_results"
SET "accountNumber" = 'XXXXXX' || RIGHT("accountNumber", 4)
WHERE LENGTH("accountNumber") > 4 AND "accountNumber" NOT LIKE 'X%';

UPDATE "mf_redemptions"
SET "redemptionBankAccountNumber" = 'XXXXXX' || RIGHT("redemptionBankAccountNumber", 4)
WHERE "redemptionBankAccountNumber" IS NOT NULL
  AND LENGTH("redemptionBankAccountNumber") > 4
  AND "redemptionBankAccountNumber" NOT LIKE 'X%';

UPDATE "mf_settlement_details"
SET "bankAccountNumber" = 'XXXXXX' || RIGHT("bankAccountNumber", 4)
WHERE "bankAccountNumber" IS NOT NULL
  AND LENGTH("bankAccountNumber") > 4
  AND "bankAccountNumber" NOT LIKE 'X%';
