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
    wallet: body => { if (!body.changeAddress) throw new GuardianError('Wallet address is invalid.'); return { address: body.changeAddress, addresses: [body.changeAddress], ownerKeyHash: 'aa' }; },
    buildWithdraw: async wallet => { calls.push(['withdraw', wallet.address]); return { txHash: 'h', txCbor: '00' }; },
    deployOracle: async price => { calls.push(['deploy', price]); return { txHash: 'd' }; },
  };
  const agent = { snapshot: () => ({ running: false }), start: async () => {}, stop() {}, setPolicy() {} };
  const market = async () => ({ ok: false, reason: 'offline' });
  const server = createGuardianServer({ chain, agent, market });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-guardian-client': 'dashboard', ...headers }, body: JSON.stringify(body) });
  return { base, post, calls };
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
  const { base, post, calls } = await serverFixture(t);
  assert.equal((await post('/api/vault/withdraw', {})).status, 409);
  const malformed = await fetch(base + '/api/wallet/connect', { method: 'POST', headers: { 'content-type': 'application/json', 'x-guardian-client': 'dashboard' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await post('/api/wallet/connect', { junk: 'x'.repeat(66000) })).status, 413);
  assert.equal((await post('/api/wallet/connect', {})).status, 400);
  assert.equal((await post('/api/wallet/connect', { changeAddress: 'addr_test1x' })).status, 200);
  assert.equal((await post('/api/vault/withdraw', {})).status, 200);
  assert.deepEqual(calls, [['withdraw', 'addr_test1x']]);
});

test('the oracle is never deployed without a live market price', async t => {
  const { post, calls } = await serverFixture(t);
  const response = await post('/api/setup/deploy-oracle', {});
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Live price unavailable/);
  assert.deepEqual(calls, []);
});
