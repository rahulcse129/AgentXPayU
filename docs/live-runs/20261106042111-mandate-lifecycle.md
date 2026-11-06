# Live Metal mandate lifecycle · 2026-11-06T04:22:35.499Z

`npm run live:mandate` on Metal testnet. Every transaction re-read from chain.

```
Owner account 0x9819C6c7c14D03fF90e0069873d16CA4BF1386EB · balance 99.99 USDZ · run mandate-check-20261106042111

1. Open: credential + bind
  mandate 0x76b356a86bc5009b4944ae26351acf9c31ffafde252bc1cdd2515c9a592f45c7 · 6 payees · cap $0.03 · budget $0.20
  bind: success · block 17597038 · https://testnet.metalntwx.com/tx/0x1b0ca3597aa56105f7b0c37ab6988d7ac6cd5dcb04b29200233a994b4d7e276c

2. Pay 1¢ to model-lite under the mandate
  pull: success · block 17597165 · https://testnet.metalntwx.com/tx/0xcfcbc09ddb4ce976bf4db7760296058e349b2ac6ea4dbdfa7283c2dc73625ce4
    USDZ transfers: 0x9819C6…→0x111111… 0.01 · AuthorizationUsed ✓
  account balance 99.99 → 99.98

3. Same payment id again, straight at the CLI (it must report, not pay)
  same tx: yes · balance 99.98

4. Refusals
  unregistered payee: refused · reason mandate_payee_not_listed
      refusal recorded: success · block 17597519 · https://testnet.metalntwx.com/tx/0x2a869170066fc6e1a23922c7f85c1b6188f36b038326550303821055758c4cd3
  over the 3¢ cap: refused · reason mandate_cap_exceeded
      refusal recorded: success · block 17597702 · https://testnet.metalntwx.com/tx/0xf81a9c9a4a3897e0a7b68e3469abf7ce67d3fad91ddfd8e08023724061e4a8d5
  balance 99.98

5. Raise budget +$0.05 (replace), as after an approved hold increase
  budget now $0.25
  replace: success · block 17597881 · https://testnet.metalntwx.com/tx/0x76ce76ff55aa517a8e7cb81ed017c258605e47079855f830a01d24387074efd2

6. Revoke, then try to pay
  revoke: success · block 17597981 · https://testnet.metalntwx.com/tx/0x51130f8fbeb0b51659b39a8b18e7e1eeb35e99da2471bb327dc0e580912d11d1
  pull after revoke: refused: Metal mandate refused: mandate_revoked (the mandate is revoked, or replaced: the agent pays under the credential that replaced it); refusal recorded on chain 0x

Final account balance 99.98 USDZ
```
