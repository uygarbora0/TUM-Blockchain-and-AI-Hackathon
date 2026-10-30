import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GuardianStore, GuardianError } from './guardian/store.mjs';
import { integrationStatus } from './guardian/integrations.mjs';
import { analyze, validatePolicy } from './guardian/risk.mjs';
import { acquireWorkerLock } from './worker-lock.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = resolve(ROOT, 'public');
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY', 'cache-control': 'no-store',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function json(res, status, body, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new GuardianError('Content-Type must be application/json.', 415);
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw new GuardianError('Request is too large (64 KiB maximum).', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new GuardianError('Request must contain a valid JSON object.'); }
}

export function createGuardianServer({ store = new GuardianStore(), integrations = () => integrationStatus(), autoTick = true } = {}) {
  const fullState = () => ({ ...store.snapshot(), integrations: integrations() });
  const server = createServer(async (req, res) => {
    try {
      const port = server.address()?.port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'Only local dashboard requests are accepted.' });
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site requests are not allowed.' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok', service: 'liquidation-guardian', mode: 'simulation' });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, fullState());
      if (req.method === 'GET' && url.pathname === '/api/integrations') return json(res, 200, integrations());
      if (req.method === 'GET' && url.pathname === '/api/report') return json(res, 200, { ...store.report(), integrations: integrations() }, { 'content-disposition': 'attachment; filename="guardian-report.json"' });
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (req.headers['x-guardian-client'] !== 'dashboard') return json(res, 403, { error: 'Missing dashboard request header.' });
        const body = await readJson(req);
        let result;
        switch (url.pathname) {
          case '/api/scenario': store.setScenario(body.scenario); break;
          case '/api/monitor': store.setMonitor(body.running); break;
          case '/api/policy': store.setPolicy(body.policy); break;
          case '/api/position': store.setPosition(body.position); break;
          case '/api/reset': store.reset(); break;
          case '/api/plan': result = store.plan(body.action); break;
          case '/api/execute': result = store.execute(body.planId, body.idempotencyKey); break;
          case '/api/analyze': return json(res, 200, { mode: 'advisory', analysis: analyze(body.position, validatePolicy(body.policy)) });
          default: return json(res, 404, { error: 'API route not found.' });
        }
        return json(res, 200, { ...result, state: fullState() });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD, POST' });
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'API route not found.' });
      const path = resolve(PUBLIC, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!path.startsWith(PUBLIC + sep) || !MIME[extname(path)]) return json(res, 404, { error: 'File not found.' });
      let content;
      try { content = readFileSync(path); } catch { return json(res, 404, { error: 'File not found.' }); }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME[extname(path)] });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const status = error instanceof GuardianError ? error.status : error instanceof TypeError || error instanceof RangeError || error instanceof URIError ? 400 : 500;
      json(res, status, { error: status === 500 ? 'The operation could not be saved. Your previous state was preserved.' : error.message });
      if (status === 500) console.error('Guardian request failed:', error.code || error.name);
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  if (autoTick) {
    const timer = setInterval(() => {
      try { store.tick(); } catch (error) { console.error('Simulation tick failed:', error.code || error.name); }
    }, store.intervalMs);
    timer.unref();
    server.on('close', () => clearInterval(timer));
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const portText = process.env.GUARDIAN_PORT || '3000';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('GUARDIAN_PORT must be an integer between 1 and 65535.');
  const stateFile = resolve(ROOT, '.local/guardian/state.json');
  const release = acquireWorkerLock(resolve(ROOT, '.local/guardian/server.lock'));
  process.once('exit', release);
  const store = new GuardianStore({ file: stateFile });
  const server = createGuardianServer({ store });
  server.once('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${portText} is already in use. Set GUARDIAN_PORT to an available port.` : error.message); release(); process.exitCode = 1; });
  server.listen(Number(portText), '127.0.0.1', () => console.log(`Liquidation Guardian → http://127.0.0.1:${portText}\nSimulation only. No wallet, real loan, or live funds connected.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { release(); process.exit(0); }));
}
