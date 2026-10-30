import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { analyze, simulateAction, validatePosition, validatePolicy, DEFAULT_POLICY, createDemoPosition } from './risk.mjs';

const copy = value => structuredClone(value);
const roundPrice = value => Math.max(0.00000001, Math.round(value * 1e8) / 1e8);
const ceilBudget = value => Math.ceil(value * 1e8) / 1e8;
const floorBudget = value => Math.floor(value * 1e8) / 1e8;
const SCENARIOS = Object.freeze({ calm: 1, selloff: 0.70, crash: 0.53, recovery: 0.92 });
export class GuardianError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** One local simulation account. All mutations are synchronous and atomically persisted. */
export class GuardianStore {
  constructor({ file, clock = Date.now, intervalMs = 4000 } = {}) {
    this.file = file;
    this.clock = clock;
    this.intervalMs = intervalMs;
    this.state = this.fresh();
    if (file) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (saved.schemaVersion !== 1 || saved.mode !== 'simulation' || saved.position?.network !== 'simulation') throw new Error('Unsupported saved simulation');
        validatePosition(saved.position);
        validatePolicy(saved.policy);
        if (!Array.isArray(saved.history) || !Array.isArray(saved.events) || !saved.plans || !saved.executions ||
            !Number.isSafeInteger(saved.version) || !Number.isFinite(saved.stats?.spentUsd) || saved.stats.spentUsd < 0 ||
            !Number.isFinite(saved.basePrice) || saved.basePrice <= 0 || !Object.hasOwn(SCENARIOS, saved.monitor?.scenario)) {
          throw new Error('Invalid saved simulation');
        }
        this.state = saved;
        // Never restart unattended actions merely because the server restarted.
        this.state.monitor.running = false;
        this.state.plans = {};
        this.event('system', 'Simulation restored. Monitoring is paused; refresh prices before acting.');
        this.state.version++;
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Saved Guardian state is unreadable. Inspect it before recovery; it has not been overwritten.', { cause: error });
      }
      this.persist();
    }
  }

  fresh() {
    const now = this.clock();
    const position = createDemoPosition(now);
    const policy = copy(DEFAULT_POLICY);
    const metrics = analyze(position, policy, { now }).metrics;
    return {
      schemaVersion: 1, mode: 'simulation', sessionId: randomUUID(), version: 1,
      position, policy, basePrice: position.collateral.priceUsd,
      monitor: { running: false, scenario: 'calm', tick: 0, intervalMs: this.intervalMs },
      stats: { rescueCount: 0, spentUsd: 0, lastRescueAt: null },
      history: [{ timestamp: new Date(now).toISOString(), priceUsd: position.collateral.priceUsd, healthFactor: metrics.healthFactor }],
      events: [{ id: randomUUID(), timestamp: new Date(now).toISOString(), type: 'system', message: 'Demo ready. All balances, prices, and rescue actions are simulated.' }],
      plans: {}, executions: {},
    };
  }

  policy() {
    return { ...this.state.policy, maxSpendUsd: Math.max(0, floorBudget(this.state.policy.maxSpendUsd - this.state.stats.spentUsd)) };
  }

  analysis() { return analyze(this.state.position, this.policy(), { now: this.clock() }); }

  snapshot() {
    const { plans, executions, basePrice, ...visible } = this.state;
    return copy({ ...visible, analysis: this.analysis(), stats: { ...visible.stats, remainingBudgetUsd: this.policy().maxSpendUsd } });
  }

  persist() {
    if (!this.file) return;
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.file);
    chmodSync(this.file, 0o600);
  }

  mutate(action) {
    const previous = copy(this.state);
    try {
      const result = action();
      this.persist();
      return result;
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }

  event(type, message, details) {
    this.state.events.unshift({ id: randomUUID(), timestamp: new Date(this.clock()).toISOString(), type, message, ...(details ? { details } : {}) });
    this.state.events = this.state.events.slice(0, 250);
  }

  recordPoint() {
    const { metrics } = this.analysis();
    this.state.history.push({ timestamp: new Date(this.clock()).toISOString(), priceUsd: this.state.position.collateral.priceUsd, healthFactor: metrics.healthFactor });
    this.state.history = this.state.history.slice(-180);
  }

  changed() { this.state.version++; this.state.plans = {}; }

  setPolicy(input) {
    return this.mutate(() => {
      this.state.policy = validatePolicy(input);
      this.changed();
      this.event('policy', `Protection policy saved. ${this.state.policy.mode === 'automatic' ? 'Automatic simulation enabled' : 'Rescues require confirmation'}.`);
      return this.snapshot();
    });
  }

  setPosition(input) {
    return this.mutate(() => {
      const position = validatePosition(input);
      if (position.network !== 'simulation') throw new GuardianError('The dashboard supports simulated positions only. Live positions need a verified protocol adapter.');
      // Editing a local demo is a new sample observation, never evidence of on-chain freshness.
      position.priceUpdatedAt = new Date(this.clock()).toISOString();
      position.protocol = 'Guardian Sandbox';
      this.state.position = position;
      this.state.basePrice = position.collateral.priceUsd;
      this.state.monitor = { ...this.state.monitor, running: false, scenario: 'calm', tick: 0 };
      this.changed();
      this.recordPoint();
      this.event('position', 'Sample position updated. Monitoring paused; the session spending counter is preserved.');
      return this.snapshot();
    });
  }

  setScenario(scenario) {
    if (!Object.hasOwn(SCENARIOS, scenario)) throw new GuardianError('Choose calm, selloff, crash, or recovery.');
    return this.mutate(() => {
      this.state.monitor.scenario = scenario;
      this.state.monitor.tick = 0;
      this.state.position.collateral.priceUsd = roundPrice(this.state.basePrice * SCENARIOS[scenario]);
      this.state.position.priceUpdatedAt = new Date(this.clock()).toISOString();
      this.changed();
      this.recordPoint();
      this.event('scenario', `${scenario === 'selloff' ? 'Sell-off' : scenario[0].toUpperCase() + scenario.slice(1)} scenario applied. Price is simulated.`);
      this.autoRescue();
      return this.snapshot();
    });
  }

  setMonitor(running) {
    if (typeof running !== 'boolean') throw new GuardianError('running must be true or false.');
    return this.mutate(() => {
      this.state.monitor.running = running;
      if (running) this.state.position.priceUpdatedAt = new Date(this.clock()).toISOString();
      this.changed();
      this.event('monitor', running ? 'Simulation monitor started. Sample prices update every four seconds.' : 'Simulation monitor paused.');
      return this.snapshot();
    });
  }

  tick() {
    if (!this.state.monitor.running) return;
    this.mutate(() => {
      const monitor = this.state.monitor;
      monitor.tick++;
      // Deterministic, bounded sample curve. No exchange or oracle calls are made.
      const wave = 1 + Math.sin(monitor.tick * 0.7) * 0.008 + Math.sin(monitor.tick * 0.19) * 0.004;
      this.state.position.collateral.priceUsd = roundPrice(this.state.basePrice * SCENARIOS[monitor.scenario] * wave);
      this.state.position.priceUpdatedAt = new Date(this.clock()).toISOString();
      this.changed();
      this.recordPoint();
      this.autoRescue();
    });
  }

  assertCooldown() {
    const last = this.state.stats.lastRescueAt;
    if (last && this.clock() - Date.parse(last) < this.state.policy.cooldownSeconds * 1000) {
      throw new GuardianError('Rescue cooldown is active. Wait before another action.', 409);
    }
  }

  plan(type) {
    return this.mutate(() => {
      this.assertCooldown();
      const analysis = this.analysis();
      const action = type ? analysis.actions.find(a => a.type === type) : analysis.recommendation;
      if (!action) throw new GuardianError('No rescue is recommended for this position.');
      if (!action.feasible) throw new GuardianError(action.reason || 'This rescue is not feasible.');
      const after = simulateAction(this.state.position, this.policy(), action, { now: this.clock() });
      if (this.state.monitor.running) {
        this.state.monitor.running = false;
        this.event('monitor', 'Monitoring paused while you review the rescue preview.');
        this.changed();
      }
      const plan = {
        id: randomUUID(), version: this.state.version, action,
        createdAt: new Date(this.clock()).toISOString(), expiresAt: new Date(this.clock() + 30000).toISOString(),
        before: copy(this.state.position), after,
        beforeHealth: analysis.metrics.healthFactor,
        afterHealth: analyze(after, this.policy(), { now: this.clock() }).metrics.healthFactor,
        mode: 'simulation',
      };
      // A single pending quote per simulation account prevents accumulating stale plans.
      this.state.plans = { [plan.id]: plan };
      return { plan: copy(plan), state: this.snapshot() };
    });
  }

  execute(planId, key) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new GuardianError('An idempotency key of 8–100 safe characters is required.');
    if (typeof planId !== 'string') throw new GuardianError('A planId is required.');
    const prior = this.state.executions[key];
    if (prior) {
      if (prior.planId !== planId) throw new GuardianError('That idempotency key belongs to a different rescue.', 409);
      return { receipt: copy(prior), state: this.snapshot() };
    }
    return this.mutate(() => {
      const plan = this.state.plans[planId];
      if (!plan) throw new GuardianError('Preview no longer exists. Create a fresh rescue preview.', 409);
      if (plan.version !== this.state.version || this.clock() >= Date.parse(plan.expiresAt)) throw new GuardianError('Preview expired or position changed. Create a fresh rescue preview.', 409);
      this.assertCooldown();
      return { receipt: this.apply(plan.action.type, planId, key, 'manual'), state: this.snapshot() };
    });
  }

  apply(type, planId, key, initiatedBy) {
    const analysis = this.analysis();
    const action = analysis.actions.find(candidate => candidate.type === type);
    if (!action?.feasible) throw new GuardianError(action?.reason || 'Action is no longer feasible.', 409);
    const beforeHealth = analysis.metrics.healthFactor;
    this.state.position = simulateAction(this.state.position, this.policy(), type, { now: this.clock() });
    this.state.stats.spentUsd = ceilBudget(this.state.stats.spentUsd + action.costUsd);
    this.state.stats.rescueCount++;
    this.state.stats.lastRescueAt = new Date(this.clock()).toISOString();
    this.changed();
    const afterHealth = this.analysis().metrics.healthFactor;
    const receipt = {
      id: randomUUID(), planId, timestamp: this.state.stats.lastRescueAt,
      mode: 'simulation', status: 'simulated', initiatedBy,
      action: copy(action), beforeHealth, afterHealth,
      transactionHash: null, sellerPaymentVerified: false,
    };
    this.state.executions[key] = receipt;
    // Keep idempotency receipts for the session. Stop instead of dropping replay protection.
    if (Object.keys(this.state.executions).length > 1000) throw new GuardianError('Simulation session limit reached. Export your report, then reset.', 409);
    this.event('rescue', `Simulated ${type.replaceAll('_', ' ')} completed. No funds moved on-chain.`, receipt);
    this.recordPoint();
    return copy(receipt);
  }

  autoRescue() {
    if (this.state.policy.mode !== 'automatic' || !this.state.monitor.running) return;
    const last = this.state.stats.lastRescueAt;
    if (last && this.clock() - Date.parse(last) < this.state.policy.cooldownSeconds * 1000) return;
    const analysis = this.analysis();
    if (analysis.recommendation) {
      this.apply(analysis.recommendation.type, randomUUID(), `automatic-${randomUUID()}`, 'automatic');
    } else if (analysis.metrics.healthFactor !== null && analysis.metrics.healthFactor < this.state.policy.triggerHealth) {
      // Log an unresolved risk once, instead of flooding the activity feed each tick.
      if (this.state.events[0]?.type !== 'blocked') this.event('blocked', 'No automatic rescue fits the current reserve, fee, freshness, and remaining budget constraints.');
    }
  }

  reset() {
    return this.mutate(() => {
      this.state = this.fresh();
      return this.snapshot();
    });
  }

  report() {
    return {
      title: 'Liquidation Guardian simulation report', generatedAt: new Date(this.clock()).toISOString(),
      disclosure: 'Simulated positions, prices and rescues. This file is not proof of a blockchain transaction, seller payment, or protection of a live loan.',
      ...this.snapshot(), receipts: copy(Object.values(this.state.executions)),
    };
  }
}
