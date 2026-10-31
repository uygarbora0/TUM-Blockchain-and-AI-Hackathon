import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuardianAgents } from './guardian/agent.mjs';

const ADA = 1_000_000n;
const PRICE = 500_000n;

function fakeChain({ health = 'low', balances = {} } = {}) {
  const calls = [];
  const oracle = { price: PRICE, fresh: true, ageMs: 25 * 60_000 };
  return {
    calls,
    deployment: {},
    agentFor: owner => ({ address: `agent-of-${owner.slice(0, 2)}`, keyHash: `key-${owner.slice(0, 2)}` }),
    loanAddress: owner => `loan-of-${owner.slice(0, 2)}`,
    oracleView: async () => ({ oracle }),
    agentLovelace: async owner => balances[owner.slice(0, 2)] ?? 15n * ADA,
    publishPrice: async (price, payer) => { calls.push(['publish', price, payer.slice(0, 2)]); return { txHash: 'p' }; },
    agentView: async owner => ({
      oracle,
      // Health 0.8 at PRICE: below every trigger.
      loans: [{ utxo: { txHash: owner.slice(0, 2), outputIndex: 0 }, collateral: health === 'low' ? 100n * ADA : 1000n * ADA, debt: 50n * ADA }],
      mandate: { recipients: [`loan-of-${owner.slice(0, 2)}`] },
      vaultLovelace: 500n * ADA, allowance: 500n * ADA,
    }),
    agentRescue: async (owner, amount) => { calls.push(['rescue', owner.slice(0, 2)]); return { status: 'submitted', txHash: 't', loanRef: `${owner.slice(0, 2)}#0` }; },
  };
}

test('a second customer starting their agent does not replace the first', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-agents-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const chain = fakeChain();
  const market = async () => ({ ok: true, priceUsd: 0.5, priceMicro: PRICE, quotes: [] });
  const agents = new GuardianAgents({ chain, dir, market });
  const alice = { address: 'addr-a', ownerKeyHash: 'a'.repeat(56) };
  const bob = { address: 'addr-b', ownerKeyHash: 'b'.repeat(56) };

  await agents.start(alice);
  await agents.start(bob);
  while (agents.ticking) await new Promise(resolve => setImmediate(resolve));
  chain.calls.length = 0;
  agents.agents.forEach(agent => { agent.state.lastRescue = null; });
  await agents.tick();

  assert.deepEqual(agents.running.map(agent => agent.ownerKeyHash).sort(), [alice.ownerKeyHash, bob.ownerKeyHash]);
  // Both agents just sent rescues, so neither fee wallet pays the oracle refresh this tick.
  assert.deepEqual(chain.calls, [['rescue', 'aa'], ['rescue', 'bb']]);

  // State survives a restart, per customer.
  const restarted = new GuardianAgents({ chain, dir, market });
  assert.equal(restarted.running.length, 2);
  assert.notEqual(restarted.get(alice.ownerKeyHash).snapshot().agentAddress, restarted.get(bob.ownerKeyHash).snapshot().agentAddress);
});

test('customers pay oracle refreshes in turn; a low fee wallet is skipped', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-agents-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const balances = {};
  const chain = fakeChain({ health: 'safe', balances });
  const market = async () => ({ ok: true, priceUsd: 0.5, priceMicro: PRICE, quotes: [] });
  let now = Date.parse('2026-10-31T12:00:00Z');
  const agents = new GuardianAgents({ chain, dir, market, clock: () => now });
  await agents.start({ address: 'addr-a', ownerKeyHash: 'a'.repeat(56) });
  await agents.start({ address: 'addr-b', ownerKeyHash: 'b'.repeat(56) });
  while (agents.ticking) await new Promise(resolve => setImmediate(resolve));
  chain.calls.length = 0;
  for (const _ of [1, 2, 3]) { now += 60_000; await agents.tick(); }
  assert.equal(chain.calls.length, 3);
  assert.notEqual(chain.calls[0][2], chain.calls[1][2]);
  assert.equal(chain.calls[0][2], chain.calls[2][2]);
  balances.bb = 6n * ADA;
  chain.calls.length = 0;
  for (const _ of [1, 2]) { now += 60_000; await agents.tick(); }
  assert.deepEqual(chain.calls.map(call => call[2]), ['aa', 'aa']);
  balances.aa = 6n * ADA;
  chain.calls.length = 0;
  now += 60_000; await agents.tick();
  assert.deepEqual(chain.calls, []);
  assert.match(agents.keeper.state.events[0].message, /no running agent's fee wallet/);
});
