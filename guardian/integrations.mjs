import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Read a deliberately narrow, public projection of setup state. Never return credentials.
export function integrationStatus({ root = process.cwd(), env = process.env } = {}) {
  const registrationFile = join(root, 'docs/registration-state.json');
  let registered = false;
  let registrationError = false;
  if (existsSync(registrationFile)) {
    try {
      const record = JSON.parse(readFileSync(registrationFile, 'utf8'));
      registered = [record.status, record.registrationState, record.registration?.state].includes('RegistrationConfirmed');
    } catch { registrationError = true; }
  }
  const evidence = [];
  const local = join(root, '.local');
  if (existsSync(local)) {
    for (const name of readdirSync(local).filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name)).slice(0, 200)) {
      try {
        const task = JSON.parse(readFileSync(join(local, name), 'utf8'));
        const receipt = task.paid?.settlement;
        if (task.paid?.stage === 'settled' && receipt?.verified === true && /^[a-f0-9]{64}$/i.test(receipt.txHash || '') && /^\d+$/.test(receipt.netAtomicUnits || '') && BigInt(receipt.netAtomicUnits) > 0n) {
          evidence.push({ taskId: name.slice(0, -5), txHash: receipt.txHash, netAtomicUnits: receipt.netAtomicUnits, source: 'Saved worker verification; not re-queried by this dashboard' });
        }
      } catch { /* Unrelated or incomplete journals are not payment evidence. */ }
    }
  }
  return {
    network: 'Cardano Preprod',
    lending: { status: 'simulation', label: 'Guardian Sandbox', detail: 'No live lending adapter or wallet spending authority is configured.' },
    sokosumi: { status: env.COWORKER_ID ? 'configured' : 'not_configured', configured: Boolean(env.COWORKER_ID), verified: false, detail: 'Configuration does not establish a completed task or active worker.' },
    masumi: { status: registrationError ? 'invalid_state' : registered ? 'registration_saved' : 'not_configured', registered, paymentsEnabled: env.PAID_TASKS_ENABLED === 'true', sellerPaymentVerified: evidence.length > 0, detail: 'Registration is read from local setup state. Only worker-verified seller receipts count as payment evidence.' },
    model: { configured: Boolean(env.ZAI_API_KEY && env.ZAI_BASE_URL && env.ZAI_MODEL), detail: 'Structured risk jobs do not need a model key.' },
    blockfrost: { configured: Boolean(env.BLOCKFROST_API_KEY_PREPROD) },
    evidence,
  };
}
