export function validatePaidWorkerMode(value, ready) {
 const configured = value ?? 'false';
 if (!['true', 'false'].includes(configured)) throw new Error('PAID_TASKS_ENABLED must be true or false');
 if (configured === 'true' && !ready) throw new Error('PAID_TASKS_ENABLED=true requires confirmed registration and the private runtime key. Complete payment setup before starting the worker.');
 return configured === 'true';
}
// The worker serves every customer of this Coworker, and the lock only covers one machine.
// Running a second worker elsewhere would start and answer the same tasks twice, so the
// designated host opts in explicitly with its own OS username.
export function validateWorkerOperator(value, username) {
 const operator = value?.trim();
 if (!operator) throw new Error(`WORKER_OPERATOR is not set. Only the designated worker host runs npm run worker; on that machine set WORKER_OPERATOR=${username} in .env.`);
 if (operator !== username) throw new Error(`WORKER_OPERATOR is ${operator}, but this machine's user is ${username}. Only the designated worker host runs npm run worker.`);
 return operator;
}
export function isLoopbackUrl(url) {
 try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch { return true; }
}
