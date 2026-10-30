import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuardianAgents } from './guardian/agent.mjs';

const ADA = 1_000_000n;
const PRICE = 500_000n;

function fakeChain() {
  const calls = [];
  const oracle = { price: PRICE, fresh: true, ageMs: 25 * 60_000 };
  return {
    calls,
    deployment: {},
    agentFor: owner => ({ address: `agent-of-${owner.slice(0, 2)}`, keyHash: `key-${owner.slice(0, 2)}` }),
    loanAddress: owner => `loan-of-${owner.slice(0, 2)}`,
    oracleView: async () => ({ oracle, operatorLovelace: 50n * ADA }),
    publishPrice: async price => { calls.push(['publish', price]); return { txHash: 'p' }; },
    agentView: async owner => ({
      oracle,
      // Health 0.8 at PRICE: below every trigger.
      loans: [{ utxo: { txHash: owner.slice(0, 2), outputIndex: 0 }, collateral: 100n * ADA, debt: 50n * ADA }],
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
  assert.deepEqual(chain.calls, [['publish', PRICE], ['rescue', 'aa'], ['rescue', 'bb']]);

  // State survives a restart, per customer.
  const restarted = new GuardianAgents({ chain, dir, market });
  assert.equal(restarted.running.length, 2);
  assert.notEqual(restarted.get(alice.ownerKeyHash).snapshot().agentAddress, restarted.get(bob.ownerKeyHash).snapshot().agentAddress);
});
