import {createDemoPosition} from './fixtures.mjs';

export {createDemoPosition};

export const DEFAULT_POLICY = Object.freeze({
  triggerHealth: 1.25,
  targetHealth: 1.5,
  maxSpendUsd: 650,
  minAdaReserve: 5,
  cooldownSeconds: 30,
  slippageBps: 50,
  feeAda: 0.3,
  maxPriceAgeSeconds: 60,
  preferredAction: 'cheapest',
  mode: 'manual',
});

// Integer arithmetic keeps rescue amounts and spend limits independent of
// binary floating-point rounding. Sandbox assets have six decimal places;
// prices and policy ratios have eight. A production adapter must supply its
// actual token precision, protocol math, fee estimate, and oracle semantics.
const TOKEN = 1_000_000n;
const PRICE = 100_000_000n;
const BPS = 10_000n;
const USD_SCALE = TOKEN * PRICE;
const ACTION_TYPES = ['repay', 'add_collateral', 'unwind'];

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function text(value, name, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TypeError(`${name} must be a nonempty string of at most ${max} characters`);
  }
  return value.trim();
}

// Parse decimal and scientific notation without multiplying floats. Rounding
// here only normalizes negligible binary arithmetic artifacts, after the
// caller checks that the value fits the stated precision.
function units(value, decimals) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction);
  const shift = Number(exponent) - fraction.length + decimals;
  if (shift >= 0) return digits * (10n ** BigInt(shift));
  const divisor = 10n ** BigInt(-shift);
  return (digits + divisor / 2n) / divisor;
}

function number(value, name, {min = 0, max = 1_000_000_000, decimals = 6, positive = false} = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (positive && value === 0)) {
    throw new TypeError(`${name} must be a finite number ${positive ? 'greater than 0' : `at least ${min}`} and at most ${max}`);
  }
  const normalized = Number(units(value, decimals)) / (10 ** decimals);
  const tolerance = Math.abs(value) * Number.EPSILON * 8;
  if (Math.abs(normalized - value) > tolerance || (positive && normalized === 0)) {
    throw new TypeError(`${name} supports at most ${decimals} decimal places`);
  }
  return normalized;
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO timestamp with a timezone`);
  }
  return new Date(value).toISOString();
}

/** Validate an explicit snapshot. No prices or protocol parameters are fetched. */
export function validatePosition(input) {
  const position = record(input, 'position');
  const collateral = record(position.collateral, 'collateral');
  const debt = record(position.debt, 'debt');
  const reserve = record(position.reserve, 'reserve');
  if (!['simulation', 'preprod', 'mainnet'].includes(position.network)) {
    throw new TypeError('network must be simulation, preprod, or mainnet');
  }
  if (collateral.symbol !== 'ADA') {
    throw new TypeError('This calculator supports ADA collateral only; reserve.collateral also pays ADA fees');
  }
  const debtSymbol = text(debt.symbol, 'debt.symbol', 24);
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(debtSymbol)) throw new TypeError('debt.symbol must be an asset ticker');
  if (debtSymbol.toUpperCase() === 'ADA') {
    throw new TypeError('Debt must be a separate asset from ADA; shared-asset reserve accounting is unsupported');
  }
  return {
    id: text(position.id, 'position.id'),
    label: text(position.label, 'position.label'),
    protocol: text(position.protocol, 'position.protocol'),
    network: position.network,
    collateral: {
      symbol: 'ADA',
      amount: number(collateral.amount, 'collateral.amount'),
      priceUsd: number(collateral.priceUsd, 'collateral.priceUsd', {positive: true, decimals: 8}),
      liquidationThreshold: number(collateral.liquidationThreshold, 'collateral.liquidationThreshold', {positive: true, max: 1, decimals: 8}),
    },
    debt: {
      symbol: debtSymbol,
      amount: number(debt.amount, 'debt.amount'),
      priceUsd: number(debt.priceUsd, 'debt.priceUsd', {positive: true, decimals: 8}),
    },
    reserve: {
      collateral: number(reserve.collateral, 'reserve.collateral'),
      debt: number(reserve.debt, 'reserve.debt'),
    },
    priceUpdatedAt: timestamp(position.priceUpdatedAt, 'priceUpdatedAt'),
  };
}

export function validatePolicy(input = {}) {
  const policy = {...DEFAULT_POLICY, ...record(input, 'policy')};
  const output = {
    triggerHealth: number(policy.triggerHealth, 'triggerHealth', {min: 1, max: 1000, decimals: 8}),
    targetHealth: number(policy.targetHealth, 'targetHealth', {min: 1, max: 1000, decimals: 8}),
    maxSpendUsd: number(policy.maxSpendUsd, 'maxSpendUsd', {decimals: 8}),
    minAdaReserve: number(policy.minAdaReserve, 'minAdaReserve'),
    cooldownSeconds: number(policy.cooldownSeconds, 'cooldownSeconds', {max: 86400, decimals: 0}),
    slippageBps: number(policy.slippageBps, 'slippageBps', {max: 5000, decimals: 0}),
    feeAda: number(policy.feeAda, 'feeAda'),
    maxPriceAgeSeconds: number(policy.maxPriceAgeSeconds, 'maxPriceAgeSeconds', {positive: true, max: 86400, decimals: 0}),
    preferredAction: policy.preferredAction,
    mode: policy.mode,
  };
  if (output.triggerHealth <= 1 || output.targetHealth <= output.triggerHealth) {
    throw new TypeError('targetHealth must be greater than triggerHealth, which must be greater than 1');
  }
  if (!['cheapest', ...ACTION_TYPES].includes(output.preferredAction)) throw new TypeError('preferredAction must be cheapest, repay, add_collateral, or unwind');
  if (!['manual', 'automatic'].includes(output.mode)) throw new TypeError('mode must be manual or automatic');
  return output;
}

const ceil = (numerator, denominator) => (numerator + denominator - 1n) / denominator;
const amount = value => Number(value) / Number(TOKEN);
const usd = value => Number(value) / Number(USD_SCALE);

function context(position, policy, now) {
  if (!Number.isFinite(now) || now < 0) throw new TypeError('now must be a valid timestamp');
  const c = units(position.collateral.amount, 6);
  const d = units(position.debt.amount, 6);
  const cp = units(position.collateral.priceUsd, 8);
  const dp = units(position.debt.priceUsd, 8);
  const threshold = units(position.collateral.liquidationThreshold, 8);
  const target = units(policy.targetHealth, 8);
  const trigger = units(policy.triggerHealth, 8);
  const fee = units(policy.feeAda, 6);
  const priceAgeSeconds = (now - Date.parse(position.priceUpdatedAt)) / 1000;
  return {
    c, d, cp, dp, threshold, target, trigger, fee,
    reserveAda: units(position.reserve.collateral, 6),
    reserveDebt: units(position.reserve.debt, 6),
    minAda: units(policy.minAdaReserve, 6),
    cap: units(policy.maxSpendUsd, 8) * TOKEN,
    proceedsBps: BPS - BigInt(policy.slippageBps),
    deficit: target * d * dp - threshold * c * cp,
    priceAgeSeconds,
    fresh: priceAgeSeconds >= -5 && priceAgeSeconds <= policy.maxPriceAgeSeconds,
  };
}

function health(c, d, x) {
  return d === 0n ? null : Number(c * x.cp * x.threshold) / Number(d * x.dp * PRICE);
}

function metricsFor(position, policy, x) {
  const healthFactor = health(x.c, x.d, x);
  let riskStatus = 'healthy';
  if (x.d === 0n) riskStatus = 'debt_free';
  else if (x.c * x.cp * x.threshold <= x.d * x.dp * PRICE) riskStatus = 'liquidatable';
  else if (x.c * x.cp * x.threshold < x.d * x.dp * x.trigger) riskStatus = 'critical';
  else if (x.deficit > 0n) riskStatus = 'warning';
  const liquidationPriceUsd = x.d === 0n || x.c === 0n ? null
    : Number(x.d * x.dp) / Number(x.c * x.threshold);
  return {
    healthFactor,
    collateralUsd: usd(x.c * x.cp),
    debtUsd: usd(x.d * x.dp),
    liquidationPriceUsd,
    priceBufferPct: liquidationPriceUsd === null ? null : (1 - liquidationPriceUsd / position.collateral.priceUsd) * 100,
    priceAgeSeconds: x.priceAgeSeconds,
    status: x.fresh || x.d === 0n ? riskStatus : 'stale',
    riskStatus,
  };
}

function candidate(type, position, policy, x) {
  let q = 0n;
  let collateralAfter = x.c;
  let debtAfter = x.d;
  let debtRepaid = 0n;
  let cost = x.fee * x.cp;
  let reason = '';
  const required = x.d > 0n && x.deficit > 0n;

  if (required && type === 'repay') {
    q = ceil(x.deficit, x.target * x.dp);
    debtRepaid = q;
    debtAfter -= q;
    cost += q * x.dp;
    if (q > x.reserveDebt) reason = `Not enough ${position.debt.symbol} in the Guardian wallet to reach the target.`;
  } else if (required && type === 'add_collateral') {
    q = ceil(x.deficit, x.threshold * x.cp);
    collateralAfter += q;
    cost += q * x.cp;
    if (q + x.fee + x.minAda > x.reserveAda) reason = 'Not enough ADA in the Guardian wallet after adding collateral, paying fees, and keeping your minimum balance.';
    if (collateralAfter > 1_000_000_000n * TOKEN) reason = 'Projected collateral exceeds the supported position size.';
  } else if (required && type === 'unwind') {
    const improvement = x.target * x.proceedsBps - x.threshold * BPS;
    if (improvement <= 0n) {
      reason = 'The assumed swap loss prevents an unwind from restoring the target health factor.';
    } else {
      // Add one debt micro-unit of allowance before rounding the collateral
      // sale up. Repayment proceeds are rounded DOWN, never invented. This
      // prevents a fractional debt-token remainder missing the target.
      q = ceil((x.deficit + x.target * x.dp) * BPS, x.cp * improvement);
      const fullRepayment = ceil(x.d * x.dp * BPS, x.cp * x.proceedsBps);
      if (q > fullRepayment) q = fullRepayment;
      debtRepaid = q * x.cp * x.proceedsBps / (x.dp * BPS);
      if (debtRepaid > x.d) debtRepaid = x.d;
      debtAfter -= debtRepaid;
      collateralAfter -= q;
      cost += q * x.cp;
      if (q > x.c) reason = 'The collateral cannot fund a safe unwind at the assumed execution price.';
    }
    if (position.network !== 'simulation') reason = 'Unwind execution is simulation only; no atomic lending and swap adapter is connected.';
  }

  if (x.fee + x.minAda > x.reserveAda) reason = 'Insufficient ADA in the Guardian wallet for the transaction fee and minimum balance.';
  if (cost > x.cap) reason = 'Action exceeds maxSpendUsd, including the ADA transaction fee.';
  if (!required) reason = x.d === 0n ? 'There is no debt to protect.' : 'The position already meets the target health factor.';
  if (!x.fresh) reason = x.priceAgeSeconds < -5
    ? 'Price timestamp is in the future; action is blocked.'
    : 'Price data is stale; obtain a fresh snapshot before acting.';

  const projectedHealthFactor = collateralAfter < 0n ? null : health(collateralAfter, debtAfter, x);
  if (required && !reason && (collateralAfter < 0n || (debtAfter > 0n && collateralAfter * x.cp * x.threshold < debtAfter * x.dp * x.target))) {
    reason = 'The action cannot achieve the target health factor.';
  }
  const action = {
    type,
    feasible: required && !reason,
    reason: reason || 'Reaches the target using the Guardian wallet, within the spending limit.',
    amount: amount(q),
    asset: type === 'repay' ? position.debt.symbol : 'ADA',
    costUsd: usd(cost),
    feeAda: policy.feeAda,
    projectedHealthFactor,
    collateralAfter: amount(collateralAfter < 0n ? 0n : collateralAfter),
    debtAfter: amount(debtAfter),
    debtRepaidAmount: amount(debtRepaid),
    simulationOnly: type === 'unwind',
  };
  if (type === 'unwind') {
    action.slippageBps = policy.slippageBps;
    action.slippageUsd = usd(q * x.cp - debtRepaid * x.dp);
    action.executionRequirement = 'SIMULATION ONLY: collateral withdrawal, swap, and repayment must be atomic in a supported protocol. Separate withdrawal can trigger liquidation.';
  }
  return action;
}

/** Pure snapshot analysis. It does not monitor, sign, transfer, or fetch prices. */
export function analyze(positionInput, policyInput = {}, {now = Date.now()} = {}) {
  const position = validatePosition(positionInput);
  const policy = validatePolicy(policyInput);
  const x = context(position, policy, now);
  const metrics = metricsFor(position, policy, x);
  const actions = ACTION_TYPES.map(type => candidate(type, position, policy, x));
  const warnings = [];
  if (position.network === 'simulation') warnings.push('Fictional simulation: no wallet, live lending position, or funds are connected.');
  else warnings.push('Advisory snapshot only: live prices, position ownership, and protocol rules have not been verified.');
  if (!x.fresh) warnings.push(x.priceAgeSeconds < -5 ? 'The price timestamp is in the future. Rescue actions are blocked.' : 'Prices are stale. Rescue actions are blocked.');
  if (metrics.riskStatus === 'liquidatable') warnings.push('This snapshot is already at or below the liquidation boundary. A rescue may arrive too late.');
  warnings.push('Unwinding is a simulation and requires atomic protocol execution; withdrawing collateral first can worsen risk.');
  if (policy.mode === 'automatic') warnings.push('Automatic mode is a local simulation setting; it does not authorize a wallet or blockchain transaction.');

  const triggered = x.d > 0n && x.c * x.cp * x.threshold < x.d * x.dp * x.trigger;
  const feasible = actions.filter(action => action.feasible).sort((a, b) => a.costUsd - b.costUsd);
  const recommendation = triggered && x.fresh
    ? feasible.find(action => action.type === policy.preferredAction) ?? feasible[0] ?? null
    : null;
  if (recommendation && policy.preferredAction !== 'cheapest' && recommendation.type !== policy.preferredAction) {
    warnings.push(`Preferred action ${policy.preferredAction} is unavailable; the lowest-cost feasible alternative is shown.`);
  }

  let explanation;
  if (x.d === 0n) explanation = 'This position has no debt and cannot be liquidated under this simplified loan model.';
  else if (!x.fresh) explanation = 'A trusted, fresh price snapshot is required before making a rescue decision.';
  else if (!triggered) explanation = `Health factor ${metrics.healthFactor.toFixed(3)} is at or above the ${policy.triggerHealth} action trigger. No automatic rescue is recommended.`;
  else if (recommendation) explanation = `Health factor ${metrics.healthFactor.toFixed(3)} is below the ${policy.triggerHealth} trigger. ${recommendation.type === 'repay' ? 'Repay' : recommendation.type === 'add_collateral' ? 'Add collateral of' : 'Simulate selling'} ${recommendation.amount} ${recommendation.asset} to reach ${recommendation.projectedHealthFactor === null ? 'a debt-free position' : `health factor ${recommendation.projectedHealthFactor.toFixed(3)}`}. Estimated action value including the ADA fee: $${recommendation.costUsd.toFixed(2)}.`;
  else explanation = `Health factor ${metrics.healthFactor.toFixed(3)} is below the ${policy.triggerHealth} trigger, but no action reaches the target within the Guardian wallet balance, transaction fee, and spending limit. Review the action reasons; no rescue was executed.`;

  return {metrics, actions, recommendation, warnings, explanation};
}

/** Apply a recomputed plan to fictional balances. Caller-supplied amounts are ignored. */
export function simulateAction(positionInput, policyInput, actionInput, {now = Date.now()} = {}) {
  const position = validatePosition(positionInput);
  const policy = validatePolicy(policyInput);
  if (position.network !== 'simulation') throw new TypeError('Only simulation positions can be changed; live execution is not connected');
  const type = typeof actionInput === 'string' ? actionInput : actionInput?.type;
  if (!ACTION_TYPES.includes(type)) throw new TypeError('Action must be repay, add_collateral, or unwind');
  const analysis = analyze(position, policy, {now});
  const action = analysis.actions.find(candidate => candidate.type === type);
  if (!action.feasible) throw new Error(`Cannot simulate ${type}: ${action.reason}`);
  const x = context(position, policy, now);
  const q = units(action.amount, 6);
  let remainingAda = x.reserveAda - x.fee;
  let remainingDebt = x.reserveDebt;
  if (type === 'repay') remainingDebt -= q;
  if (type === 'add_collateral') remainingAda -= q;
  return validatePosition({
    ...position,
    collateral: {...position.collateral, amount: action.collateralAfter},
    debt: {...position.debt, amount: action.debtAfter},
    reserve: {collateral: amount(remainingAda), debt: amount(remainingDebt)},
  });
}
