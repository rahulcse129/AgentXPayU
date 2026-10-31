# Live dashboard run on Metal testnet · 2026-11-01

Engine: `npm run engine:live` (MODE: MIXED). LIVE: Metal x402 payments, providers' on-chain payment checks. SIMULATED: card holds (MockAirwallex), clearing (ClearingEmulator). LLM off.
Driven from the dashboard's "Run scripted demo" button. B's hold increase approved; C's request timed out (counts as a decline).

Payer 0xbf3C4a9e8E907Ae6e2c6Ac80A3b51B94D740f696 on Metal testnet (eip155:63825). Reconciled: **true**, violations: 0.

| | Ledger paid | Settled on chain (re-read) | Clearing [SIM] | Captured [SIM] |
|---|---|---|---|---|
| Job A | $0.64 | $0.64 | $0.64 | $0.64 |
| Job B | $0.36 | $0.36 | $0.36 | $0.36 |
| Job C | $0.39 | $0.39 | $0.39 | $0.39 |
| **Total** | $1.39 | $1.39 | $1.39 | $1.39 |

## Receipts

### Job A · Acme Research · budget_limited

- search · search · list $0.02 · paid $0.02 · [tx](https://testnet.metalntwx.com/tx/0x6ac9cfe60e72853484af18e015a61481e0a5b0069df2c8c40038ad28a169b72f) · search is the cheapest tier-2 option that fits
- lookup · data · list $0.03 · paid $0.03 · [tx](https://testnet.metalntwx.com/tx/0x0b7da7baf1f3094d1aeaa1287980d26c6fe8dd402757af9f7e3f8dacc318fb2a) · data is the cheapest tier-2 option that fits
- outline · model-std · list $0.24 · paid $0.24 · [tx](https://testnet.metalntwx.com/tx/0x2eccfc160f9ebaff96bd0ff1ff80c0a9da714d47b61c20b3857e9997c68aa9f3) · model-std is the cheapest tier-2 option that fits
- body · model-std · list $0.30 · paid $0.30 · [tx](https://testnet.metalntwx.com/tx/0x338c26ed8f473545b319ab7e4d2fa15c953a91973a95b5a27f415e3fa9e9e5f4) · model-std is the cheapest tier-2 option that fits; skipped slow: model-lite
- summary · model-lite · list $0.05 · paid $0.05 · [tx](https://testnet.metalntwx.com/tx/0x5c5a934a94d721e185fd9804f13cc412068d1e6c5e5354dac51a6b6005c9b40f) · model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)

### Job B · Birch Capital · budget_limited

- search · search · list $0.02 · paid $0.02 · [tx](https://testnet.metalntwx.com/tx/0x5f1113377fd12c2689404dd61cdba4a6972ffcd929aea34c37dca1318643d865) · search is the cheapest tier-2 option that fits
- draft · model-lite · list $0.10 · paid $0.10 · [tx](https://testnet.metalntwx.com/tx/0xf5ae4157d0754af50a6f0ebc01c72a0a9d40ff7508371efcbe47f68c15d6fc48) · model-lite is the cheapest tier-1 option that fits
- analysis · model-lite · list $0.16 · paid $0.16 · [tx](https://testnet.metalntwx.com/tx/0xf80c72c738677e85faca56781f26079763611e2161e78ee68bc82e9c6791d051) · model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)
- wrapup · model-lite · list $0.08 · paid $0.08 · [tx](https://testnet.metalntwx.com/tx/0xbb71b776b8b3dff679435f02b31a83912ecfe3ab260c7b61d2719d81ea896e0c) · model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)

### Job C · Cobalt Labs · budget_limited

- search · search · list $0.02 · paid $0.02 · [tx](https://testnet.metalntwx.com/tx/0x101237f1d4691a353614654de71e1b92254bae72d449038c614376102f75e563) · search is the cheapest tier-2 option that fits
- scan · model-bargain · list $0.14 · refused (asked $0.42) · quoted $0.42, list price $0.14 (420000 vs 140000 micros)
- scan · model-std · list $0.28 · paid $0.28 · [tx](https://testnet.metalntwx.com/tx/0xc494e22c1deb4ba83f1e45f8fa21976a8fb09e0f007ea75652b8c36d057dbe44) · model-std is the cheapest tier-2 option that fits; skipped slow: model-lite
- compare · model-std · list $0.06 · paid $0.06 · [tx](https://testnet.metalntwx.com/tx/0x5853d60c4e7e2ce8e82ea729a62ae939242b5f4f751bdf008501690d604e4e91) · model-std is the cheapest tier-2 option that fits; skipped slow: model-lite
- brief · model-lite · list $0.03 · paid $0.03 · [tx](https://testnet.metalntwx.com/tx/0x747232d74b63538fb8587cc2b45cf03a608014d695c9819a1024226b54c143a0) · model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)

## Feed

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
- [C] ⚠ step compare grew to 30 paragraphs (prompt overrun)
- [A] reserve +$0.16 (covers the rest of the job; closest to finishing); $0.14 left
- [C] ask customer: raise hold $0.75 → $1.04
- [C] customer timeout
- [C] budget-limited plan (customer timeout): 2 steps kept, 1 dropped, plan now costs $0.36 of $0.45 left; dropped lookup
- [B] ask customer: raise hold $0.75 → $1.24
- [B] customer approved
- [B] [SIMULATED] clearing deposit raised to $1.24
- [B] Airwallex incremental auth OK: hold now $1.24
- [A] outline: buy from model-std for $0.24 — model-std is the cheapest tier-2 option that fits
- [*] [SIMULATED] clearing epoch 1 closed: 7 running totals redeemed
- [A] body: buy from model-std for $0.30 — model-std is the cheapest tier-2 option that fits; skipped slow: model-lite
- [A] budget-limited plan (float exhausted): 1 steps kept, 0 dropped, plan now costs $0.05 of $0.05 left
- [B] budget-limited plan (float exhausted): 2 steps kept, 1 dropped, plan now costs $0.24 of $0.24 left; dropped lookup
- [C] budget-limited plan (float exhausted): 2 steps kept, 0 dropped, plan now costs $0.06 of $0.06 left
- [C] compare: buy from model-std for $0.06 — model-std is the cheapest tier-2 option that fits; skipped slow: model-lite
- [B] analysis: buy from model-lite for $0.16 — model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)
- [A] summary: buy from model-lite for $0.05 — model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)
- [A] finished (budget-limited)
- [*] [SIMULATED] clearing epoch 2 closed: 4 running totals redeemed
- [C] reserve +$0.03 (covers the rest of the job; closest to finishing); $0.11 left
- [B] wrapup: buy from model-lite for $0.08 — model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)
- [B] finished (budget-limited)
- [C] brief: buy from model-lite for $0.03 — model-lite is the cheapest tier-1 option that fits (no fast provider fits the budget; accepting a slower one)
- [C] finished (budget-limited)
- [*] [SIMULATED] clearing epoch 3 closed: 2 running totals redeemed
- [A] [SIMULATED] clearing final: redeemed $0.64, unused deposit $0.36 withdrawn
- [B] [SIMULATED] clearing final: redeemed $0.36, unused deposit $0.88 withdrawn
- [C] [SIMULATED] clearing final: redeemed $0.39, unused deposit $0.36 withdrawn
- [A] captured $0.64, released $0.36
- [B] captured $0.36, released $0.88
- [C] captured $0.39, released $0.36
- [*] withdrew unused float $0.11 USDZ
