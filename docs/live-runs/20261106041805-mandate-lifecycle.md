# Live Metal mandate lifecycle · 2026-11-06T04:19:04.215Z

`npm run live:mandate` on Metal testnet. Every transaction re-read from chain.

```
Owner account 0x9819C6c7c14D03fF90e0069873d16CA4BF1386EB · balance 100 USDZ · run mandate-check-20261106041805

1. Open: credential + bind
  mandate 0xd29567252d900daf6d7a9d0f3d91a0b5f24c41cbd7820583f37237800adefe98 · 6 payees · cap $0.03 · budget $0.20
  bind: success · block 17594179 · https://testnet.metalntwx.com/tx/0x6618d2e59c50223097fde550745c7496fb098d82d773d318ec0c492e339c11e4

2. Pay 1¢ to model-lite under the mandate
  pull: success · block 17594309 · https://testnet.metalntwx.com/tx/0xd0907a361447e93e36e2f45aee67af05e78554a53de90ff0ca3e3d0a033d23f1
    USDZ transfers: 0x9819C6…→0x111111… 0.01 · AuthorizationUsed ✓
  account balance 100 → 99.99

3. Same payment id again, straight at the CLI (it must report, not pay)
  same tx: yes · balance 99.99

4. Refusals
  unregistered payee: refused: Metal mandate refused on chain: outcome refused, not sent
  over the 3¢ cap: refused: Metal mandate refused on chain: outcome refused, not sent
  balance 99.99

5. Raise budget +$0.05 (replace), as after an approved hold increase
  budget now $0.25
  replace: success · block 17594731 · https://testnet.metalntwx.com/tx/0x09e72f6bd2219c5966e8c79cc78f680db380e4b64fd84aecada762ef49e7b15a

6. Revoke, then try to pay
  revoke: success · block 17594839 · https://testnet.metalntwx.com/tx/0x3d26906f13f6077e5216b9f4dbb4d65b7472f3d5a728e17f1af28c3049151c82
  pull after revoke: refused: Metal mandate refused on chain: outcome refused, not sent

Final account balance 99.99 USDZ
```
