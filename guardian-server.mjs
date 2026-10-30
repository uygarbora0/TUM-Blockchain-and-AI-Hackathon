import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GuardianError } from './guardian/errors.mjs';
import { acquireWorkerLock } from './worker-lock.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = resolve(ROOT, 'public');
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY', 'cache-control': 'no-store',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const bigintSafe = (_, v) => typeof v === 'bigint' ? v.toString() : v;

function json(res, status, body, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body, bigintSafe));
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

/**
 * Local dashboard API. Everything it reports is read from Cardano Preprod or
 * live exchange APIs. The connected wallet is held in memory; the browser
 * reconnects through CIP-30 after a restart.
 */
export function createGuardianServer({ chain, agent, market }) {
  let wallet = null;
  let marketCache = null;
  const livePrice = async () => {
    if (!marketCache || Date.now() - marketCache.fetchedAt > 20_000) marketCache = { fetchedAt: Date.now(), value: await market() };
    return marketCache.value;
  };
  const needWallet = () => { if (!wallet) throw new GuardianError('Connect your wallet first.', 409); return wallet; };
  const freshPrice = async () => {
    const quote = await livePrice();
    if (!quote.ok) throw new GuardianError(`Live price unavailable: ${quote.reason}`, 503);
    return quote.priceMicro;
  };
  const status = async () => ({ chain: await chain.overview(wallet), agent: agent.snapshot(), market: await livePrice() });

  const routes = {
    '/api/wallet/connect': async body => { wallet = chain.wallet(body); return status(); },
    '/api/wallet/disconnect': async () => { wallet = null; return status(); },
    '/api/setup/fund-services': () => chain.buildFundServices(needWallet()),
    '/api/setup/deploy-oracle': async () => chain.deployOracle(await freshPrice()),
    '/api/oracle/publish': async () => chain.publishPrice(await freshPrice()),
    '/api/loan/open': body => chain.buildOpenLoan(needWallet(), body),
    '/api/loan/close': () => chain.buildCloseLoan(needWallet()),
    '/api/vault/deposit': body => chain.buildDeposit(needWallet(), body),
    '/api/vault/withdraw': () => chain.buildWithdraw(needWallet()),
    '/api/vault/agent-test': body => chain.agentPay(needWallet().ownerKeyHash, { amountAda: body.amountAda, checkLimits: body.checkLimits !== false }),
    '/api/tx/submit': body => chain.submitOwner(body.txCbor, body.witnessSet),
    '/api/agent/start': async () => { await agent.start(needWallet()); return agent.snapshot(); },
    '/api/agent/stop': async () => { agent.stop(); return agent.snapshot(); },
    '/api/agent/policy': async body => { agent.setPolicy(body.policy); return agent.snapshot(); },
  };

  const server = createServer(async (req, res) => {
    try {
      const port = server.address()?.port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'Only local dashboard requests are accepted.' });
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site requests are not allowed.' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok', service: 'liquidation-guardian', network: chain.network });
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await status());
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (req.headers['x-guardian-client'] !== 'dashboard') return json(res, 403, { error: 'Missing dashboard request header.' });
        const body = await readJson(req);
        const route = routes[url.pathname];
        if (!route) return json(res, 404, { error: 'API route not found.' });
        return json(res, 200, await route(body));
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
      const known = error instanceof GuardianError;
      const status = known ? error.status : error instanceof URIError ? 400 : 502;
      // Chain, wallet and ledger errors carry no secrets and explain what to fix.
      json(res, status, { error: known || status === 400 ? error.message : `Cardano request failed: ${String(error?.message || error).slice(0, 400)}` });
      if (status >= 500) console.error('Guardian request failed:', String(error?.message || error).slice(0, 200));
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const portText = process.env.GUARDIAN_PORT || '3000';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('GUARDIAN_PORT must be an integer between 1 and 65535.');
  const dir = resolve(ROOT, '.local/guardian');
  const release = acquireWorkerLock(resolve(dir, 'server.lock'));
  process.once('exit', release);
  const { GuardianChain } = await import('./guardian/chain.mjs');
  const { GuardianAgent } = await import('./guardian/agent.mjs');
  const { marketPrice } = await import('./guardian/prices.mjs');
  const chain = new GuardianChain({ dir });
  const agent = new GuardianAgent({ chain, file: resolve(dir, 'agent-state.json') });
  const server = createGuardianServer({ chain, agent, market: marketPrice });
  const timer = setInterval(() => agent.tick(), agent.intervalMs);
  server.on('close', () => clearInterval(timer));
  server.once('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${portText} is already in use. Set GUARDIAN_PORT to an available port.` : error.message); release(); process.exitCode = 1; });
  server.listen(Number(portText), '127.0.0.1', () => {
    console.log(`Liquidation Guardian → http://127.0.0.1:${portText}`);
    console.log(`Cardano ${chain.network}${chain.configured ? '' : ' (set BLOCKFROST_API_KEY_PREPROD to connect)'}`);
    console.log(`Agent fee wallet:     ${chain.agent.address}`);
    console.log(`Oracle operator:      ${chain.operator.address}`);
    console.log(`Agent: ${agent.state.running ? 'running (resumed)' : 'stopped'}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { release(); process.exit(0); }));
}
