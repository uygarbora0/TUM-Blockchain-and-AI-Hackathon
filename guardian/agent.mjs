import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { healthBps, collateralFor, ADA, VAULT_KEEP, ORACLE_PAYER_FLOOR, MAX_PRICE_AGE_MS, KEY_HASH } from './chain.mjs';
import { marketPrice } from './prices.mjs';
import { GuardianError } from './errors.mjs';

export const DEFAULT_POLICY = Object.freeze({ triggerHealth: 1.25, targetHealth: 1.4 });
// Republish the oracle when the market moves this much, or before it gets stale.
const ORACLE_MOVE = 0.005;
const ORACLE_REFRESH_MS = 20 * 60_000;
// After a rescue, wait for it to confirm instead of sending another.
const RESCUE_SETTLE_MS = 4 * 60_000;
const MIN_RESCUE = 1n * ADA;

export function validatePolicy(input = {}) {
  const policy = { ...DEFAULT_POLICY, ...input };
  const { triggerHealth, targetHealth } = policy;
  if (typeof triggerHealth !== 'number' || typeof targetHealth !== 'number' || !(triggerHealth > 1) || !(targetHealth > triggerHealth) || targetHealth > 5) {
    throw new GuardianError('Trigger health must be above 1.0, and target health above the trigger (at most 5).');
  }
  return { triggerHealth: Math.round(triggerHealth * 100) / 100, targetHealth: Math.round(targetHealth * 100) / 100 };
}

/** Persisted state with an event log, shared by the agents and the oracle keeper. */
class Journal {
  constructor({ file, clock, state }) {
    this.file = file;
    this.clock = clock;
    this.state = state;
    if (file && existsSync(file)) this.state = { ...this.state, ...JSON.parse(readFileSync(file, 'utf8')) };
  }

  persist() {
    if (!this.file) return;
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, (_, v) => typeof v === 'bigint' ? v.toString() : v), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  event(type, message, details = {}) {
    this.state.events.unshift({ id: randomUUID(), at: new Date(this.clock()).toISOString(), type, message, ...details });
    this.state.events = this.state.events.slice(0, 200);
    this.persist();
  }

  /** Log a repeating condition once instead of on every tick. */
  once(type, message) {
    if (this.state.events[0]?.message !== message) this.event(type, message);
  }

  snapshot(extra = {}) { return JSON.parse(JSON.stringify({ ...this.state, ...extra }, (_, v) => typeof v === 'bigint' ? v.toString() : v)); }
}

/**
 * One customer's agent, with its own key, policy and log. Every tick it tops
 * up the owner's loan from their vault when health falls below the trigger.
 * Contracts enforce every limit; this loop only decides when to ask.
 */
export class GuardianAgent extends Journal {
  constructor({ chain, ownerKeyHash, file, clock = Date.now, intervalMs = 60_000 }) {
    super({ file, clock, state: { running: false, owner: null, policy: { ...DEFAULT_POLICY }, events: [], lastRescue: null, lastCheck: null } });
    this.chain = chain;
    this.ownerKeyHash = ownerKeyHash;
    this.intervalMs = intervalMs;
    this.state.policy = validatePolicy(this.state.policy);
    if (this.state.running) this.event('system', 'Server restarted. The agent resumed with its saved owner and policy.');
    this.ticking = false;
  }

  snapshot() { return super.snapshot({ intervalMs: this.intervalMs, agentAddress: this.chain.agentFor(this.ownerKeyHash).address }); }

  async start(wallet) {
    if (wallet.ownerKeyHash !== this.ownerKeyHash) throw new GuardianError('This agent belongs to another wallet.', 403);
    const view = await this.chain.agentView(wallet.ownerKeyHash);
    if (!view.oracle) throw new GuardianError('Deploy the price oracle first.', 409);
    if (!view.loans.length) throw new GuardianError('Open a loan first. The agent protects a real loan.', 409);
    if (!view.mandate) throw new GuardianError('Sign a mandate for your agent and fund the vault first.', 409);
    if (!view.mandate.recipients.includes(this.chain.loanAddress(wallet.ownerKeyHash))) throw new GuardianError('Your mandate predates the loan contract. Withdraw and sign a new mandate.', 409);
    this.state.running = true;
    this.state.owner = { address: wallet.address, ownerKeyHash: wallet.ownerKeyHash };
    this.event('agent', `Agent started. It checks prices and your loan every ${Math.round(this.intervalMs / 1000)} seconds.`);
  }

  stop() {
    this.state.running = false;
    this.event('agent', 'Agent stopped. No rescues are sent for your loan.');
  }

  setPolicy(input) {
    this.state.policy = validatePolicy(input);
    this.event('policy', `Policy saved: act below health ${this.state.policy.triggerHealth}, restore to ${this.state.policy.targetHealth}.`);
  }

  async tick(market, shared) {
    if (!this.state.running || this.ticking) return;
    this.ticking = true;
    try { await this.check(market, shared); } catch (error) {
      this.once('error', String(error?.message || error).slice(0, 300));
    } finally { this.ticking = false; }
  }

  async check(market, shared) {
    const view = await this.chain.agentView(this.ownerKeyHash, shared);
    const now = this.clock();
    if (!market.ok) this.once('market', `Market price unavailable: ${market.reason}`);

    // Use the lower of oracle and market prices: the oracle decides
    // liquidation, the market shows where it is heading.
    const prices = [view.oracle?.fresh ? view.oracle.price : null, market.ok ? market.priceMicro : null].filter(Boolean);
    const loans = view.loans.map(loan => {
      const worst = prices.length ? prices.reduce((a, b) => (a < b ? a : b)) : null;
      return { ref: `${loan.utxo.txHash}#${loan.utxo.outputIndex}`, collateral: loan.collateral, debt: loan.debt, worstPrice: worst, healthBps: worst ? healthBps(loan.collateral, loan.debt, worst) : null };
    });
    this.state.lastCheck = { at: new Date(now).toISOString(), market: market.ok ? { priceUsd: market.priceUsd, quotes: market.quotes } : { reason: market.reason, quotes: market.quotes }, oraclePrice: view.oracle?.price ?? null, oracleAgeMs: view.oracle?.ageMs ?? null, loans, allowance: view.allowance, vaultLovelace: view.vaultLovelace };

    const policy = this.state.policy;
    for (const loan of loans) {
      if (loan.healthBps === null || loan.healthBps >= BigInt(Math.round(policy.triggerHealth * 10000))) continue;
      const settling = this.state.lastRescue && now - Date.parse(this.state.lastRescue.at) < RESCUE_SETTLE_MS && this.state.lastRescue.loanRef === loan.ref;
      if (settling) continue;
      const needed = collateralFor(BigInt(Math.round(policy.targetHealth * 10000)), loan.debt, loan.worstPrice) - loan.collateral;
      const available = view.vaultLovelace - VAULT_KEEP;
      let amount = needed;
      if (amount > view.allowance) amount = view.allowance;
      if (amount > available) amount = available;
      const health = (Number(loan.healthBps) / 10000).toFixed(3);
      if (amount < MIN_RESCUE) {
        this.once('blocked', `Health ${health} is below ${policy.triggerHealth}, but the mandate allowance or vault balance leaves no room for a rescue. Add funds or raise the limits.`);
        continue;
      }
      const result = await this.chain.agentRescue(this.ownerKeyHash, amount);
      const partial = amount < needed ? ` Partial: the full rescue needs ${(Number(needed) / 1e6).toFixed(2)} ADA, capped by the mandate or vault.` : '';
      if (result.status === 'submitted') {
        this.state.lastRescue = { at: new Date(now).toISOString(), loanRef: result.loanRef, txHash: result.txHash };
        this.event('rescue', `Health ${health} was below ${policy.triggerHealth}. Added ${(Number(amount) / 1e6).toFixed(2)} ADA collateral from the vault.${partial}`, { txHash: result.txHash });
      } else {
        this.event('blocked', `Rescue at health ${health} not sent: ${result.reason}`);
      }
    }
    this.persist();
  }
}

/**
 * Keeps the one shared on-chain oracle near the market so every customer's
 * loan is valued, borrowed against and liquidated at a real price. Customers
 * pay for it: each refresh is paid by the running agent whose fee wallet paid
 * least recently; the operator key only signs.
 */
export class OracleKeeper extends Journal {
  constructor({ chain, file, clock = Date.now }) {
    super({ file, clock, state: { events: [], paidAt: {} } });
    this.chain = chain;
  }

  /** Returns `{ oracle }` as read this tick so agents can reuse it, or `{}` when nothing was read. */
  async read() {
    if (!this.chain.deployment) return {};
    try { return { oracle: (await this.chain.oracleView()).oracle }; } catch (error) {
      this.once('error', `Oracle: ${String(error?.message || error).slice(0, 300)}`);
      return {};
    }
  }

  async tick(market, oracle, payers) {
    try { await this.check(market, oracle, payers); } catch (error) {
      this.once('error', `Oracle: ${String(error?.message || error).slice(0, 300)}`);
    }
  }

  async check(market, oracle, payers) {
    if (!market.ok || !oracle) return;
    const moved = Math.abs(Number(market.priceMicro - oracle.price)) / Number(oracle.price);
    if (moved < ORACLE_MOVE && oracle.ageMs < ORACLE_REFRESH_MS) return;
    const turns = [...payers].sort((a, b) => (this.state.paidAt[a] ?? '').localeCompare(this.state.paidAt[b] ?? ''));
    for (const owner of turns) {
      if (await this.chain.agentLovelace(owner) < ORACLE_PAYER_FLOOR) continue;
      const { txHash } = await this.chain.publishPrice(market.priceMicro, owner);
      this.state.paidAt[owner] = new Date(this.clock()).toISOString();
      this.event('oracle', `Published $${market.priceUsd.toFixed(5)} on-chain (${(moved * 100).toFixed(2)}% move, previous price ${Math.round(oracle.ageMs / 60000)} min old), paid by agent ${owner.slice(0, 8)}…`, { txHash, payer: owner });
      return;
    }
    this.once('oracle', `The oracle needs a refresh, but no running agent's fee wallet has ${Number(ORACLE_PAYER_FLOOR / ADA)}+ ADA to pay for it. Customers top up their agent fee wallet from the dashboard.`);
  }
}

// Before per-customer agents there was one shared key. Hand it to the owner it
// was serving, so their existing mandate and funded fee wallet keep working.
function adoptSharedAgent(dir, agentsDir) {
  const key = join(dir, 'agent-key.json');
  const state = join(dir, 'agent-state.json');
  if (!existsSync(key) || !existsSync(state)) return;
  const owner = JSON.parse(readFileSync(state, 'utf8')).owner?.ownerKeyHash;
  if (!KEY_HASH.test(owner ?? '') || existsSync(join(agentsDir, owner, 'agent-key.json'))) return;
  mkdirSync(join(agentsDir, owner), { recursive: true, mode: 0o700 });
  renameSync(key, join(agentsDir, owner, 'agent-key.json'));
  renameSync(state, join(agentsDir, owner, 'state.json'));
}

/**
 * Every customer's agent plus the shared oracle keeper. One tick fetches the
 * market and reads the oracle once, refreshes it, then checks each running
 * agent, which keeps Blockfrost use to two reads per customer per tick.
 */
export class GuardianAgents {
  constructor({ chain, dir, market = marketPrice, clock = Date.now, intervalMs = 60_000 }) {
    this.chain = chain;
    this.market = market;
    this.clock = clock;
    this.intervalMs = intervalMs;
    this.dir = join(dir, 'agents');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    adoptSharedAgent(dir, this.dir);
    this.keeper = new OracleKeeper({ chain, file: join(dir, 'oracle-keeper.json'), clock });
    this.agents = new Map();
    for (const name of readdirSync(this.dir)) if (KEY_HASH.test(name) && existsSync(join(this.dir, name, 'state.json'))) this.get(name);
    this.ticking = false;
  }

  /** This owner's agent, created on first use. */
  get(ownerKeyHash) {
    if (!KEY_HASH.test(ownerKeyHash)) throw new GuardianError('Owner key hash is invalid.');
    let agent = this.agents.get(ownerKeyHash);
    if (!agent) {
      mkdirSync(join(this.dir, ownerKeyHash), { recursive: true, mode: 0o700 });
      agent = new GuardianAgent({ chain: this.chain, ownerKeyHash, file: join(this.dir, ownerKeyHash, 'state.json'), clock: this.clock, intervalMs: this.intervalMs });
      this.agents.set(ownerKeyHash, agent);
    }
    return agent;
  }

  get running() { return [...this.agents.values()].filter(agent => agent.state.running); }

  async start(wallet) {
    const agent = this.get(wallet.ownerKeyHash);
    await agent.start(wallet);
    this.tick();
    return agent.snapshot();
  }

  /**
   * The oracle is refreshed only while at least one customer's agent runs.
   * Rescues go first; the refresh is then paid by an agent with no rescue still
   * confirming, so the two never spend the same fee-wallet output.
   */
  async tick() {
    const running = this.running;
    if (this.ticking || !running.length) return;
    this.ticking = true;
    try {
      const market = await this.market();
      const shared = await this.keeper.read();
      for (const agent of running) await agent.tick(market, shared);
      const now = this.clock();
      const payers = running.filter(agent => !agent.state.lastRescue || now - Date.parse(agent.state.lastRescue.at) >= RESCUE_SETTLE_MS).map(agent => agent.ownerKeyHash);
      await this.keeper.tick(market, shared.oracle, payers);
    } finally { this.ticking = false; }
  }
}

export { MAX_PRICE_AGE_MS };
