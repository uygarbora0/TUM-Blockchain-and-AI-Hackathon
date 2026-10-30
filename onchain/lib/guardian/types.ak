//// Types and helpers shared by the oracle, lending and vault validators.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval.{Finite}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Output, Transaction}

/// Oracle datum. `price` is micro-USD per ADA; `updated_at` is POSIX ms.
pub type PriceDatum {
  price: Int,
  updated_at: Int,
}

/// Loan datum. `debt` is in micro-tUSD (6 decimals, 1 tUSD = 1 USD).
pub type Loan {
  borrower: VerificationKeyHash,
  debt: Int,
}

pub const oracle_token = "price"

pub const debt_token = "tUSD"

pub const loan_token = "LOAN"

/// Liquidation threshold: collateral counts at 80% of its value.
pub const threshold_bps = 8000

/// New borrowing and collateral withdrawals must leave health >= 1.10.
pub const min_open_health_bps = 11000

/// Oracle prices older than 30 minutes cannot open, change or liquidate loans.
pub const max_price_age_ms = 1_800_000

pub fn lower_bound(self: Transaction) -> Int {
  expect Finite(t) = self.validity_range.lower_bound.bound_type
  t
}

pub fn upper_bound(self: Transaction) -> Int {
  expect Finite(t) = self.validity_range.upper_bound.bound_type
  t
}

pub fn price_datum(output: Output) -> PriceDatum {
  expect InlineDatum(raw) = output.datum
  expect datum: PriceDatum = raw
  datum
}

/// The oracle price from the reference input carrying the oracle NFT. Fails
/// unless the whole validity range ends within the freshness window.
pub fn oracle_price(self: Transaction, oracle_policy: PolicyId) -> Int {
  expect Some(input) = list.find(
    self.reference_inputs,
    fn(i) {
      assets.quantity_of(i.output.value, oracle_policy, oracle_token) == 1
    },
  )
  let datum = price_datum(input.output)
  expect upper_bound(self) <= datum.updated_at + max_price_age_ms
  datum.price
}

/// Health factor in basis points (10000 = 1.0).
pub fn health_bps(collateral: Int, debt: Int, price: Int) -> Int {
  if debt <= 0 {
    1_000_000_000
  } else {
    collateral * price * threshold_bps / ( debt * 1_000_000 )
  }
}
