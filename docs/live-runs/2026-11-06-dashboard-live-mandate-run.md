# Live dashboard run through a Metal mandate · 2026-11-06

Engine: `npm run engine:live-mandate` (MODE: MIXED). LIVE: Metal payments as mandate pulls from the owner account 0x9819C6c7c14D03fF90e0069873d16CA4BF1386EB, the Metal mandate itself, providers' on-chain payment checks. SIMULATED: card holds (MockAirwallex), clearing (ClearingEmulator). LLM off.
Started from the dashboard's Run scripted demo button. The mandate test was pressed right after the rogue was first blocked. C declined its hold increase; B did not need one in this run.

**Locks:** policy check ✓ · Metal mandate LIVE ✓ — mandate 0x82e3abc09811e946d0bbc35d334b46df47685eb85b46b064a42aac4a48b18f97, 6 payees, cap $3.00, budget $1.50. Bind [0xa9a7150c…](https://testnet.metalntwx.com/tx/0xa9a7150cba3edfbd86ea0c59a87f5b5de0ad7f0435d2058e78d64b98722cbfe3) · revoke [0x395fd61f…](https://testnet.metalntwx.com/tx/0x395fd61fd8f4f6367d80f701270d7885145ddec1f5c340511fa43051490931b3).

**Reconciled:** true · violations: 0

| | Ledger paid | Settled on chain (re-read) | Clearing [SIM] | Captured [SIM] |
|---|---|---|---|---|
| Job A | $0.48 | $0.48 | $0.48 | $0.48 |
| Job B | $0.60 | $0.60 | $0.60 | $0.60 |
| Job C | $0.39 | $0.39 | $0.39 | $0.39 |
| **Total** | $1.47 | $1.47 | $1.47 | $1.47 |

## Receipts

### Job A · Acme Research · budget_limited

- search · search · list $0.02 · paid $0.02 · [tx](https://testnet.metalntwx.com/tx/0xcc035689b7a2ea9b049d3fda39ef01f6570b90e9a0623c37e67da1c294f802ac) · search is the cheapest tier-2 option that fits
- lookup · data · list $0.03 · paid $0.03 · [tx](https://testnet.metalntwx.com/tx/0xa538627094886b09b050c9732aeba6ef90f810ed6f38766924a56612c2e199a1) · data is the cheapest tier-2 option that fits
- outline · model-std · list $0.24 · paid $0.24 · [tx](https://testnet.metalntwx.com/tx/0x34ea812e8e1034dbaff815d7668eec27983bc1361091d2731cf36b00f1af2cd6) · model-std is the cheapest tier-2 option that fits
- body · model-lite · list $0.15 · paid $0.15 · [tx](https://testnet.metalntwx.com/tx/0x441dc345315ab04e9715e2146e21e53f06a799371675e3a7af4e2dbac405d15e) · model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)
- summary · model-lite · list $0.04 · paid $0.04 · [tx](https://testnet.metalntwx.com/tx/0x963a15795282417e31a652fc220413175b5a21f52e6deecc89968ad2a71a52d8) · model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)

### Job B · Birch Capital · budget_limited

- search · search · list $0.02 · paid $0.02 · [tx](https://testnet.metalntwx.com/tx/0xc8c0a88094341f2ed8c65001d4abd068758287a651b155063a71d8f82993b6b3) · search is the cheapest tier-2 option that fits
- draft · model-lite · list $0.10 · paid $0.10 · [tx](https://testnet.metalntwx.com/tx/0xd398a3103ea62a32b46ca78d05c5e96a6ebe887c0bc909d2c3ae9075f0c4671c) · model-lite is the cheapest tier-1 option that fits
- analysis · model-bargain · list $0.48 · refused (asked $0.48) · rail refused: Metal mandate refused: mandate_payee_not_listed (the payee is not one the mandate allows); refusal recorded on chain 0x81e8bd6eefeedfa866588532e926481a3244de87a3d7ee089953c637efcb2803
- analysis · model-lite · list $0.48 · paid $0.48 · [tx](https://testnet.metalntwx.com/tx/0x3fde2ae47abf2eff3b521dedaef8d0177ae7cd028a6e43ca8828c9be7d751dc3) · model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)

### Job C · Cobalt Labs · budget_limited

- search · search · list $0.02 · paid $0.02 · [tx](https://testnet.metalntwx.com/tx/0xa2e3e1623b5e1b52c3b008df6f093f1ecbcf5cd396b0d1c38cc6467471ba99d4) · search is the cheapest tier-2 option that fits
- scan · model-bargain · list $0.14 · refused (asked $0.42) · quoted $0.42, list price $0.14 (420000 vs 140000 micros)
- scan · model-std · list $0.28 · paid $0.28 · [tx](https://testnet.metalntwx.com/tx/0x4083180f35dae987394ea9e78c1785c1253c7cd05528cca6e47b8b1821e4259d) · model-std is the cheapest tier-2 option that fits; skipped slow: model-lite
- compare · model-std · list $0.06 · paid $0.06 · [tx](https://testnet.metalntwx.com/tx/0xe405df1f520cf474d0114407afad01e0864c78094698c556a7bbe8e34a7322ee) · model-std is the cheapest tier-2 option that fits; skipped slow: model-lite
- brief · model-lite · list $0.03 · paid $0.03 · [tx](https://testnet.metalntwx.com/tx/0xbb8f8280a3e7152f7841113802fa8e64050fe424d937a4c5df9edd70774884b4) · model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)

## Feed

- [*] 🔒 Metal mandate bound: 6 registered payees, $3.00 per payment, $1.50 budget
- [*] deposit $1.50 USDZ float, $0.30 kept as shared reserve
- [A] card hold authorized $1.00
- [A] [SIMULATED] clearing deposit $1.00
- [B] card hold authorized $0.75
- [B] [SIMULATED] clearing deposit $0.75
- [C] card hold authorized $0.75
- [C] [SIMULATED] clearing deposit $0.75
- [C] search: buy from search for $0.02 — search is the cheapest tier-2 option that fits
- [A] search: buy from search for $0.02 — search is the cheapest tier-2 option that fits
- [B] search: buy from search for $0.02 — search is the cheapest tier-2 option that fits
- [B] ⚠ step analysis grew to 48 paragraphs (prompt overrun)
- [*] ⚠ model-lite slows to ~2.5s under load
- [A] lookup: buy from data for $0.03 — data is the cheapest tier-2 option that fits
- [B] draft: buy from model-lite for $0.10 — model-lite is the cheapest tier-1 option that fits
- [C] scan: buy from model-bargain for $0.14 — model-bargain is the cheapest tier-2 option that fits; skipped slow: model-lite
- [C] ✋ refused model-bargain: quoted $0.42, list price $0.14 (420000 vs 140000 micros)
- [C] ⛔ model-bargain blocked (quoted $0.42, list price $0.14 (420000 vs 140000 micros))
- [C] scan: buy from model-std for $0.28 — model-std is the cheapest tier-2 option that fits; skipped slow: model-lite
- [*] ⚠ deliberate test: our quote check is OFF; model-bargain will ask to be paid at an unregistered address
- [C] ⚠ step compare grew to 30 paragraphs (prompt overrun)
- [B] reserve +$0.24 (covers its next step; closest to finishing); $0.06 left
- [B] analysis: buy from model-bargain for $0.48 — model-bargain is the cheapest tier-2 option that fits
- [B] ⚠ quote check skipped for model-bargain (test): our check would have refused: asked to pay 0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead, registered 0x11111111111111111111111111111111111111d1
- [*] 🔒 Metal mandate refused $0.48 to 0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead: Metal mandate refused: mandate_payee_not_listed (the payee is not one the mandate allows); refusal recorded on chain 0x81e8bd6eefeedfa866588532e926481a3244de87a3d7ee089953c637efcb2803
- [*] ✓ our quote check is back on
- [B] ✋ refused model-bargain: rail refused: Metal mandate refused: mandate_payee_not_listed (the payee is not one the mandate allows); refusal recorded on chain 0x81e8bd6eefeedfa866588532e926481a3244de87a3d7ee089953c637efcb2803
- [B] ⛔ model-bargain blocked (rail refused: Metal mandate refused: mandate_payee_not_listed (the payee is not one the mandate allows); refusal recorded on chain 0x81e8bd6eefeedfa866588532e926481a3244de87a3d7ee089953c637efcb2803)
- [B] budget-limited plan (step analysis no longer fits the hold): 2 steps kept, 1 dropped, plan now costs $0.56 of $0.63 left; dropped lookup
- [A] outline: buy from model-std for $0.24 — model-std is the cheapest tier-2 option that fits
- [*] [SIMULATED] clearing epoch 1 closed: 7 running totals redeemed
- [C] ask customer: raise hold $0.75 → $1.04
- [C] customer declined
- [C] budget-limited plan (customer declined): 2 steps kept, 1 dropped, plan now costs $0.36 of $0.45 left; dropped lookup
- [B] analysis: buy from model-lite for $0.48 — model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)
- [A] body: buy from model-lite for $0.15 — model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)
- [A] budget-limited plan (float exhausted): 1 steps kept, 0 dropped, plan now costs $0.04 of $0.04 left
- [B] budget-limited plan (float exhausted): 0 steps kept, 1 dropped, plan now costs $0.00 of $0.00 left; dropped wrapup
- [B] finished (budget-limited)
- [C] budget-limited plan (float exhausted): 2 steps kept, 0 dropped, plan now costs $0.06 of $0.06 left
- [C] compare: buy from model-std for $0.06 — model-std is the cheapest tier-2 option that fits; skipped slow: model-lite
- [A] summary: buy from model-lite for $0.04 — model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)
- [A] finished (budget-limited)
- [*] [SIMULATED] clearing epoch 2 closed: 3 running totals redeemed
- [C] reserve +$0.03 (covers the rest of the job; closest to finishing); $0.03 left
- [C] brief: buy from model-lite for $0.03 — model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)
- [C] finished (budget-limited)
- [*] [SIMULATED] clearing epoch 3 closed: 1 running totals redeemed
- [A] [SIMULATED] clearing final: redeemed $0.48, unused deposit $0.52 withdrawn
- [B] [SIMULATED] clearing final: redeemed $0.60, unused deposit $0.15 withdrawn
- [C] [SIMULATED] clearing final: redeemed $0.39, unused deposit $0.36 withdrawn
- [A] captured $0.48, released $0.52
- [B] captured $0.60, released $0.15
- [C] captured $0.39, released $0.36
- [*] withdrew unused float $0.03 USDZ
- [*] 🔒 mandate revoked: nothing more can be paid under it
