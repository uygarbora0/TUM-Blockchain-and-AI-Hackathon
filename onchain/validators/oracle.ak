//// Price oracle: one UTxO carrying a one-shot NFT and the latest ADA/USD
//// price. Only the operator key can update it, and only with a timestamp
//// inside the transaction's validity range, so it cannot be back- or
//// forward-dated.

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{Output, OutputReference, Transaction}
use guardian/types.{
  PriceDatum, lower_bound, oracle_token, price_datum, upper_bound,
}

validator oracle(operator: VerificationKeyHash, seed: OutputReference) {
  mint(_redeemer: Data, policy_id: PolicyId, self: Transaction) {
    expect [Pair(name, 1)] = dict.to_pairs(assets.tokens(self.mint, policy_id))
    and {
      name == oracle_token,
      list.any(self.inputs, fn(i) { i.output_reference == seed }),
      list.has(self.extra_signatories, operator),
      list.any(
        self.outputs,
        fn(o) {
          o.address.payment_credential == Script(policy_id) && carries_valid_price(
            o,
            policy_id,
            self,
          )
        },
      ),
    }
  }

  spend(
    _datum: Option<PriceDatum>,
    _redeemer: Data,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(input) = transaction.find_input(self.inputs, own_ref)
    expect Script(own_hash) = input.output.address.payment_credential
    let holds_nft = assets.quantity_of(
      input.output.value,
      own_hash,
      oracle_token,
    ) == 1
    and {
      list.has(self.extra_signatories, operator),
      // The NFT must stay at the oracle address with a fresh, valid price.
      !holds_nft || list.any(
        self.outputs,
        fn(o) {
          o.address == input.output.address && carries_valid_price(
            o,
            own_hash,
            self,
          )
        },
      ),
    }
  }

  else(_) {
    fail
  }
}

fn carries_valid_price(
  o: Output,
  policy_id: PolicyId,
  self: Transaction,
) -> Bool {
  let datum = price_datum(o)
  and {
    assets.quantity_of(o.value, policy_id, oracle_token) == 1,
    datum.price > 0,
    datum.updated_at >= lower_bound(self),
    datum.updated_at <= upper_bound(self),
  }
}
