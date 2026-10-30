import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyze, simulateAction, createDemoPosition, validatePolicy, validatePosition, DEFAULT_POLICY} from './guardian/risk.mjs';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
function endangered() {
  const position = createDemoPosition(NOW);
  position.collateral.priceUsd = 0.455;
  return position;
}
const actionOf = (position, policy, type) => analyze(position, policy, {now: NOW}).actions.find(action => action.type === type);

test('regression: rounded-down repayment misses the target health factor', () => {
  const position = endangered();
  const action = actionOf(position, DEFAULT_POLICY, 'repay');
  assert.equal(action.feasible, true);
  assert.equal(action.amount, 573.333334);
  assert.ok(action.projectedHealthFactor >= 1.5);
  const after = simulateAction(position, DEFAULT_POLICY, 'repay', {now: NOW});
  assert.equal(after.debt.amount, 2426.666666);
  assert.equal(after.reserve.debt, 426.666666);
  assert.equal(after.reserve.collateral, 1999.7);
  assert.ok(analyze(after, DEFAULT_POLICY, {now: NOW}).metrics.healthFactor >= 1.5);
});

test('regression: rounded-down collateral top-up misses the target', () => {
  const position = endangered();
  position.reserve.collateral = 5000;
  const policy = {...DEFAULT_POLICY, maxSpendUsd: 2000};
  const action = actionOf(position, policy, 'add_collateral');
  assert.equal(action.feasible, true);
  assert.equal(action.amount, 2362.637363);
  assert.ok(action.projectedHealthFactor >= 1.5);
  const after = simulateAction(position, policy, 'add_collateral', {now: NOW});
  assert.equal(after.reserve.collateral, 2637.062637);
  assert.equal(after.collateral.amount, 12362.637363);
});

test('regression: stale or future prices enable a rescue', () => {
  for (const offset of [-61_000, 6_000]) {
    const position = endangered();
    position.priceUpdatedAt = new Date(NOW + offset).toISOString();
    const analysis = analyze(position, DEFAULT_POLICY, {now: NOW});
    assert.equal(analysis.metrics.status, 'stale');
    assert.equal(analysis.metrics.riskStatus, 'critical');
    assert.equal(analysis.recommendation, null);
    assert.ok(analysis.actions.every(action => !action.feasible));
    assert.throws(() => simulateAction(position, DEFAULT_POLICY, 'repay', {now: NOW}), /stale|future/);
  }
});

test('regression: repayment ignores the ADA fee and protected reserve', () => {
  const position = endangered();
  position.reserve.collateral = 5.299999;
  const result = analyze(position, DEFAULT_POLICY, {now: NOW});
  assert.ok(result.actions.every(action => !action.feasible));
  assert.match(actionOf(position, DEFAULT_POLICY, 'repay').reason, /fee and protected reserve/);
  position.reserve.collateral = 5.3;
  assert.equal(actionOf(position, DEFAULT_POLICY, 'repay').feasible, true);
  const after = simulateAction(position, DEFAULT_POLICY, 'repay', {now: NOW});
  assert.equal(after.reserve.collateral, 5);
});

test('regression: fee exclusion permits spending above the exact USD cap', () => {
  const position = endangered();
  const cost = actionOf(position, DEFAULT_POLICY, 'repay').costUsd;
  assert.equal(cost, 573.469834);
  assert.equal(actionOf(position, {...DEFAULT_POLICY, maxSpendUsd: cost}, 'repay').feasible, true);
  assert.equal(actionOf(position, {...DEFAULT_POLICY, maxSpendUsd: cost - 0.000001}, 'repay').feasible, false);
  assert.equal(actionOf(position, {...DEFAULT_POLICY, maxSpendUsd: 573.333334}, 'repay').feasible, false);
});

test('regression: arbitrary negative, NaN, zero-price, and excessive-precision inputs corrupt loan math', () => {
  for (const bad of [-1, NaN, Infinity, '100', null]) {
    const position = endangered();
    position.debt.amount = bad;
    assert.throws(() => validatePosition(position), /debt.amount/);
  }
  for (const bad of [0, -1, NaN, 0.000000001]) {
    const position = endangered();
    position.collateral.priceUsd = bad;
    assert.throws(() => validatePosition(position), /collateral.priceUsd/);
  }
  const position = endangered();
  position.reserve.debt = 1.0000001;
  assert.throws(() => validatePosition(position), /decimal places/);
  assert.throws(() => validatePolicy({targetHealth: 1.2}), /targetHealth/);
  assert.throws(() => validatePolicy({slippageBps: 10000}), /slippageBps/);
  assert.throws(() => validatePolicy({mode: 'mainnet'}), /mode/);
  assert.throws(() => analyze(endangered(), {}, {now: NaN}), /timestamp/);
});

test('regression: ordinary slider floating-point artifacts invalidate valid prices', () => {
  const position = endangered();
  position.collateral.priceUsd = 0.65 * 0.7;
  assert.equal(validatePosition(position).collateral.priceUsd, 0.455);
});

test('regression: zero debt yields Infinity and triggers needless spending', () => {
  const position = endangered();
  position.debt.amount = 0;
  const analysis = analyze(position, DEFAULT_POLICY, {now: NOW});
  assert.equal(analysis.metrics.healthFactor, null);
  assert.equal(analysis.metrics.status, 'debt_free');
  assert.equal(analysis.metrics.liquidationPriceUsd, null);
  assert.equal(analysis.metrics.priceBufferPct, null);
  assert.equal(analysis.recommendation, null);
  assert.ok(analysis.actions.every(action => !action.feasible));
  assert.throws(() => simulateAction(position, DEFAULT_POLICY, 'repay', {now: NOW}), /no debt/);
  assert.doesNotMatch(JSON.stringify(analysis), /Infinity|NaN/);
});

test('regression: partial unwind lowers health or creates unearned debt tokens', () => {
  const position = endangered();
  const policy = {...DEFAULT_POLICY, maxSpendUsd: 2000};
  const action = actionOf(position, policy, 'unwind');
  assert.equal(action.feasible, true);
  assert.equal(action.simulationOnly, true);
  assert.match(action.executionRequirement, /atomic/);
  const grossProceeds = action.amount * position.collateral.priceUsd * (1 - policy.slippageBps / 10000);
  assert.ok(action.debtRepaidAmount <= grossProceeds + 1e-10);
  assert.ok(action.projectedHealthFactor >= policy.targetHealth);
  const after = simulateAction(position, policy, 'unwind', {now: NOW});
  assert.ok(after.collateral.amount < position.collateral.amount);
  assert.ok(after.debt.amount < position.debt.amount);
  assert.equal(after.reserve.debt, position.reserve.debt);
  assert.equal(after.reserve.collateral, position.reserve.collateral - policy.feeAda);
  assert.ok(analyze(after, policy, {now: NOW}).metrics.healthFactor >= policy.targetHealth);
});

test('regression: insolvent or high-slippage unwind pretends to rescue the position', () => {
  const position = endangered();
  position.collateral.priceUsd = 0.25;
  const policy = {...DEFAULT_POLICY, maxSpendUsd: 10000};
  assert.equal(actionOf(position, policy, 'unwind').feasible, false);
  assert.equal(actionOf(endangered(), {...policy, slippageBps: 5000}, 'unwind').feasible, false);
});

test('regression: a forged client action spends arbitrary amounts or changes a live snapshot', () => {
  const position = endangered();
  const before = JSON.stringify(position);
  const after = simulateAction(position, DEFAULT_POLICY, {type: 'repay', amount: -1_000_000, costUsd: 0, feasible: true}, {now: NOW});
  assert.equal(after.debt.amount, 2426.666666);
  assert.equal(JSON.stringify(position), before);
  position.network = 'preprod';
  assert.equal(analyze(position, DEFAULT_POLICY, {now: NOW}).metrics.riskStatus, 'critical');
  assert.throws(() => simulateAction(position, DEFAULT_POLICY, 'repay', {now: NOW}), /Only simulation/);
  assert.equal(actionOf(position, {...DEFAULT_POLICY, maxSpendUsd: 2000}, 'unwind').feasible, false);
});

test('regression: a healthy position triggers automatic rescue before its threshold', () => {
  const position = createDemoPosition(NOW);
  position.collateral.priceUsd = 0.5;
  const analysis = analyze(position, DEFAULT_POLICY, {now: NOW});
  assert.equal(analysis.metrics.status, 'warning');
  assert.ok(analysis.actions.some(action => action.feasible));
  assert.equal(analysis.recommendation, null);
  position.collateral.priceUsd = 0.46875;
  assert.equal(analyze(position, DEFAULT_POLICY, {now: NOW}).recommendation, null);
});

test('regression: preferred rescue selection suppresses a feasible fallback', () => {
  const result = analyze(endangered(), {...DEFAULT_POLICY, preferredAction: 'add_collateral'}, {now: NOW});
  assert.equal(result.recommendation.type, 'repay');
  assert.ok(result.warnings.some(warning => warning.includes('Preferred action')));
});

test('regression: liquidation boundary and price buffer disagree', () => {
  const position = endangered();
  position.collateral.priceUsd = 0.375;
  const result = analyze(position, DEFAULT_POLICY, {now: NOW});
  assert.equal(result.metrics.healthFactor, 1);
  assert.equal(result.metrics.status, 'liquidatable');
  assert.equal(result.metrics.liquidationPriceUsd, 0.375);
  assert.equal(result.metrics.priceBufferPct, 0);
});
