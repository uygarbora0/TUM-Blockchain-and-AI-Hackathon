use aiken/interval.{Finite, Interval, IntervalBound}
use cardano/address.{Address, Script}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use mandate_vault.{AgentSpend, Mandate, OwnerSpend}

const owner = #"00000000000000000000000000000000000000000000000000000001"

const agent = #"00000000000000000000000000000000000000000000000000000002"

const vault_hash = #"00000000000000000000000000000000000000000000000000000003"

const venue = #"00000000000000000000000000000000000000000000000000000004"

const stranger = #"00000000000000000000000000000000000000000000000000000005"

const ada = 1_000_000

fn vault() -> Address {
  Address { payment_credential: Script(vault_hash), stake_credential: None }
}

fn mandate() -> Mandate {
  Mandate {
    agent,
    max_per_tx: 50 * ada,
    period_limit: 80 * ada,
    period_ms: 86_400_000,
    period_start: 1_000,
    spent_in_period: 0,
    recipients: [address.from_verification_key(venue)],
    expiry: 10_000_000,
  }
}

fn own_ref() -> OutputReference {
  OutputReference { transaction_id: #"aa", output_index: 0 }
}

fn vault_input(m: Mandate) -> Input {
  Input {
    output_reference: own_ref(),
    output: Output {
      address: vault(),
      value: assets.from_lovelace(100 * ada),
      datum: InlineDatum(m),
      reference_script: None,
    },
  }
}

fn range(lower: Int, upper: Int) -> Interval<Int> {
  Interval {
    lower_bound: IntervalBound { bound_type: Finite(lower), is_inclusive: True },
    upper_bound: IntervalBound {
      bound_type: Finite(upper),
      is_inclusive: False,
    },
  }
}

/// A well-formed agent payment of `amount` lovelace to the venue.
fn agent_tx(m: Mandate, amount: Int, next: Mandate) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [vault_input(m)],
    outputs: [
      Output {
        address: address.from_verification_key(venue),
        value: assets.from_lovelace(amount),
        datum: NoDatum,
        reference_script: None,
      },
      Output {
        address: vault(),
        value: assets.from_lovelace(100 * ada - amount),
        datum: InlineDatum(next),
        reference_script: None,
      },
    ],
    validity_range: range(2_000, 3_000),
    extra_signatories: [agent],
  }
}

fn run(tx: Transaction, amount: Int) -> Bool {
  mandate_vault.mandate_vault.spend(
    owner,
    Some(mandate()),
    AgentSpend { amount, recipient: 0 },
    own_ref(),
    tx,
  )
}

test agent_pays_within_limits() {
  let tx = agent_tx(
    mandate(),
    30 * ada,
    Mandate { ..mandate(), spent_in_period: 30 * ada },
  )
  run(tx, 30 * ada)
}

test agent_cannot_exceed_per_tx_limit() fail {
  let tx = agent_tx(
    mandate(),
    60 * ada,
    Mandate { ..mandate(), spent_in_period: 60 * ada },
  )
  run(tx, 60 * ada)
}

test agent_cannot_exceed_period_limit() fail {
  let m = Mandate { ..mandate(), spent_in_period: 60 * ada }
  let tx = agent_tx(m, 30 * ada, Mandate { ..m, spent_in_period: 90 * ada })
  mandate_vault.mandate_vault.spend(
    owner,
    Some(m),
    AgentSpend { amount: 30 * ada, recipient: 0 },
    own_ref(),
    Transaction { ..tx, inputs: [vault_input(m)] },
  )
}

test period_resets_after_it_elapses() {
  let later = 1_000 + 86_400_000
  let m = Mandate {
    ..mandate(),
    spent_in_period: 80 * ada,
    expiry: later + 10_000,
  }
  let next = Mandate { ..m, period_start: later, spent_in_period: 30 * ada }
  let tx = Transaction {
    ..agent_tx(m, 30 * ada, next),
    validity_range: range(later, later + 1_000),
  }
  mandate_vault.mandate_vault.spend(
    owner,
    Some(m),
    AgentSpend { amount: 30 * ada, recipient: 0 },
    own_ref(),
    tx,
  )
}

test agent_cannot_pay_unlisted_recipient() fail {
  let tx = agent_tx(
    mandate(),
    30 * ada,
    Mandate { ..mandate(), spent_in_period: 30 * ada },
  )
  let thief = Output {
    address: address.from_verification_key(stranger),
    value: assets.from_lovelace(30 * ada),
    datum: NoDatum,
    reference_script: None,
  }
  expect [_, continuing] = tx.outputs
  run(Transaction { ..tx, outputs: [thief, continuing] }, 30 * ada)
}

test agent_cannot_act_after_expiry() fail {
  let tx = agent_tx(
    mandate(),
    30 * ada,
    Mandate { ..mandate(), spent_in_period: 30 * ada },
  )
  run(Transaction { ..tx, validity_range: range(2_000, 20_000_000) }, 30 * ada)
}

test agent_must_sign() fail {
  let tx = agent_tx(
    mandate(),
    30 * ada,
    Mandate { ..mandate(), spent_in_period: 30 * ada },
  )
  run(Transaction { ..tx, extra_signatories: [stranger] }, 30 * ada)
}

test agent_cannot_rewrite_mandate() fail {
  let tampered = Mandate {
    ..mandate(),
    spent_in_period: 30 * ada,
    max_per_tx: 1_000 * ada,
  }
  run(agent_tx(mandate(), 30 * ada, tampered), 30 * ada)
}

test agent_cannot_take_more_than_amount() fail {
  let tx = agent_tx(
    mandate(),
    30 * ada,
    Mandate { ..mandate(), spent_in_period: 30 * ada },
  )
  expect [payment, continuing] = tx.outputs
  run(
    Transaction {
      ..tx,
      outputs: [
        payment,
        Output { ..continuing, value: assets.from_lovelace(50 * ada) },
      ],
    },
    30 * ada,
  )
}

test owner_can_withdraw_everything() {
  mandate_vault.mandate_vault.spend(
    owner,
    Some(mandate()),
    OwnerSpend,
    own_ref(),
    Transaction { ..transaction.placeholder, extra_signatories: [owner] },
  )
}

test owner_recovers_plain_transfer() {
  mandate_vault.mandate_vault.spend(
    owner,
    None,
    OwnerSpend,
    own_ref(),
    Transaction { ..transaction.placeholder, extra_signatories: [owner] },
  )
}

test agent_cannot_use_owner_action() fail {
  mandate_vault.mandate_vault.spend(
    owner,
    Some(mandate()),
    OwnerSpend,
    own_ref(),
    Transaction { ..transaction.placeholder, extra_signatories: [agent] },
  )
}

// The recipient's existing ADA (spent and re-created in the same
// transaction) must not count as the agent's payment.
test agent_cannot_count_existing_recipient_funds() fail {
  let m = mandate()
  let recipient = address.from_verification_key(venue)
  let existing = Input {
    output_reference: OutputReference { transaction_id: #"bb", output_index: 0 },
    output: Output {
      address: recipient,
      value: assets.from_lovelace(40 * ada),
      datum: NoDatum,
      reference_script: None,
    },
  }
  let next = Mandate { ..m, spent_in_period: 30 * ada }
  let tx = agent_tx(m, 30 * ada, next)
  expect [_, continuing] = tx.outputs
  run(
    Transaction {
      ..tx,
      inputs: [vault_input(m), existing],
      outputs: [
        Output { ..continuing, value: assets.from_lovelace(70 * ada) },
        Output {
          address: recipient,
          value: assets.from_lovelace(40 * ada),
          datum: NoDatum,
          reference_script: None,
        },
      ],
    },
    30 * ada,
  )
}
