import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { createGuardianServer } from './guardian-server.mjs';
import { GuardianError } from './guardian/errors.mjs';

async function serverFixture(t) {
  const calls = [];
  const chain = {
    network: 'Preprod',
    overview: async wallet => ({ wallet }),
    wallet: body => { if (!body.changeAddress) throw new GuardianError('Wallet address is invalid.'); return { address: body.changeAddress, addresses: [body.changeAddress], ownerKeyHash: body.changeAddress.slice(-1).repeat(56) }; },
    // Stands in for CIP-30 signData: a wallet "signs" by echoing its payload.
    verifyOwnership: (wallet, payload, signed) => signed.signature === payload && signed.key === wallet.ownerKeyHash,
    buildWithdraw: async wallet => { calls.push(['withdraw', wallet.address]); return { txHash: 'h', txCbor: '00' }; },
    deployOracle: async price => { calls.push(['deploy', price]); return { txHash: 'd' }; },
  };
  const owned = new Map();
  const agents = {
    get: owner => {
      if (!owned.has(owner)) owned.set(owner, { running: true, snapshot() { return { running: this.running }; }, stop() { this.running = false; }, setPolicy() {} });
      return owned.get(owner);
    },
    start: async wallet => agents.get(wallet.ownerKeyHash).snapshot(),
    keeper: { snapshot: () => ({ events: [] }) },
  };
  const market = async () => ({ ok: false, reason: 'offline' });
  const server = createGuardianServer({ chain, agents, market });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-guardian-client': 'dashboard', ...headers }, body: JSON.stringify(body) });
  // Full sign-in as one browser: its own cookie, a challenge, then the signature.
  const signIn = async (changeAddress, signer = changeAddress) => {
    const challenge = await post('/api/wallet/challenge', { changeAddress });
    const cookie = challenge.headers.get('set-cookie').split(';')[0];
    const { payload } = await challenge.json();
    const connect = await post('/api/wallet/connect', { signature: payload, key: signer.slice(-1).repeat(56) }, { cookie });
    return { cookie, status: connect.status };
  };
  return { base, post, calls, agents, signIn };
}

test('cross-origin pages cannot build transactions or read private files', async t => {
  const { base, post, calls } = await serverFixture(t);
  assert.equal((await post('/api/wallet/connect', { changeAddress: 'addr_test1x' }, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post('/api/vault/withdraw', {}, { 'x-guardian-client': '' })).status, 403);
  // Fetch normalizes Host to the URL authority; raw HTTP actually sends the hostile header.
  const hostileHostStatus = await new Promise((resolve, reject) => {
    get(base + '/api/status', { headers: { host: 'untrusted.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(base + '/.env')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e%2f.env')).status, 404);
  assert.deepEqual(calls, []);
});

test('owner transactions need a connected wallet and well-formed JSON', async t => {
  const { base, post, calls, signIn } = await serverFixture(t);
  assert.equal((await post('/api/vault/withdraw', {})).status, 409);
  const malformed = await fetch(base + '/api/wallet/connect', { method: 'POST', headers: { 'content-type': 'application/json', 'x-guardian-client': 'dashboard' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await post('/api/wallet/challenge', { junk: 'x'.repeat(66000) })).status, 413);
  assert.equal((await post('/api/wallet/challenge', {})).status, 400);
  const { cookie } = await signIn('addr_test1x');
  assert.equal((await post('/api/vault/withdraw', {}, { cookie })).status, 200);
  assert.deepEqual(calls, [['withdraw', 'addr_test1x']]);
});

test('one customer cannot claim another wallet or stop another customer\'s agent', async t => {
  const { post, agents, signIn } = await serverFixture(t);
  const alice = await signIn('addr_test1a');
  const bob = await signIn('addr_test1b');
  // Claiming Bob's address without Bob's key is refused.
  assert.equal((await signIn('addr_test1b', 'addr_test1m')).status, 403);
  assert.equal((await post('/api/agent/stop', {}, { cookie: alice.cookie })).status, 200);
  assert.equal(agents.get('a'.repeat(56)).running, false);
  assert.equal(agents.get('b'.repeat(56)).running, true);
  assert.equal(bob.status, 200);
});

test('the oracle is never deployed without a live market price', async t => {
  const { post, calls, signIn } = await serverFixture(t);
  assert.equal((await post('/api/setup/deploy-oracle', {})).status, 409);
  const { cookie } = await signIn('addr_test1x');
  const response = await post('/api/setup/deploy-oracle', {}, { cookie });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Live price unavailable/);
  assert.deepEqual(calls, []);
});
