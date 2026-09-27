// Refresh the market holiday calendar from NSE: `bun run holidays:import`.
// Falls back to the committed snapshot when NSE cannot be reached.
import { importHolidaysFromNse, saveHolidays } from "../src/services/market.service.ts";

try {
  console.log(`Imported ${await importHolidaysFromNse()} holidays from NSE.`);
} catch (error) {
  console.warn(`NSE unavailable (${error instanceof Error ? error.message : error}); loading the snapshot.`);
  const snapshot = JSON.parse(
    await Bun.file(new URL("../prisma/seed-data/market-holidays.json", import.meta.url)).text(),
  ) as { holidays: { date: string; name: string }[] };
  console.log(`Loaded ${await saveHolidays(snapshot.holidays)} holidays from the snapshot.`);
}
process.exit(0);
