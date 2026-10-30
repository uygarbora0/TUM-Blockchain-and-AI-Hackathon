//// Lending pool: borrowers lock ADA and mint tUSD debt against it. One script
//// hash is both the loan address and the tUSD/LOAN minting policy.
////
//// Each loan UTxO holds only ADA plus one LOAN token, sits at the lending
//// script with the borrower's key as stake credential, and carries a Loan
//// datum. A transaction touches at most one loan, which keeps the mint and
//// spend checks exact.

use aiken/collection/list
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use guardian/types.{
  Loan, debt_token, health_bps, loan_token, min_open_health_bps, oracle_price,
}

pub type LoanAction {
  /// Anyone may add collateral or repay debt. Nothing can be taken out.
  Support
  /// The borrower may borrow more, repay, withdraw collateral or close,
  /// as long as the loan stays at or above the opening health factor.
  BorrowerUpdate
  /// Anyone may repay the whole debt and take the collateral once health
  /// falls below 1.0 at a fresh oracle price.
  Liquidate
}

validator lending(oracle_policy: PolicyId) {
  mint(_redeemer: Data, policy_id: PolicyId, self: Transaction) {
    let ins = loan_inputs(self.inputs, policy_id)
    let outs = loan_outputs(self.outputs, policy_id)
    let minted = assets.tokens(self.mint, policy_id)
    when (ins, outs) is {
      // Open a loan: mint its debt and one LOAN token into a healthy output.
      ([], [out]) -> {
        let loan = loan_datum(out)
        and {
          loan.debt > 0,
          minted == expected_mint(policy_id, loan.debt, 1),
          list.has(self.extra_signatories, loan.borrower),
          out.address.stake_credential == Some(
            Inline(VerificationKey(loan.borrower)),
          ),
          loan_value_ok(out.value, policy_id),
          health_bps(
            assets.lovelace_of(out.value),
            loan.debt,
            oracle_price(self, oracle_policy),
          ) >= min_open_health_bps,
        }
      }
      // Change a loan: tUSD minted or burned equals the change in debt.
      ([input], [out]) ->
        minted == expected_mint(
          policy_id,
          loan_datum(out).debt - loan_datum(input.output).debt,
          0,
        )
      // Close or liquidate: burn the whole debt and the LOAN token.
      ([input], []) ->
        minted == expected_mint(policy_id, -loan_datum(input.output).debt, -1)
      _ -> False
    }
  }

  spend(
    datum: Option<Loan>,
    redeemer: LoanAction,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(loan) = datum
    expect Some(input) = transaction.find_input(self.inputs, own_ref)
    expect Script(own_hash) = input.output.address.payment_credential
    expect [_] = loan_inputs(self.inputs, own_hash)
    let outs = loan_outputs(self.outputs, own_hash)
    let debt_minted = assets.quantity_of(self.mint, own_hash, debt_token)
    let collateral = assets.lovelace_of(input.output.value)
    when redeemer is {
      Support -> {
        expect [out] = outs
        let next = loan_datum(out)
        and {
          continues(out, input, own_hash, loan),
          next.debt >= 0,
          next.debt <= loan.debt,
          assets.lovelace_of(out.value) >= collateral,
          debt_minted == next.debt - loan.debt,
        }
      }
      BorrowerUpdate -> and {
          list.has(self.extra_signatories, loan.borrower),
          when outs is {
            [] -> debt_minted == -loan.debt
            [out] -> {
              let next = loan_datum(out)
              and {
                continues(out, input, own_hash, loan),
                next.debt >= 0,
                debt_minted == next.debt - loan.debt,
                next.debt == 0 || health_bps(
                  assets.lovelace_of(out.value),
                  next.debt,
                  oracle_price(self, oracle_policy),
                ) >= min_open_health_bps,
              }
            }
            _ -> False
          },
        }
      Liquidate -> and {
          outs == [],
          debt_minted == -loan.debt,
          health_bps(collateral, loan.debt, oracle_price(self, oracle_policy)) < 10000,
        }
    }
  }

  else(_) {
    fail
  }
}

fn loan_inputs(inputs: List<Input>, hash: PolicyId) -> List<Input> {
  list.filter(
    inputs,
    fn(i) { i.output.address.payment_credential == Script(hash) },
  )
}

fn loan_outputs(outputs: List<Output>, hash: PolicyId) -> List<Output> {
  list.filter(outputs, fn(o) { o.address.payment_credential == Script(hash) })
}

fn loan_datum(output: Output) -> Loan {
  expect InlineDatum(raw) = output.datum
  expect loan: Loan = raw
  loan
}

/// Same address, same borrower, ADA plus exactly one LOAN token.
fn continues(out: Output, input: Input, hash: PolicyId, loan: Loan) -> Bool {
  and {
    out.address == input.output.address,
    loan_datum(out).borrower == loan.borrower,
    loan_value_ok(out.value, hash),
    out.reference_script == None,
  }
}

fn loan_value_ok(value: Value, hash: PolicyId) -> Bool {
  assets.without_lovelace(value) == assets.from_asset(hash, loan_token, 1)
}

fn expected_mint(policy_id: PolicyId, debt: Int, loans: Int) {
  assets.zero
    |> assets.add(policy_id, debt_token, debt)
    |> assets.add(policy_id, loan_token, loans)
    |> assets.tokens(policy_id)
}

/// The address a borrower's loan must use: the lending script, staked to them.
pub fn loan_address(hash: PolicyId, borrower: ByteArray) -> Address {
  Address {
    payment_credential: Script(hash),
    stake_credential: Some(Inline(VerificationKey(borrower))),
  }
}
