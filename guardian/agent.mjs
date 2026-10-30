import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { healthBps, collateralFor, ADA, VAULT_KEEP, OPERATOR_FLOOR, MAX_PRICE_AGE_MS } from './chain.mjs';
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

/**
 * The autonomous loop. Every tick it reads live market prices, keeps the
 * on-chain oracle current, and tops up the owner's loan from the vault when
 * health falls below the trigger. Contracts enforce every limit; this loop
 * only decides when to ask.
 */
export class GuardianAgent {
  constructor({ chain, file, market = marketPrice, clock = Date.now, intervalMs = 60_000 }) {
    this.chain = chain;
    this.file = file;
    this.market = market;
    this.clock = clock;
    this.intervalMs = intervalMs;
    this.state = { running: false, owner: null, policy: { ...DEFAULT_POLICY }, events: [], lastRescue: null, lastCheck: null };
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      this.state = { ...this.state, ...saved, policy: validatePolicy(saved.policy) };
      if (this.state.running) this.event('system', 'Server restarted. The agent resumed with its saved owner and policy.');
    }
    this.ticking = false;
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

  snapshot() { return JSON.parse(JSON.stringify({ ...this.state, intervalMs: this.intervalMs }, (_, v) => typeof v === 'bigint' ? v.toString() : v)); }

  async start(wallet) {
    const view = await this.chain.agentView(wallet.ownerKeyHash);
    if (!view.oracle) throw new GuardianError('Deploy the price oracle first.', 409);
    if (!view.loans.length) throw new GuardianError('Open a loan first. The agent protects a real loan.', 409);
    if (!view.mandate) throw new GuardianError('Sign a mandate and fund the vault first.', 409);
    if (!view.mandate.recipients.includes(this.chain.loanAddress(wallet.ownerKeyHash))) throw new GuardianError('Your mandate predates the loan contract. Withdraw and sign a new mandate.', 409);
    this.state.running = true;
    this.state.owner = { address: wallet.address, ownerKeyHash: wallet.ownerKeyHash };
    this.event('agent', `Agent started. It checks prices and your loan every ${Math.round(this.intervalMs / 1000)} seconds.`);
    this.tick();
  }

  stop() {
    this.state.running = false;
    this.event('agent', 'Agent stopped. The oracle is no longer refreshed and no rescues are sent.');
  }

  setPolicy(input) {
    this.state.policy = validatePolicy(input);
    this.event('policy', `Policy saved: act below health ${this.state.policy.triggerHealth}, restore to ${this.state.policy.targetHealth}.`);
  }

  async tick() {
    if (!this.state.running || this.ticking) return;
    this.ticking = true;
    try { await this.check(); } catch (error) {
      const message = String(error?.message || error).slice(0, 300);
      if (this.state.events[0]?.message !== message) this.event('error', message);
    } finally { this.ticking = false; }
  }

  async check() {
    const owner = this.state.owner;
    const market = await this.market();
    const view = await this.chain.agentView(owner.ownerKeyHash);
    const now = this.clock();

    // 1. Keep the oracle near the market so liquidation and borrowing use a real price.
    if (market.ok && view.oracle) {
      const moved = Math.abs(Number(market.priceMicro - view.oracle.price)) / Number(view.oracle.price);
      if (moved >= ORACLE_MOVE || view.oracle.ageMs >= ORACLE_REFRESH_MS) {
        if (view.operatorLovelace < OPERATOR_FLOOR) {
          this.once('oracle', 'The oracle operator wallet is low on ADA. Fund it from setup step 2.');
        } else {
          const { txHash } = await this.chain.publishPrice(market.priceMicro);
          this.event('oracle', `Published $${market.priceUsd.toFixed(5)} on-chain (${(moved * 100).toFixed(2)}% move, previous price ${Math.round(view.oracle.ageMs / 60000)} min old).`, { txHash });
        }
      }
    } else if (!market.ok) this.once('market', `Market price unavailable: ${market.reason}`);

    // 2. Protect the loan. Use the lower of oracle and market prices: the
    //    oracle decides liquidation, the market shows where it is heading.
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
      const result = await this.chain.agentRescue(owner.ownerKeyHash, amount);
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

  /** Log a repeating condition once instead of on every tick. */
  once(type, message) {
    if (this.state.events[0]?.message !== message) this.event(type, message);
  }
}

export { MAX_PRICE_AGE_MS };
