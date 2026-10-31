// Guardian dashboard. Everything shown comes from /api/status, which reads
// Cardano Preprod and live exchange prices. Owner transactions are built by
// the server, signed by the CIP-30 wallet here, and submitted by the server.
const icons = {
  shield: '<path d="M12 3 20 6.5V12c0 5-8 9-8 9s-8-4-8-9V6.5L12 3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  sprout: '<path d="M12 21v-9M12 15C5 15 3 11 3 6c6 0 9 3 9 9Zm0-3c0-6 3-9 9-9 0 6-3 9-9 9Z"/>',
  hexagon: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m12 7 4.5 2.5v5L12 17l-4.5-2.5v-5L12 7Z"/>',
  alert: '<path d="m10.3 4-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  pause: '<path d="M8 4v16M16 4v16"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.info}</svg>`;
const paintIcons = (root = document) => root.querySelectorAll('[data-icon]').forEach((node) => { node.innerHTML = icon(node.dataset.icon); });
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const EXPLORER = 'https://preprod.cardanoscan.io';
const STORAGE_KEY = 'guardian-wallet';
const views = { setup: 'Setup', monitor: 'Live monitor' };
let status = null;
let api = null;
let walletKey = null;
let busy = false;
let policyDirty = false;

const micro = (value) => (value === null || value === undefined ? null : Number(BigInt(value)) / 1e6);
const fmt = (value, digits = 2) => (value === null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value));
const ada = (lovelace) => (lovelace === null || lovelace === undefined ? '—' : `${fmt(micro(lovelace), 6)} ADA`);
const tusd = (units) => `${fmt(micro(units), 6)} tUSD`;
const usdPrice = (microUsd) => (microUsd === null || microUsd === undefined ? '—' : `$${fmt(micro(microUsd), 6)}`);
const hf = (bps) => (bps === null || bps === undefined ? '∞' : fmt(Number(bps) / 10000, 3));
const ago = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60000)} min ago`);
const short = (text, keep = 12) => (text && text.length > keep * 2 + 1 ? `${text.slice(0, keep)}…${text.slice(-keep)}` : text || '');
const link = (kind, id, label = short(id)) => `<a href="${EXPLORER}/${kind}/${encodeURIComponent(id)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
const remember = (value) => { try { value ? localStorage.setItem(STORAGE_KEY, value) : localStorage.removeItem(STORAGE_KEY); } catch {} };
const recalled = () => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } };

function toast(message, isError = false) {
  const item = document.createElement('div');
  item.className = `toast${isError ? ' error' : ''}`;
  item.innerHTML = `${icon(isError ? 'alert' : 'check')}<span>${escapeHtml(message)}</span>`;
  $('#toast-region').append(item);
  setTimeout(() => item.remove(), isError ? 8000 : 4500);
}

function showError(message) {
  $('#error-message').textContent = message || '';
  $('#error-banner').hidden = !message;
}

function showResult(tone, html) {
  const box = $('#last-result');
  box.className = `vault-result ${tone}`;
  box.innerHTML = html;
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json', 'x-guardian-client': 'dashboard' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
    cache: 'no-store',
  }).catch(() => { throw new Error('Cannot reach the local Guardian server. Check that npm run dev is running.'); });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${response.status}).`);
  return data;
}

async function refresh() {
  try {
    status = await request('/api/status');
    $('#connection-label').textContent = status.chain.configured ? 'Live on Preprod' : 'Blockfrost key missing';
    $('#connection-status .status-dot').style.background = status.chain.configured ? '#7c9b70' : '#b77a63';
    showError(status.chain.configured ? '' : 'Set BLOCKFROST_API_KEY_PREPROD in .env and restart npm run dev.');
  } catch (error) {
    $('#connection-label').textContent = 'Offline';
    $('#connection-status .status-dot').style.background = '#b77a63';
    showError(error.message);
  }
  render();
}

// ---- Wallet ----

function wallets() {
  const injected = window.cardano || {};
  return Object.keys(injected)
    .filter((key) => typeof injected[key]?.enable === 'function' && injected[key]?.name)
    .map((key) => ({ key, name: String(injected[key].name), icon: injected[key].icon }));
}

async function connect(key) {
  busy = true; render();
  try {
    const wallet = window.cardano?.[key];
    if (!wallet) throw new Error('That wallet is no longer available in this browser.');
    api = await wallet.enable();
    if (await api.getNetworkId() !== 0) throw new Error('Your wallet is on Mainnet. Switch it to Preprod and connect again.');
    const changeAddress = await api.getChangeAddress();
    const usedAddresses = (await api.getUsedAddresses().catch(() => [])).slice(0, 20);
    // Prove you own this address. This session can then act only for your wallet.
    const challenge = await request('/api/wallet/challenge', { changeAddress, usedAddresses });
    if (challenge.connected) status = challenge;
    else {
      const signed = await api.signData(changeAddress, challenge.payload);
      status = await request('/api/wallet/connect', { signature: signed.signature, key: signed.key });
    }
    walletKey = key;
    remember(key);
    showError('');
    toast(`${wallet.name} connected.`);
  } catch (error) {
    api = null;
    const declined = error?.code === 3 || /declin|reject|cancel/i.test(error?.info || error?.message || '');
    showError(declined ? 'You declined the sign-in signature. It only proves you own this wallet and moves no funds.' : error?.info || error?.message || 'The wallet refused the connection.');
  } finally { busy = false; render(); }
}

async function disconnect() {
  api = null; walletKey = null; remember(null);
  status = await request('/api/wallet/disconnect', {}).catch(() => status);
  render();
}

// Build on the server, sign in the wallet, submit through the server.
async function ownerTransaction(path, body, label) {
  if (!api) return showError('Connect your wallet first.');
  busy = true; render();
  try {
    const built = await request(path, body);
    const witnessSet = await api.signTx(built.txCbor, true);
    const { txHash } = await request('/api/tx/submit', { txCbor: built.txCbor, witnessSet });
    showResult('ok', `${escapeHtml(label)} submitted: ${link('transaction', txHash)}. It shows here once the block confirms, usually within a minute.`);
    showError('');
    followUp();
  } catch (error) {
    const declined = error?.code === 2 || /declin|reject|cancel/i.test(error?.info || error?.message || '');
    showResult(declined ? 'warn' : 'bad', escapeHtml(declined ? 'You declined the signature. Nothing was submitted.' : error?.info || error?.message || 'The transaction failed.'));
  } finally { busy = false; render(); }
}

// Server-signed actions (oracle, agent).
async function serverAction(path, body, describe) {
  busy = true; render();
  try {
    const result = await request(path, body);
    showResult(result.status === 'blocked' ? 'warn' : 'ok', describe(result));
    showError('');
    followUp();
  } catch (error) {
    showResult('bad', escapeHtml(error.message));
  } finally { busy = false; render(); }
}

// Poll faster for a few minutes after a transaction.
let followUntil = 0;
function followUp() { followUntil = Date.now() + 3 * 60_000; refresh(); }

// ---- Derived state ----

function derive() {
  const chain = status?.chain;
  const connected = Boolean(chain?.wallet && api);
  const agentFunded = Boolean(chain?.agent) && BigInt(chain.agent.lovelace ?? 0) >= 6_000_000n;
  const operatorFunded = chain && BigInt(chain.oracle.lovelace ?? 0) >= 8_000_000n;
  const oracleLive = Boolean(chain?.oracle?.price);
  const loan = chain?.loans?.[0] ?? null;
  const mandateUtxo = chain?.vault?.utxos.find((u) => u.mandate?.forThisAgent) ?? null;
  const mandate = mandateUtxo?.mandate ?? null;
  const mandateOk = Boolean(mandate?.coversLoan);
  const running = Boolean(status?.agent?.running);
  const steps = [connected, agentFunded, oracleLive, Boolean(loan), mandateOk, running];
  return { chain, connected, agentFunded, operatorFunded, oracleLive, loan, mandate, mandateOk, running, steps };
}

// ---- Setup view ----

function renderWallet(d) {
  if (d.connected) {
    const w = d.chain.wallet;
    return `<dl class="kv"><dt>Wallet</dt><dd>${escapeHtml(window.cardano?.[walletKey]?.name || 'Connected')} · Preprod</dd><dt>Address</dt><dd>${link('address', w.address)}</dd><dt>Balance</dt><dd>${ada(w.lovelace)}${BigInt(w.tusd || 0) > 0n ? ` · ${tusd(w.tusd)}` : ''}</dd></dl>
      <div class="vault-actions"><button type="button" class="button button-light" data-action="disconnect">Disconnect</button></div>`;
  }
  const found = wallets();
  if (!found.length) return `<p class="vault-note">No Cardano wallet found in this browser yet. Install <a class="text-link" href="https://www.lace.io" target="_blank" rel="noreferrer">Lace</a> or Eternl, allow it on this site (puzzle icon → Lace → "On all sites"), switch it to <strong>Preprod</strong>, then reload.</p>
    <div class="vault-actions"><button type="button" class="button button-light" data-action="rescan">Look for wallets again</button></div>`;
  return `<div class="wallet-choices">${found.map((w) => `<button type="button" class="button button-light wallet-choice" data-wallet="${escapeHtml(w.key)}" ${busy ? 'disabled' : ''}>${/^data:image\//.test(w.icon || '') ? `<img src="${escapeHtml(w.icon)}" alt="">` : ''}Connect ${escapeHtml(w.name)}</button>`).join('')}</div>`;
}

function renderServices(d) {
  if (!d.chain) return '';
  const { agent, oracle } = d.chain;
  return `<dl class="kv"><dt>Your agent's fee wallet</dt><dd>${agent ? `${link('address', agent.address)} · ${ada(agent.lovelace)} ${d.agentFunded ? '✓' : '(needs 6+)'}${d.agentFunded && BigInt(agent.lovelace ?? 0) < 7_000_000n ? ' · below 7: it no longer pays oracle refreshes' : ''}` : 'Connect your wallet: every customer gets their own agent key.'}</dd>
      <dt>Shared oracle operator</dt><dd>${link('address', oracle.operator)} · ${ada(oracle.lovelace)} · ${d.oracleLive ? 'only signs price updates; customers pay their fees' : d.operatorFunded ? 'funded to deploy the oracle ✓' : 'needs 8+ ADA once, to deploy the shared oracle'}</dd></dl>
    <p class="vault-note">Your agent's fee wallet pays its own transactions and, in turn with the other running agents, the shared oracle's price refreshes (about 0.25 ADA each; only while it holds 7+ ADA). Keys live in <code>.local/guardian/</code>; your agent's key serves no other customer, and it cannot spend your vault through the owner path or touch your loan except to add collateral.</p>
    ${renderFundButton(d)}`;
}

// Mirrors chain.buildFund: before the oracle is deployed one button funds both; afterwards only a low agent wallet.
function renderFundButton(d) {
  const label = !d.oracleLive ? 'Send 15 ADA to your agent + 10 ADA to the oracle operator' : BigInt(d.chain.agent?.lovelace ?? 0) < 7_000_000n ? 'Send 15 ADA to your agent' : null;
  if (!label) return '';
  return `<div class="vault-actions"><button type="button" class="button button-primary" data-action="fund" ${busy || !d.connected ? 'disabled' : ''}>${label}</button></div>`;
}

function renderOracle(d) {
  if (!d.chain) return '';
  const o = d.chain.oracle;
  const market = status.market;
  const marketLine = market?.ok ? `$${fmt(market.priceUsd, 6)} (${market.quotes.filter((q) => q.price).map((q) => escapeHtml(q.source)).join(', ')})` : `unavailable: ${escapeHtml(market?.reason || '')}`;
  if (d.oracleLive) {
    return `<dl class="kv"><dt>On-chain price</dt><dd>${usdPrice(o.price)} · updated ${ago(Date.now() - o.updatedAt)}${o.fresh ? '' : ' · <strong>stale, cannot open or liquidate loans</strong>'}</dd><dt>Market now</dt><dd>${marketLine}</dd>
      <dt>Oracle address</dt><dd>${link('address', o.address)}</dd><dt>Lending contract</dt><dd>${escapeHtml(o.lendingHash)}</dd></dl>
      <div class="vault-actions"><button type="button" class="button ${o.fresh ? 'button-light' : 'button-primary'}" data-action="publish-price" ${busy || !d.connected ? 'disabled' : ''}>Publish market price now (you pay ≈0.25 ADA)</button></div>
      <p class="vault-note">One oracle serves every customer. While any customer's agent runs it is republished on a 0.5% move or every 20 minutes, paid by the running agents in turn. Contracts reject prices older than 30 minutes; if it is stale, publish it yourself from your wallet.</p>`;
  }
  return `<dl class="kv"><dt>Market now</dt><dd>${marketLine}</dd>${o.deployed ? `<dt>Deployment</dt><dd>${link('transaction', o.deployTx)} · confirming</dd>` : ''}</dl>
    <div class="vault-actions"><button type="button" class="button button-primary" data-action="deploy-oracle" ${busy || !d.connected || !d.operatorFunded || !market?.ok ? 'disabled' : ''}>Deploy oracle at the market price</button></div>
    ${d.operatorFunded ? '' : '<p class="vault-note">The oracle operator needs 8+ ADA to deploy. Fund it in step 02.</p>'}`;
}

function renderLoanInfo(d) {
  if (!d.loan) return '';
  const l = d.loan;
  return `<div class="utxo"><dl class="kv"><dt>Collateral</dt><dd>${ada(l.collateral)}</dd><dt>Debt</dt><dd>${tusd(l.debt)}</dd><dt>Health</dt><dd>${hf(l.healthBps)} at the oracle price</dd><dt>Liquidation below</dt><dd>${usdPrice(l.liquidationPriceMicro)} per ADA</dd><dt>Loan UTxO</dt><dd>${link('transaction', l.ref.split('#')[0], l.ref)}</dd></dl>
    <div class="vault-actions"><button type="button" class="button button-danger-outline" data-action="close-loan" ${busy || !d.connected ? 'disabled' : ''}>Repay ${tusd(l.debt)} &amp; close loan</button></div></div>`;
}

function renderVaultInfo(d) {
  if (!d.chain?.vault) return '';
  const v = d.chain.vault;
  if (!v.utxos.length) return '';
  const rows = v.utxos.map((u) => {
    const m = u.mandate;
    if (!m) return `<div class="utxo"><strong>${ada(u.lovelace)}</strong> · plain transfer without a mandate. Only you can spend it.</div>`;
    return `<div class="utxo"><strong>${ada(u.lovelace)}</strong> · ${link('transaction', u.ref.split('#')[0], u.ref)}${m.forThisAgent ? '' : ' · <em>mandate names a different agent key, not your agent: withdraw and sign again</em>'}${m.coversLoan ? '' : ' · <strong>does not allow paying into your loan: withdraw and sign again</strong>'}
      <dl class="kv"><dt>Per transaction</dt><dd>${ada(m.maxPerTx)}</dd><dt>Spent this period</dt><dd>${ada(m.spentInPeriod)} of ${ada(m.periodLimit)}</dd><dt>Expires</dt><dd>${new Date(Number(m.expiry)).toLocaleString()}</dd></dl></div>`;
  }).join('');
  return `<dl class="kv"><dt>Vault address</dt><dd>${link('address', v.address)}</dd><dt>Balance</dt><dd>${ada(v.lovelace)}</dd></dl>${rows}
    <div class="vault-actions"><button type="button" class="button button-danger-outline" data-action="withdraw" ${busy || !d.connected ? 'disabled' : ''}>Withdraw all &amp; revoke agent</button></div>`;
}

function renderAgentStep(d) {
  if (!d.mandate) return '<p class="vault-note">Complete the steps above first.</p>';
  return `<div class="vault-actions">
      ${d.running ? '<a class="button button-primary" href="#monitor">Open live monitor</a>' : `<button type="button" class="button button-primary" data-action="start" ${busy || !d.steps.slice(0, 5).every(Boolean) ? 'disabled' : ''}>${icon('play')}Start the agent</button>`}</div>`;
}

function renderRevoke(d) {
  if (!d.connected) return '<p class="vault-note">Connect your wallet first.</p>';
  const agentAda = BigInt(d.chain?.agent?.lovelace ?? 0);
  const vaultAda = BigInt(d.chain?.vault?.lovelace ?? 0);
  const parts = [d.loan && `repays ${tusd(d.loan.debt)} and closes your loan (collateral ${ada(d.loan.collateral)} back to you)`, vaultAda > 0n && `withdraws ${ada(vaultAda)} from the vault, which revokes the agent's mandate`, agentAda > 0n && `returns ${ada(agentAda)} from your agent's fee wallet`, d.running && 'stops your agent'].filter(Boolean);
  if (!parts.length) return '<p class="vault-note">Nothing to revoke: no loan, no vault funds and an empty agent fee wallet.</p>';
  return `<p class="vault-note">One transaction, one signature: it ${parts.join('; ')}. Everything goes to your wallet.</p>
    <div class="vault-actions"><button type="button" class="button button-danger-outline" data-action="revoke-all" ${busy ? 'disabled' : ''}>Revoke everything</button></div>`;
}

function renderLoanPreview(d) {
  const form = new FormData($('#loan-form'));
  const collateral = Number(form.get('collateralAda'));
  const opening = Number(form.get('openingHealth'));
  const price = d.chain?.oracle?.price ? micro(d.chain.oracle.price) : null;
  if (!price || !(collateral > 0) || !(opening > 0)) return '';
  const debt = collateral * price * 0.8 / opening;
  return `Borrows ≈ ${fmt(debt, 2)} tUSD. Liquidation below $${fmt(debt / (collateral * 0.8), 5)} per ADA (now $${fmt(price, 5)}).`;
}

// ---- Monitor view ----

function renderMonitor(d) {
  const market = status?.market;
  const o = d.chain?.oracle;
  $('#price-value').textContent = market?.ok ? `$${fmt(market.priceUsd, 5)}` : '—';
  $('#price-detail').innerHTML = `${(market?.quotes || []).map((q) => `<dt>${escapeHtml(q.source)}</dt><dd>${q.price ? `$${fmt(q.price, 6)}` : `error: ${escapeHtml(q.error)}`}</dd>`).join('')}<dt>On-chain oracle</dt><dd>${o?.price ? `${usdPrice(o.price)} · ${ago(Date.now() - o.updatedAt)}` : 'not deployed'}</dd>`;
  const l = d.loan;
  $('#health-value').textContent = l ? hf(l.healthBps) : 'No loan';
  const policy = status.agent?.policy;
  $('#health-value').className = `monitor-value${l && l.healthBps !== null ? (Number(l.healthBps) < 10000 ? ' danger' : policy && Number(l.healthBps) < (policy.triggerHealth * 10000) ? ' warning' : '') : ''}`;
  $('#loan-detail').innerHTML = l ? `<dt>Collateral</dt><dd>${ada(l.collateral)}</dd><dt>Debt</dt><dd>${tusd(l.debt)}</dd><dt>Liquidation below</dt><dd>${usdPrice(l.liquidationPriceMicro)}</dd><dt>Agent acts below</dt><dd>${policy ? fmt(policy.triggerHealth, 2) : '—'}</dd>` : '<dt>Status</dt><dd>Open a loan in setup step 4.</dd>';
  const v = d.chain?.vault;
  $('#vault-value').textContent = v ? ada(v.lovelace) : '—';
  $('#vault-detail').innerHTML = d.mandate ? `<dt>Agent may move now</dt><dd>${ada(v.allowance)}</dd><dt>Per transaction</dt><dd>${ada(d.mandate.maxPerTx)}</dd><dt>Expires</dt><dd>${new Date(Number(d.mandate.expiry)).toLocaleDateString()}</dd>` : '<dt>Status</dt><dd>No mandate yet.</dd>';
  $('#agent-controls').innerHTML = d.running
    ? `<span class="small-badge">RUNNING · every ${Math.round(status.agent.intervalMs / 1000)} s</span><button type="button" class="button button-light" data-action="stop" ${busy ? 'disabled' : ''}>${icon('pause')}Stop agent</button>`
    : `<button type="button" class="button button-primary" data-action="start" ${busy || !d.steps.slice(0, 5).every(Boolean) ? 'disabled' : ''}>${icon('play')}Start agent</button>`;
  const check = status?.agent?.lastCheck;
  $('#last-check').textContent = check ? `LAST CHECK ${new Date(check.at).toLocaleTimeString()}` : 'NOT CHECKED YET';
  // Your agent's log plus the shared oracle keeper's publications.
  const events = [...(status?.agent?.events || []), ...(status?.oracle?.events || [])].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
  $('#activity').innerHTML = events.length ? events.map((e) => `<div class="activity-row ${escapeHtml(e.type)}"><span class="small-badge">${escapeHtml(e.type.toUpperCase())}</span><div><p>${escapeHtml(e.message)}${e.txHash ? ` ${link('transaction', e.txHash)}` : ''}</p><small>${new Date(e.at).toLocaleString()}</small></div></div>`).join('') : '<p class="vault-note">Nothing yet. Start the agent to begin.</p>';
  if (!policyDirty && status?.agent?.policy) {
    $('#policy-form').triggerHealth.value = status.agent.policy.triggerHealth;
    $('#policy-form').targetHealth.value = status.agent.policy.targetHealth;
  }
}

function render() {
  const d = derive();
  $('#step-wallet').innerHTML = renderWallet(d);
  $('#step-services').innerHTML = renderServices(d);
  $('#step-oracle').innerHTML = renderOracle(d);
  $('#loan-info').innerHTML = renderLoanInfo(d);
  $('#vault-info').innerHTML = renderVaultInfo(d);
  $('#step-agent').innerHTML = renderAgentStep(d);
  $('#revoke-all').innerHTML = renderRevoke(d);
  $('#loan-submit').disabled = busy || !d.connected || !d.oracleLive || Boolean(d.loan);
  $('#loan-preview').textContent = d.loan ? 'Loan open. Close it to open a new one.' : renderLoanPreview(d);
  $('#mandate-submit').disabled = busy || !d.connected || !d.oracleLive || Boolean(d.mandate);
  $('#mandate-status').textContent = d.mandate ? 'Mandate active. Withdraw to change it.' : !d.oracleLive ? 'Deploy the oracle first.' : '';
  document.querySelectorAll('.vault-step').forEach((step, i) => step.classList.toggle('step-done', Boolean(d.steps[i])));
  $('#setup-progress').textContent = `${d.steps.filter(Boolean).length}/6`;
  $('#agent-badge').textContent = d.running ? 'on' : 'off';
  if (status) renderMonitor(d);
  paintIcons($('#main'));
}

// ---- Events ----

document.addEventListener('click', (event) => {
  const choice = event.target.closest('[data-wallet]');
  if (choice) return connect(choice.dataset.wallet);
  const action = event.target.closest('[data-action]')?.dataset.action;
  const d = derive();
  if (action === 'rescan') { render(); if (!wallets().length) toast('Still no wallet extension on this page. Reload after enabling Lace.', true); }
  if (action === 'disconnect') disconnect();
  if (action === 'fund') ownerTransaction('/api/setup/fund', {}, 'Funding');
  if (action === 'deploy-oracle') serverAction('/api/setup/deploy-oracle', {}, (r) => `Oracle deployment submitted by the operator key: ${link('transaction', r.txHash)}.`);
  if (action === 'publish-price') ownerTransaction('/api/oracle/publish', {}, 'Oracle price update');
  if (action === 'close-loan') ownerTransaction('/api/loan/close', {}, 'Loan repayment');
  if (action === 'withdraw') ownerTransaction('/api/vault/withdraw', {}, 'Withdrawal');
  if (action === 'revoke-all' && confirm('Revoke everything? This stops your agent, closes your loan, empties the vault and returns your agent fee wallet to you.')) ownerTransaction('/api/revoke', {}, 'Revoke everything');
  if (action === 'start') serverAction('/api/agent/start', {}, () => { location.hash = 'monitor'; return 'Agent started. Watch the live monitor.'; });
  if (action === 'stop') serverAction('/api/agent/stop', {}, () => 'Agent stopped. No more rescues for your loan.');
});

$('#loan-form').addEventListener('input', () => { $('#loan-preview').textContent = renderLoanPreview(derive()); });
$('#loan-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  ownerTransaction('/api/loan/open', { collateralAda: Number(form.get('collateralAda')), openingHealth: Number(form.get('openingHealth')) }, 'Loan');
});

$('#mandate-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const value = (name) => Number(form.get(name));
  ownerTransaction('/api/vault/deposit', { amountAda: value('amountAda'), maxPerTxAda: value('maxPerTxAda'), periodLimitAda: value('periodLimitAda'), periodHours: value('periodHours'), expiryDays: value('expiryDays') }, 'Mandate and deposit');
});

$('#policy-form').addEventListener('input', () => { policyDirty = true; });
$('#policy-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await request('/api/agent/policy', { policy: { triggerHealth: Number(form.triggerHealth.value), targetHealth: Number(form.targetHealth.value) } });
    policyDirty = false;
    toast('Policy saved.');
    refresh();
  } catch (error) { toast(error.message, true); }
});

function selectView() {
  const requested = location.hash.slice(1);
  const view = Object.hasOwn(views, requested) ? requested : 'setup';
  document.querySelectorAll('.view').forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  document.querySelectorAll('.nav-link').forEach((nav) => {
    const selected = nav.dataset.view === view;
    nav.classList.toggle('active', selected);
    if (selected) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
  });
  $('#breadcrumb-current').textContent = views[view];
  document.title = `${views[view]} · Guardian`;
}

window.addEventListener('hashchange', selectView);
paintIcons();
selectView();
// Wallet extensions inject window.cardano some time after load; keep looking.
let lastWalletCount = 0;
const walletWatch = setInterval(() => {
  const count = wallets().length;
  if (count !== lastWalletCount) { lastWalletCount = count; render(); }
}, 500);
setTimeout(() => clearInterval(walletWatch), 20_000);
setTimeout(async () => {
  await refresh();
  const key = recalled();
  if (key && await window.cardano?.[key]?.isEnabled?.().catch(() => false)) connect(key);
}, 400);
setInterval(() => { if (!document.hidden && !busy) refresh(); }, 30_000);
setInterval(() => { if (!document.hidden && !busy && Date.now() < followUntil) refresh(); }, 10_000);
