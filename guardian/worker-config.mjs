export function validatePaidWorkerMode(value, ready) {
 const configured = value ?? 'false';
 if (!['true', 'false'].includes(configured)) throw new Error('PAID_TASKS_ENABLED must be true or false');
 if (configured === 'true' && !ready) throw new Error('PAID_TASKS_ENABLED=true requires confirmed registration and the private runtime key. Complete payment setup before starting the worker.');
 return configured === 'true';
}
