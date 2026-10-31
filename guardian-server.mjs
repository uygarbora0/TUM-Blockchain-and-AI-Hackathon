import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GuardianError } from './guardian/errors.mjs';
import { acquireWorkerLock } from './worker-lock.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = resolve(ROOT, 'public');
const OPERATOR_ROUTES = new Set(['/api/setup/deploy-oracle', '/api/oracle/publish']);
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY', 'cache-control': 'no-store',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const bigintSafe = (_, v) => typeof v === 'bigint' ? v.toString() : v;
const SESSION_COOKIE = 'guardian_session';
const SESSION_IDLE_MS = 12 * 3_600_000;
const MAX_SESSIONS = 1000;
const CHALLENGE_MS = 5 * 60_000;

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
 * live exchange APIs. Each browser has its own session, and a wallet joins a
 * session only after signing a one-time challenge (CIP-30 signData), so every
 * customer sees and controls only their own loan, vault and agent. Sessions
 * live in memory; the browser signs in again after a restart.
 */
export function createGuardianServer({ chain, agents, market }) {
  const sessions = new Map();
  let marketCache = null;
  const livePrice = async () => {
    if (!marketCache || Date.now() - marketCache.fetchedAt > 20_000) marketCache = { fetchedAt: Date.now(), value: await market() };
    return marketCache.value;
  };
  const sessionFor = req => {
    const id = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{64})(?:;|$)`).exec(req.headers.cookie || '')?.[1];
    const session = id && sessions.get(id);
    if (session && Date.now() - session.seenAt < SESSION_IDLE_MS) { session.seenAt = Date.now(); return session; }
    if (id) sessions.delete(id);
    return null;
  };
  const newSession = () => {
    for (const [id, s] of sessions) if (Date.now() - s.seenAt >= SESSION_IDLE_MS) sessions.delete(id);
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const session = { id: randomBytes(32).toString('hex'), wallet: null, challenge: null, seenAt: Date.now() };
    sessions.set(session.id, session);
    return session;
  };
  const needWallet = session => { if (!session?.wallet) throw new GuardianError('Connect your wallet first.', 409); return session.wallet; };
  const myAgent = session => agents.get(needWallet(session).ownerKeyHash);
  const freshPrice = async () => {
    const quote = await livePrice();
    if (!quote.ok) throw new GuardianError(`Live price unavailable: ${quote.reason}`, 503);
    return quote.priceMicro;
  };
  const status = async session => {
    const wallet = session?.wallet ?? null;
    return { chain: await chain.overview(wallet), agent: wallet ? agents.get(wallet.ownerKeyHash).snapshot() : null, oracle: agents.keeper.snapshot(), market: await livePrice() };
  };

  const routes = {
    // Step 1: describe the wallet. A session already holding it resumes without signing.
    '/api/wallet/challenge': async (body, session) => {
      const wallet = chain.wallet(body);
      if (session.wallet?.address === wallet.address) return { connected: true, ...await status(session) };
      const message = `Liquidation Guardian sign-in\nWallet: ${wallet.address}\nNonce: ${randomBytes(16).toString('hex')}\nIssued: ${new Date().toISOString()}`;
      session.challenge = { wallet, payload: Buffer.from(message).toString('hex'), expiresAt: Date.now() + CHALLENGE_MS };
      return { connected: false, payload: session.challenge.payload };
    },
    // Step 2: the wallet's signature over that challenge proves it owns the address.
    '/api/wallet/connect': async (body, session) => {
      const challenge = session?.challenge;
      if (session) session.challenge = null;
      if (!challenge || Date.now() > challenge.expiresAt) throw new GuardianError('Sign-in expired. Connect your wallet again.', 409);
      if (!chain.verifyOwnership(challenge.wallet, challenge.payload, body)) throw new GuardianError('The wallet signature does not prove ownership of this address.', 403);
      session.wallet = challenge.wallet;
      return status(session);
    },
    '/api/wallet/disconnect': async (_, session) => { if (session) session.wallet = null; return status(session); },
    '/api/setup/fund-agent': (_, session) => chain.buildFundAgent(needWallet(session)),
    '/api/setup/deploy-oracle': async () => chain.deployOracle(await freshPrice()),
    '/api/oracle/publish': async () => chain.publishPrice(await freshPrice()),
    '/api/loan/open': (body, session) => chain.buildOpenLoan(needWallet(session), body),
    '/api/loan/close': (_, session) => chain.buildCloseLoan(needWallet(session)),
    '/api/vault/deposit': (body, session) => chain.buildDeposit(needWallet(session), body),
    '/api/vault/withdraw': (_, session) => chain.buildWithdraw(needWallet(session)),
    '/api/vault/agent-test': (body, session) => chain.agentPay(needWallet(session).ownerKeyHash, { amountAda: body.amountAda, checkLimits: body.checkLimits !== false }),
    '/api/tx/submit': body => chain.submitOwner(body.txCbor, body.witnessSet),
    '/api/agent/start': (_, session) => agents.start(needWallet(session)),
    '/api/agent/stop': async (_, session) => { const agent = myAgent(session); agent.stop(); return agent.snapshot(); },
    '/api/agent/policy': async (body, session) => { const agent = myAgent(session); agent.setPolicy(body.policy); return agent.snapshot(); },
  };

  const server = createServer(async (req, res) => {
    try {
      const port = server.address()?.port;
      // PUBLIC_HOST optionally exposes the dashboard through a reverse proxy/tunnel (e.g. cloudflared).
      // Leave it unset for the default loopback-only mode.
      const publicHost = process.env.PUBLIC_HOST?.trim();
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, ...(publicHost ? [publicHost] : [])];
      if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'Only local dashboard requests are accepted.' });
      const origin = req.headers.origin;
      const allowedOrigins = allowedHosts.flatMap(h => [`http://${h}`, `https://${h}`]);
      if (origin && !allowedOrigins.includes(origin)) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      // Block cross-site scripted requests (CSRF), but allow a user to follow a link
      // into the dashboard: a top-level GET navigation is safe and carries no credentials-based risk.
      const topLevelNavigation = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate';
      if (req.headers['sec-fetch-site'] === 'cross-site' && !topLevelNavigation) return json(res, 403, { error: 'Cross-site requests are not allowed.' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok', service: 'liquidation-guardian', network: chain.network });
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await status(sessionFor(req)));
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (req.headers['x-guardian-client'] !== 'dashboard') return json(res, 403, { error: 'Missing dashboard request header.' });
        const body = await readJson(req);
        const route = routes[url.pathname];
        if (!route) return json(res, 404, { error: 'API route not found.' });
        // Oracle routes spend the operator key, so they stay on the operator's own machine even when PUBLIC_HOST is set.
        if (OPERATOR_ROUTES.has(url.pathname) && publicHost && req.headers.host === publicHost) return json(res, 403, { error: 'Oracle setup is only available on the operator machine.' });
        let session = sessionFor(req);
        const cookie = {};
        if (!session && url.pathname === '/api/wallet/challenge') {
          session = newSession();
          cookie['set-cookie'] = `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Strict`;
        }
        return json(res, 200, await route(body, session), cookie);
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
  const { GuardianAgents } = await import('./guardian/agent.mjs');
  const { marketPrice } = await import('./guardian/prices.mjs');
  const chain = new GuardianChain({ dir });
  const agents = new GuardianAgents({ chain, dir });
  const server = createGuardianServer({ chain, agents, market: marketPrice });
  const timer = setInterval(() => agents.tick(), agents.intervalMs);
  server.on('close', () => clearInterval(timer));
  server.once('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${portText} is already in use. Set GUARDIAN_PORT to an available port.` : error.message); release(); process.exitCode = 1; });
  server.listen(Number(portText), '127.0.0.1', () => {
    console.log(`Liquidation Guardian → http://127.0.0.1:${portText}`);
    console.log(`Cardano ${chain.network}${chain.configured ? '' : ' (set BLOCKFROST_API_KEY_PREPROD to connect)'}`);
    console.log(`Oracle operator:      ${chain.operator.address} (you fund this from the faucet; customers never do)`);
    console.log(`Customer agents:      ${agents.agents.size} (${agents.running.length} running)`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { release(); process.exit(0); }));
}
