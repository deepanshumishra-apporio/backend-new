// Backfill real NAV history from AMFI: `bun run nav:import [days]` (default 400).
// Replaces any seeded points in the imported window. Safe to re-run.
import { importNavHistory } from "../src/services/nav-import.service.ts";

const days = Number(process.argv[2] ?? 400);
if (!Number.isInteger(days) || days < 1 || days > 2000) {
  console.error("Usage: bun run nav:import [days 1-2000]");
  process.exit(1);
}
const result = await importNavHistory(days);
console.log(`Imported ${result.points} NAVs for ${result.matched}/${result.schemes} schemes (AMFI fund houses ${result.fundHouses.join(", ") || "none"}).`);
process.exit(0);
