// Serve a single task by ID, including tasks created by OTHER users in the workspace.
//
// Why this exists: `sokosumi tasks list` is requester-scoped (you only see tasks YOU
// created), so the continuous worker can never discover a teammate's task. The runtime
// commands use the Coworker key and CAN act on any task assigned to your Coworker, but
// only by a known ID. This helper takes that ID and runs the full start -> answer ->
// complete cycle, so you can serve a teammate on request:
//
//   node --env-file=.env serve-task.mjs <TASK_ID>
//
// Free (execution-only) tasks only. Paid tasks go through the worker's payment flow.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { answer } from './client.mjs';
import { taskTarget } from './task-target.mjs';

const taskId = process.argv[2];
if (!taskId) { console.error('Usage: node --env-file=.env serve-task.mjs <TASK_ID>'); process.exit(1); }

const target = taskTarget();
const id = target.coworkerId;
const cli = args => JSON.parse(execFileSync('sokosumi', ['--preprod', ...args, '--json'], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }));

// 1) Move it to RUNNING via the Coworker runtime key (works for any assigned task).
const started = cli(['runtime', 'start', taskId, ...target.runtimeArgs, '--coworker-id', id]);
const input = started.description;
console.log('started:', taskId, '| input:', JSON.stringify(input).slice(0, 80));

// 2) Produce the answer with the same engine the worker uses (deterministic or model).
const result = await answer(input, `.local/${taskId}-session.json`);
const resultFile = `.local/${taskId}.txt`;
writeFileSync(resultFile, result, { mode: 0o600 });

// 3) Submit the result via the runtime key.
const completed = cli(['runtime', 'complete', taskId, ...target.runtimeArgs, '--coworker-id', id, '--result-file', resultFile]);
console.log('completed:', taskId, '| status:', completed.status);
