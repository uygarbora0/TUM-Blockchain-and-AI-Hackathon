import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGuardianInput, runGuardianJob, createGuardianReport, explainGuardianFollowup } from './guardian/job.mjs';
import { createDemoPosition } from './guardian/risk.mjs';
import { answer, client } from './client.mjs';
import { validatePaidWorkerMode } from './guardian/worker-config.mjs';

test('enabled paid mode never silently falls back to unpaid execution when setup is missing', () => {
 assert.throws(() => validatePaidWorkerMode('true', false), /requires confirmed registration/);
 assert.equal(validatePaidWorkerMode('true', true), true);
 assert.equal(validatePaidWorkerMode('false', false), false);
 assert.equal(validatePaidWorkerMode(undefined, false), false);
 for (const invalid of ['TRUE', 'yes', '1']) assert.throws(() => validatePaidWorkerMode(invalid, true), /true or false/);
});

test('malformed structured jobs never fall through to the language model', () => {
 for (const input of ['{', '[]', '{}', '{"position":null}', '{"demo":false}', '{"demo":true,"execute":true}', '```json\n{broken}\n```']) {
  assert.throws(() => parseGuardianInput(input), TypeError);
 }
 assert.equal(parseGuardianInput('Explain what collateral means'), null);
 assert.deepEqual(parseGuardianInput('```json\n{"demo":true}\n```'), { demo: true });
});

test('explicit demo cannot silently replace a user-supplied real position', () => {
 assert.throws(() => parseGuardianInput(JSON.stringify({ demo: true, position: createDemoPosition() })), /cannot contain a user position/);
 const now = Date.now();
 const position = { ...createDemoPosition(now), network: 'mainnet' };
 const report = createGuardianReport({ position }, { now });
 assert.equal(report.kind, 'position-analysis');
 assert.equal(report.position.network, 'mainnet');
 assert.equal(report.execution.performed, false);
 assert.equal(report.execution.transactionHash, null);
 assert.match(report.dataSource, /unverified/);
 assert.deepEqual(report.position, position);
});

test('deterministic task path runs without creating an Eve session or bypassing the deadline', async context => {
 const dir = mkdtempSync(join(tmpdir(), 'guardian-job-'));
 const journal = join(dir, 'session.json');
 const create = context.mock.method(client.sessions, 'create', async () => { throw new Error('Model must not be contacted'); });
 try {
  await assert.rejects(answer('guardian demo', journal, Date.now() - 1), /deadline expired/);
  assert.equal(existsSync(journal), false);
  const result = await answer('guardian demo', journal);
  const state = JSON.parse(readFileSync(journal, 'utf8'));
  assert.match(result, /SIMULATION/);
  assert.equal(state.engine, 'deterministic');
  assert.equal(state.sessionId, undefined);
  assert.equal(state.report.analysis.recommendation.type, 'repay');
  assert.equal(state.report.analysis.recommendation.feasible, true);
  assert.equal(state.report.execution.performed, false);
  assert.equal(create.mock.callCount(), 0);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('old position timestamps remain stale in paid reports and saved follow-up explanations', () => {
 const now = Date.now();
 const position = createDemoPosition(now - 120000);
 position.collateral.priceUsd = 0.455;
 const { report, result } = runGuardianJob(JSON.stringify({ position }), { now });
 assert.equal(report.position.priceUpdatedAt, position.priceUpdatedAt);
 assert.equal(report.analysis.metrics.status, 'stale');
 assert.equal(report.analysis.recommendation, null);
 assert.match(result, /stale/i);
 assert.match(explainGuardianFollowup(report), /not been refreshed or executed/);
});

test('demo price shocks cannot mutate the requested input or masquerade as external data', () => {
 const input = { demo: true, priceDropPercent: 30, policy: { targetHealth: 1.35 } };
 const original = structuredClone(input);
 const report = createGuardianReport(input);
 assert.deepEqual(input, original);
 assert.equal(report.position.network, 'simulation');
 assert.equal(report.kind, 'demonstration');
 assert.equal(report.scenario.priceDropPercent, 30);
 assert.ok(report.analysis.metrics.healthFactor < report.scenario.baseline.healthFactor);
 for (const priceDropPercent of [-1, 100, '30']) {
  assert.throws(() => runGuardianJob(JSON.stringify({ demo: true, priceDropPercent })), /priceDropPercent/);
 }
});
