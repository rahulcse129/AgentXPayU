# Dashboard run with every buildable rail live, 2026-11-09

`APPROVAL_TIMEOUT_MS=60000 npm run engine:live-full` (`--live-airwallex --live-mandate --no-llm`) plus
`npm run dashboard`, scripted demo, 335 s.

| Rail | Mode in this run |
|---|---|
| Card holds | **LIVE**: Airwallex sandbox; each customer's card entered in Drop-in (sandbox test Visa) |
| Provider payments | **LIVE**: x402 on Metal testnet (`eip155:63825`), paid from MetalAccount `0x9819C6c7c14D03fF90e0069873d16CA4BF1386EB` |
| Mandate | **LIVE**: Metal mandate, 6 registered payees, $3.00 per-payment cap, $1.50 budget |
| Clearing | SIMULATED (Margin's emulator; Metal's live testnet clearing wasn't wired in) |
| LLM | off (`--no-llm`), so the feed uses the template lines |

## Result: reconciled, 0 violations

| Job | Airwallex intent | Hold | Ledger | On chain | Clearing | Captured at Airwallex | Released |
|---|---|---|---|---|---|---|---|
| A, Acme Research | `int_sgpvzc9hjhnz93kegl3` | $1.00 | $0.48 | $0.48 | $0.48 | $0.48 | $0.52 |
| B, Birch Capital | `int_sgpvtdh4nhnz95mkrye` | $0.75 | $0.60 | $0.60 | $0.60 | $0.60 | $0.15 |
| C, Cobalt Labs | `int_sgpvtdh4nhnz967f5um` | $0.75 (raise to $1.04 declined) | $0.39 | $0.39 | $0.39 | $0.39 | $0.36 |
| **Total** | | | **$1.47** | **$1.47** | **$1.47** | **$1.47** | |

"On chain" is each payment read back from Metal testnet after the run. "Captured" is each PaymentIntent
read back from Airwallex (`captured_amount`; all three are `SUCCEEDED`).

## The two locks, live

- **Mandate:** [bind](https://testnet.metalntwx.com/tx/0x818c0b2b67e012b5f0a9742b9a6fe8e86e8cff098298b70e96b6a251258327a9) ·
  [revoke](https://testnet.metalntwx.com/tx/0x7e079ee96f3f68cf7de44216866745102a6409bf92dc822bd9df2687a59a454c)
  (mandate `0x9ce29c2b…6c08c`).
- **Our quote check** refused model-bargain's overquote for C ($0.42 asked, $0.14 list price).
- **The deliberate test.** We switched our quote check off, and model-bargain asked to be paid $0.48 at
  `0xdead…dead`. The **live mandate refused it** (`mandate_payee_not_listed`), and the refusal was
  [recorded on chain](https://testnet.metalntwx.com/tx/0x9be536d3d5d173aa2c0660fa477926c2cf0ffc7b359b3249861b1542e172adb5).
  The quote check was then switched back on, and B bought the step from model-lite instead.

## Payments (all on Metal testnet)

| Job | Step | Provider | Paid | Tx |
|---|---|---|---|---|
| A | search | search | $0.02 | [0xec93…37f6](https://testnet.metalntwx.com/tx/0xec93c17827b31bffad06353d5299bd5a38612149472490c110ddee2214f837f6) |
| A | lookup | data | $0.03 | [0x7733…cfd3](https://testnet.metalntwx.com/tx/0x7733aa822ed4a76ea159fe3df32cb545871250f6e84520b076cb222ceac7cfd3) |
| A | outline | model-std | $0.24 | [0xbd14…584e](https://testnet.metalntwx.com/tx/0xbd147ead4df27014ec71554e0a505c52b568210c18047e8dd34dae365d44584e) |
| A | body | model-lite | $0.15 | [0x4621…88f1](https://testnet.metalntwx.com/tx/0x46217f11cb212247cf20243d4b873e52028d5bc8183dba2172b1198ee47c88f1) |
| A | summary | model-lite | $0.04 | [0x6c42…af38](https://testnet.metalntwx.com/tx/0x6c42e8b01b2b7359de69763992788b5e72aec686751d99523f34d7a9dffdaf38) |
| B | search | search | $0.02 | [0x77ac…b1](https://testnet.metalntwx.com/tx/0x77acab04db395ac7324b64a11672dd9284aa2260fd8d69905103bdd4abea31b1) |
| B | draft | model-lite | $0.10 | [0xf033…6d31](https://testnet.metalntwx.com/tx/0xf03344df6dd9040c8e71af2fac2bea655487d46b5fa749dba0727c04487e6d31) |
| B | analysis | model-bargain | refused by the mandate | [refusal](https://testnet.metalntwx.com/tx/0x9be536d3d5d173aa2c0660fa477926c2cf0ffc7b359b3249861b1542e172adb5) |
| B | analysis | model-lite | $0.48 | [0xa848…5aa2](https://testnet.metalntwx.com/tx/0xa8486d7f645b1137144ef2909632156e6a8dc57b94c85a5c521875bb5da15aa2) |
| C | search | search | $0.02 | [0x2dbe…52c8](https://testnet.metalntwx.com/tx/0x2dbebc4a920226998f28bc52a5c504368259d9824b2ba0d65d0a803d87fd52c8) |
| C | scan | model-bargain | refused by our quote check | — |
| C | scan | model-std | $0.28 | [0xeaab…90db](https://testnet.metalntwx.com/tx/0xeaabc0470d273c97f3e0cb5013e43c3a2b834df057542f07d869e57b3ce090db) |
| C | compare | model-std | $0.06 | [0x0d56…0abc](https://testnet.metalntwx.com/tx/0x0d56fa58f150ba28b9ff35c385e1a67682870ffdd6c6740a2f66826082600abc) |
| C | brief | model-lite | $0.03 | [0xa380…491c](https://testnet.metalntwx.com/tx/0xa380cfb9317dc78fdd4beb127b3cc59fc54f00a7cc317fb8f186690562e8491c) |

B didn't need a hold raise in this run, because it finished within its $0.75. The live Airwallex increment
is proven by [the earlier run today](2026-11-09-dashboard-live-airwallex-run.md) ($0.75 → $1.24).
