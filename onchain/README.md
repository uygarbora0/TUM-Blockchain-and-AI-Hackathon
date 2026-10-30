# Guardian contracts

Aiken (Plutus V3) validators for Liquidation Guardian on Cardano Preprod.

- `validators/oracle.ak`: one-shot NFT price feed, updated only by the operator key.
- `validators/lending.ak`: ADA-collateralised loans that mint tUSD; liquidation below health 1.0.
- `validators/mandate_vault.ak`: the owner's rescue funds; the agent may pay only allowed recipients within the mandate.
- `lib/guardian/types.ak`: shared datums, constants and health math.

```sh
aiken check   # run the validator tests
aiken build   # regenerate plutus.json, which the server loads
```

Requires Aiken `v1.1.24`. Commit the regenerated `plutus.json` after any change.
