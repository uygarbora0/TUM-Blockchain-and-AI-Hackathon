import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuardianServer } from './guardian-server.mjs';
import { GuardianStore } from './guardian/store.mjs';

async function serverFixture(t) {
  const store = new GuardianStore();
  const server = createGuardianServer({ store, integrations: () => ({ network: 'Cardano Preprod' }), autoTick: false });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-guardian-client': 'dashboard', ...headers }, body: JSON.stringify(body) });
  return { store, base, post };
}

test('cross-origin pages cannot change the local simulation or read private configuration', async t => {
  const { base, post } = await serverFixture(t);
  assert.equal((await post('/api/reset', {}, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post('/api/reset', {}, { 'x-guardian-client': '' })).status, 403);
  assert.equal((await fetch(base + '/api/state', { headers: { host: 'untrusted.example' } })).status, 403);
  assert.equal((await fetch(base + '/.env')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e%2f.env')).status, 404);
});

test('invalid and oversized JSON cannot mutate a loan', async t => {
  const { base, post, store } = await serverFixture(t);
  const before = store.snapshot().position;
  assert.equal((await post('/api/position', { position: { debt: -1 } })).status, 400);
  assert.equal((await post('/api/monitor', { running: 'true' })).status, 400);
  const malformed = await fetch(base + '/api/reset', { method: 'POST', headers: { 'content-type': 'application/json', 'x-guardian-client': 'dashboard' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await post('/api/reset', { junk: 'x'.repeat(66000) })).status, 413);
  assert.deepEqual(store.snapshot().position, before);
});

test('API rescue flow replays one receipt and never fabricates blockchain evidence', async t => {
  const { post, base } = await serverFixture(t);
  assert.equal((await post('/api/scenario', { scenario: 'selloff' })).status, 200);
  const preview = await (await post('/api/plan', { action: 'repay' })).json();
  assert.ok(preview.plan.id);
  const body = { planId: preview.plan.id, idempotencyKey: 'api-rescue-test' };
  const [a, b] = await Promise.all([post('/api/execute', body), post('/api/execute', body)]);
  const first = await a.json();
  const second = await b.json();
  assert.equal(first.receipt.id, second.receipt.id);
  assert.equal(first.receipt.transactionHash, null);
  assert.equal(first.receipt.sellerPaymentVerified, false);
  assert.equal(first.state.stats.rescueCount, 1);
  assert.ok(first.receipt.afterHealth >= 1.5);
  const reportResponse = await fetch(base + '/api/report');
  assert.match(reportResponse.headers.get('content-disposition'), /guardian-report/);
  const report = await reportResponse.json();
  assert.equal(report.receipts.length, 1);
  assert.match(report.disclosure, /not proof/);
});
