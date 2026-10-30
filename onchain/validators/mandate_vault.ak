//// Mandate vault: the owner locks ADA under a mandate that names one agent key
//// and its limits. The agent may pay allow-listed recipients within those
//// limits; the owner may spend everything (withdraw, revoke, or re-mandate).
////
//// The validator is parameterised by the owner's key hash, so every owner has
//// their own vault address and can always recover funds sent there, even a
//// plain transfer without a datum.

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval.{Finite}
use cardano/address.{Address}
use cardano/assets
use cardano/transaction.{InlineDatum, Output, OutputReference, Transaction}

/// Amounts are lovelace; times are POSIX milliseconds.
pub type Mandate {
  agent: VerificationKeyHash,
  max_per_tx: Int,
  period_limit: Int,
  period_ms: Int,
  period_start: Int,
  spent_in_period: Int,
  recipients: List<Address>,
  expiry: Int,
}

pub type Action {
  /// Pay `amount` lovelace to `recipients[recipient]`.
  AgentSpend { amount: Int, recipient: Int }
  /// Owner-signed spend: withdraw everything, revoke or replace the mandate.
  OwnerSpend
}

validator mandate_vault(owner: VerificationKeyHash) {
  spend(
    datum: Option<Mandate>,
    redeemer: Action,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    when redeemer is {
      OwnerSpend -> list.has(self.extra_signatories, owner)
      AgentSpend { amount, recipient } -> {
        expect Some(mandate) = datum
        agent_spend(mandate, amount, recipient, own_ref, self)
      }
    }
  }

  else(_) {
    fail
  }
}

fn agent_spend(
  m: Mandate,
  amount: Int,
  recipient_index: Int,
  own_ref: OutputReference,
  self: Transaction,
) -> Bool {
  expect Some(own_input) = transaction.find_input(self.inputs, own_ref)
  let own_address = own_input.output.address
  expect Finite(lower) = self.validity_range.lower_bound.bound_type
  expect Finite(upper) = self.validity_range.upper_bound.bound_type
  expect Some(recipient) = list.at(m.recipients, recipient_index)

  // A new period starts once the previous one has fully elapsed.
  let new_period = lower >= m.period_start + m.period_ms
  let period_start = if new_period {
    lower
  } else {
    m.period_start
  }
  let spent = if new_period {
    amount
  } else {
    m.spent_in_period + amount
  }

  // Exactly one continuing output, carrying the updated mandate and every
  // asset except the lovelace paid out.
  expect [continuing] = list.filter(
    self.outputs,
    fn(o) { o.address == own_address },
  )
  expect InlineDatum(raw) = continuing.datum
  expect next: Mandate = raw
  let in_value = own_input.output.value

  and {
    list.has(self.extra_signatories, m.agent),
    // One vault input per transaction prevents paying two vaults' amounts
    // with a single output (double satisfaction).
    list.count(
      self.inputs,
      fn(i) {
        i.output.address.payment_credential == own_address.payment_credential
      },
    ) == 1,
    amount > 0,
    amount <= m.max_per_tx,
    m.period_ms > 0,
    spent <= m.period_limit,
    upper <= m.expiry,
    recipient.payment_credential != own_address.payment_credential,
    // Net flow, not a single output: ADA already held at the recipient
    // (such as a loan's existing collateral) cannot count as this payment.
    lovelace_at(self.outputs, recipient) - lovelace_at(
      list.map(self.inputs, fn(i) { i.output }),
      recipient,
    ) >= amount,
    assets.lovelace_of(continuing.value) >= assets.lovelace_of(in_value) - amount,
    assets.without_lovelace(continuing.value) == assets.without_lovelace(
      in_value,
    ),
    continuing.reference_script == None,
    next == Mandate { ..m, period_start, spent_in_period: spent },
  }
}

fn lovelace_at(outputs: List<Output>, address: Address) -> Int {
  list.foldl(
    outputs,
    0,
    fn(o, total) {
      if o.address == address {
        total + assets.lovelace_of(o.value)
      } else {
        total
      }
    },
  )
}
