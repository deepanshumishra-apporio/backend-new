import { fpCatalogue, fpConfig, getAccessToken } from '../src/integrations/fp/index.ts';

// Diagnostic only: no DB writes, OTP messages, investor creation or orders.
if (new URL(fpConfig().baseUrl).hostname !== 's.finprim.com') throw new Error('This diagnostic is restricted to the sandbox');
const isins = ['INF109K01423', 'INF109KC1TY0', 'INF109KC1TV6', 'INF109KC1TU8', 'INF109K01605', 'INF109KC11U2', 'INF109KC19T7'];
let failed = false;
for (const realm of ['tenant', 'preverify'] as const) {
  try { await getAccessToken(realm); console.log(`${realm} authentication: PASS`); }
  catch { console.log(`${realm} authentication: FAIL (check credentials/provisioning/network)`); failed = true; }
}
for (const isin of isins) {
  try { const scheme = await fpCatalogue.fetchFundScheme(isin); console.log(`${isin}: ${scheme.isin === isin ? 'PASS' : 'FAIL unexpected identifier'}`); }
  catch { console.log(`${isin}: FAIL (check catalogue access/network)`); failed = true; }
}
process.exitCode = failed ? 1 : 0;
