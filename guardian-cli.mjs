import { readFileSync } from 'node:fs';
import { createDemoPosition, DEFAULT_POLICY } from './guardian/risk.mjs';
import { runGuardianJob } from './guardian/job.mjs';
import { integrationStatus } from './guardian/integrations.mjs';

const command = process.argv[2] || 'help';
try {
  if (command === 'demo') {
    const job = runGuardianJob('guardian demo');
    console.log(job.result);
  } else if (command === 'analyze') {
    const path = process.argv[3];
    if (!path) throw new Error('Usage: npm run analyze -- path/to/position.json (or - for stdin).');
    const input = readFileSync(path === '-' ? 0 : path, 'utf8');
    if (input.length > 16000) throw new Error('Input must be at most 16000 characters.');
    console.log(runGuardianJob(input).result);
  } else if (command === 'example') {
    console.log(JSON.stringify({ position: createDemoPosition(), policy: DEFAULT_POLICY }, null, 2));
  } else if (command === 'doctor') {
    const status = integrationStatus();
    console.log(`Liquidation Guardian setup check\nNode: ${process.version}\nLocal dashboard: no account or model required\nLending execution: simulation only\nSokosumi: ${status.sokosumi.status}\nMasumi: ${status.masumi.status}\nPaid worker: ${status.masumi.paymentsEnabled ? 'enabled in configuration' : 'disabled'}\nModel: ${status.model.configured ? 'configuration present (not verified)' : 'not configured; structured jobs still work'}\nBlockfrost: ${status.blockfrost.configured ? 'configuration present (not verified)' : 'not configured'}\nSaved verified payment receipts: ${status.evidence.length}\n\nNo credentials were printed and no network requests were made.\nSee docs/AGENT-SETUP.md for account and payment setup.`);
  } else {
    console.log('Liquidation Guardian\n\n  npm run dev                  Open the simulation dashboard\n  npm run demo                 Analyze a 30% price-drop scenario\n  npm run analyze -- FILE      Analyze an explicit snapshot JSON\n  node guardian-cli.mjs example Print a fresh sample input JSON\n  npm run doctor               Inspect setup without network requests\n  npm test                     Run regression tests');
    if (command !== 'help') process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
