import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuardianStore } from './guardian/store.mjs';
import { DEFAULT_POLICY } from './guardian/risk.mjs';
import { integrationStatus } from './guardian/integrations.mjs';

const setup = () => {
  let time = Date.now();
  const store = new GuardianStore({ clock: () => time });
  store.setScenario('selloff');
  return { store, advance: seconds => time += seconds * 1000 };
};

test('duplicate rescue confirmations cannot deduct reserves twice', () => {
  const { store } = setup();
  const { plan } = store.plan('repay');
  const first = store.execute(plan.id, 'one-rescue-key');
  const second = store.execute(plan.id, 'one-rescue-key');
  assert.deepEqual(second, first);
  assert.equal(store.snapshot().stats.rescueCount, 1);
  assert.throws(() => store.execute(plan.id, 'different-rescue-key'), /no longer exists/);
});

test('a quote cannot execute after a price or policy change or expiry', () => {
  const { store, advance } = setup();
  let { plan } = store.plan('repay');
  store.setScenario('crash');
  assert.throws(() => store.execute(plan.id, 'changed-price-key'), /no longer exists/);
  store.setScenario('selloff');
  ({ plan } = store.plan('repay'));
  store.setPolicy({ ...DEFAULT_POLICY, maxSpendUsd: 0 });
  assert.throws(() => store.execute(plan.id, 'changed-policy-key'), /no longer exists/);
  store.setPolicy(DEFAULT_POLICY);
  ({ plan } = store.plan('repay'));
  advance(31);
  assert.throws(() => store.execute(plan.id, 'expired-plan-key'), /expired/);
  assert.equal(store.snapshot().stats.rescueCount, 0);
});

test('automatic rescues cannot reset the cumulative spending limit each tick', () => {
  const { store, advance } = setup();
  store.setPolicy({ ...DEFAULT_POLICY, mode: 'automatic', cooldownSeconds: 0 });
  store.setMonitor(true);
  store.tick();
  const first = store.snapshot();
  assert.equal(first.stats.rescueCount, 1);
  assert.ok(first.stats.spentUsd > 500 && first.stats.spentUsd <= 650);
  advance(5);
  store.setScenario('crash');
  for (let n = 0; n < 10; n++) { advance(4); store.tick(); }
  const after = store.snapshot();
  assert.equal(after.stats.rescueCount, 1);
  assert.equal(after.stats.spentUsd, first.stats.spentUsd);
  assert.equal(after.analysis.recommendation, null);
});

test('cooldown also blocks manual rescues and new previews', () => {
  const { store, advance } = setup();
  const position = store.snapshot().position;
  position.reserve.debt = 3000;
  store.setPosition(position);
  store.setPolicy({ ...DEFAULT_POLICY, maxSpendUsd: 3000 });
  const { plan } = store.plan('repay');
  store.execute(plan.id, 'cooldown-first');
  store.setScenario('crash');
  assert.throws(() => store.plan('repay'), /cooldown/);
  advance(31);
  assert.doesNotThrow(() => store.plan('repay'));
});

test('paused samples become stale instead of silently receiving a new timestamp', () => {
  const { store, advance } = setup();
  advance(61);
  assert.equal(store.snapshot().analysis.metrics.status, 'stale');
  assert.throws(() => store.plan('repay'), /stale/);
  assert.equal(store.snapshot().stats.rescueCount, 0);
});

test('restart preserves reserves and replay protection but cannot resume automation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-state-'));
  try {
    const file = join(dir, 'state.json');
    const store = new GuardianStore({ file });
    store.setScenario('selloff');
    const { plan } = store.plan('repay');
    const { receipt } = store.execute(plan.id, 'persistent-rescue');
    store.setPolicy({ ...DEFAULT_POLICY, mode: 'automatic' });
    store.setMonitor(true);
    const restored = new GuardianStore({ file });
    assert.equal(restored.snapshot().monitor.running, false);
    assert.equal(restored.snapshot().stats.rescueCount, 1);
    assert.deepEqual(restored.execute(plan.id, 'persistent-rescue').receipt, receipt);
    assert.equal(restored.snapshot().position.debt.amount, store.snapshot().position.debt.amount);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt saved state is never silently reset or overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-corrupt-'));
  try {
    const file = join(dir, 'state.json');
    writeFileSync(file, '{incomplete');
    assert.throws(() => new GuardianStore({ file }), /has not been overwritten/);
    assert.equal(readFileSync(file, 'utf8'), '{incomplete');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failed persistence rolls back the rescue instead of losing its idempotency record', () => {
  const { store } = setup();
  const { plan } = store.plan('repay');
  const before = store.snapshot();
  store.persist = () => { throw new Error('disk full'); };
  assert.throws(() => store.execute(plan.id, 'failed-save-key'), /disk full/);
  assert.deepEqual(store.snapshot(), before);
});

test('sub-microdollar fees cannot round cumulative spending down', () => {
  const { store } = setup();
  const position = store.snapshot().position;
  position.collateral.priceUsd = 0.45500001;
  store.setPosition(position);
  const { plan } = store.plan('repay');
  const { receipt, state } = store.execute(plan.id, 'precise-budget-key');
  assert.ok(state.stats.spentUsd >= receipt.action.costUsd);
  assert.ok(state.stats.remainingBudgetUsd + state.stats.spentUsd <= state.policy.maxSpendUsd + Number.EPSILON * 650);
});

test('saved configuration and completed tasks are not seller payment evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-evidence-'));
  try {
    mkdirSync(join(dir, 'docs'));
    mkdirSync(join(dir, '.local'));
    writeFileSync(join(dir, 'docs/registration-state.json'), JSON.stringify({ status: 'RegistrationConfirmed', secret: 'must-not-leak' }));
    writeFileSync(join(dir, '.local/task.json'), JSON.stringify({ phase: 'completed', paid: { stage: 'awaiting-withdrawal' } }));
    const result = integrationStatus({ root: dir, env: { COWORKER_ID: 'private-id', ZAI_API_KEY: 'private-secret' } });
    assert.equal(result.masumi.registered, true);
    assert.equal(result.masumi.sellerPaymentVerified, false);
    assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
    assert.equal(JSON.stringify(result).includes('private-secret'), false);
    assert.equal(JSON.stringify(result).includes('private-id'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
