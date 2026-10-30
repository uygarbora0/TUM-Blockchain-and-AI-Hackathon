const icons = {
  shield: '<path d="M12 3 20 6.5V12c0 5-8 9-8 9s-8-4-8-9V6.5L12 3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  sliders: '<path d="M4 7h8m5 0h3M4 17h3m5 0h8"/><circle cx="14.5" cy="7" r="2.5"/><circle cx="9.5" cy="17" r="2.5"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
  sprout: '<path d="M12 21v-9M12 15C5 15 3 11 3 6c6 0 9 3 9 9Zm0-3c0-6 3-9 9-9 0 6-3 9-9 9Z"/>',
  hexagon: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m12 7 4.5 2.5v5L12 17l-4.5-2.5v-5L12 7Z"/>',
  flask: '<path d="M9 3h6m-5 0v6l-6 9a2 2 0 0 0 1.7 3h12.6A2 2 0 0 0 20 18l-6-9V3M7 15h10"/>',
  alert: '<path d="m10.3 4-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
  edit: '<path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15l-1 5Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  'arrow-up-right': '<path d="M6 18 18 6M6 6h12v12"/>',
  'arrow-down': '<path d="M12 3v18m-7-7 7 7 7-7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  'trend-down': '<path d="m3 5 6 7 4-4 8 10m-6 0h6v-6"/>',
  'trend-up': '<path d="m3 18 6-7 4 4 8-10m-6 0h6v6"/>',
  lightning: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  pause: '<path d="M8 4v16M16 4v16"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/>',
  user: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  reset: '<path d="M3 4v6h6M3.5 10a9 9 0 1 1 .5 7"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  exchange: '<path d="M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.info}</svg>`;
}

function paintIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((node) => { node.innerHTML = icon(node.dataset.icon); });
}

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = (value, digits = 2) => Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Number(value)) : '—';
const compactNumber = (value, digits = 2) => Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(Number(value)) : '—';
const usd = (value, digits = 2) => Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(value)) : '—';
const health = (value) => value === null || value === Infinity ? '∞' : number(value);
const actionNames = { repay: 'Repay debt', add_collateral: 'Add collateral', unwind: 'Partially unwind' };
const actionIcons = { repay: 'arrow-down', add_collateral: 'plus', unwind: 'exchange' };
const viewNames = { overview: 'Overview', policy: 'Protection policy', activity: 'Activity', setup: 'Setup guide' };
let state = null;
let connected = false;
let chartMetric = 'price';
let view = 'overview';
let pendingPlan = null;
let policyDirty = false;
let requestGeneration = 0;
let polling = false;
let actionSignature = '';
let eventSignature = '';
let successfulLoad = false;
let pendingMutations = 0;
let planning = false;

function setText(selector, text) { const node = $(selector); if (node) node.textContent = text; }

function toast(message, isError = false) {
  const item = document.createElement('div');
  item.className = `toast${isError ? ' error' : ''}`;
  item.innerHTML = `${icon(isError ? 'alert' : 'check')}<span>${escapeHtml(message)}</span>`;
  $('#toast-region').append(item);
  setTimeout(() => item.remove(), isError ? 8000 : 4500);
}

async function request(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json', 'x-guardian-client': 'dashboard' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof data.error === 'string' ? data.error : data.error?.message || data.message || `Request failed (${response.status}).`;
      throw new Error(message);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The local server took too long to respond. Please try again.');
    if (error instanceof TypeError) throw new Error('Cannot reach the local Guardian server. Check that it is running.');
    throw error;
  } finally { clearTimeout(timeout); }
}

function connectionStatus(isConnected, message = '') {
  connected = isConnected;
  $('#connection-error').hidden = isConnected;
  setText('#connection-label', isConnected ? 'Local workspace' : 'Disconnected');
  $('#connection-status .status-dot').style.background = isConnected ? '#7c9b70' : '#b77a63';
  if (!isConnected) {
    setText('#connection-error-message', message || 'Guardian cannot reach the local server. Displayed data may be out of date.');
  }
}

async function loadState({ force = false } = {}) {
  if (polling && !force) return;
  const generation = requestGeneration;
  polling = true;
  try {
    const data = await request('/api/state');
    if (generation !== requestGeneration) return;
    applyState(data);
    connectionStatus(true);
  } catch (error) {
    connectionStatus(false, error.message);
  } finally { polling = false; }
}

function applyState(next) {
  if (!next?.position || !next?.analysis || !next?.policy) throw new Error('The server returned an incomplete position. Restart the local app and try again.');
  state = next;
  requestGeneration++;
  connectionStatus(true);
  render();
  if (!successfulLoad) {
    successfulLoad = true;
    populatePolicy();
  }
}

async function mutate(path, body, control) {
  if (control) control.disabled = true;
  pendingMutations++;
  requestGeneration++;
  try {
    const result = await request(path, body);
    if (result.state) applyState(result.state);
    else if (result.position && result.analysis) applyState(result);
    else await loadState({ force: true });
    return result;
  } finally {
    pendingMutations--;
    if (control?.isConnected) control.disabled = false;
  }
}

function render() {
  const { position, policy, analysis, monitor = {}, stats = {} } = state;
  const metrics = analysis.metrics || {};
  const collateral = position.collateral;
  const debt = position.debt;
  const reserve = position.reserve;
  setText('#position-label', position.label || 'Position outlook');
  setText('#collateral-value', usd(metrics.collateralUsd));
  setText('#collateral-detail', `${compactNumber(collateral.amount)} ${collateral.symbol}`);
  setText('#debt-value', usd(metrics.debtUsd));
  setText('#debt-detail', `${compactNumber(debt.amount)} ${debt.symbol}`);
  setText('#reserve-value', usd(reserve.collateral * collateral.priceUsd + reserve.debt * debt.priceUsd));
  setText('#reserve-detail', `${compactNumber(reserve.collateral)} ADA + ${compactNumber(reserve.debt)} ${debt.symbol}`);
  setText('#health-value', health(metrics.healthFactor));
  const hf = metrics.healthFactor === null ? Infinity : Number(metrics.healthFactor);
  const danger = hf <= 1;
  const warning = hf < policy.triggerHealth;
  const stale = Date.now() - new Date(position.priceUpdatedAt).getTime() > policy.maxPriceAgeSeconds * 1000;
  const healthLabel = debt.amount <= 0 ? 'Debt free' : danger ? 'Liquidation danger' : warning ? 'Time to review' : 'Healthy position';
  const healthDescription = debt.amount <= 0 ? 'No debt means there is no borrowing liquidation risk in this model.' : danger ? 'Your position is eligible for liquidation in this model. A rescue may be too late.' : warning ? 'Health is below your trigger. Review a rescue to restore your safety margin.' : 'Your collateral is above your protection trigger. Keep a little room for change.';
  setText('#health-status', stale ? 'Price data is stale' : healthLabel);
  $('#health-status').className = `health-status${danger ? ' danger' : warning || stale ? ' warning' : ''}`;
  setText('#health-description', stale ? 'Start monitoring or choose a scenario to refresh the simulated price before acting.' : healthDescription);
  const gauge = Math.max(0, Math.min(1, hf / 3));
  const angle = Math.PI * (1 - gauge);
  $('#gauge-progress').setAttribute('stroke-dasharray', `${(gauge * 100).toFixed(2)} 100`);
  $('#gauge-end').setAttribute('cx', String(150 + 115 * Math.cos(angle)));
  $('#gauge-end').setAttribute('cy', String(150 - 115 * Math.sin(angle)));
  $('.gauge-wrap').style.color = danger ? '#b57862' : warning ? '#c09b58' : '#809a57';
  setText('#price-buffer', metrics.priceBufferPct == null ? '—' : `${number(metrics.priceBufferPct, 1)}%`);
  setText('#liquidation-price', debt.amount > 0 ? usd(metrics.liquidationPriceUsd, 4) : 'Not applicable');
  $('#toggle-monitor').innerHTML = `${icon(monitor.running ? 'pause' : 'play')}<span id="monitor-label">${monitor.running ? 'Pause monitoring' : 'Start monitoring'}</span>`;
  $('#monitor-caption').className = `monitor-caption${monitor.running ? ' running' : ''}`;
  $('#monitor-caption').innerHTML = `<span class="status-dot"></span>${monitor.running ? `Updating every ${compactNumber((monitor.intervalMs || 2000) / 1000, 1)}s · simulation` : 'Simulation is paused'}`;
  document.querySelectorAll('[data-scenario]').forEach((button) => {
    const selected = button.dataset.scenario === monitor.scenario;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  setText('#policy-trigger', `${number(policy.triggerHealth)} HF`);
  setText('#policy-target', `${number(policy.targetHealth)} HF`);
  const remaining = stats.remainingBudgetUsd ?? Math.max(0, policy.maxSpendUsd - (stats.spentUsd || 0));
  setText('#policy-budget', `${usd(remaining, 0)} left`);
  $('#policy-budget').title = `${usd(policy.maxSpendUsd)} total session budget · ${usd(stats.spentUsd || 0)} spent`;
  setText('#policy-mode', policy.mode === 'automatic' ? 'Automatic · demo' : 'Manual review');
  setText('#planner-badge', policy.mode === 'automatic' ? 'AUTOMATIC · DEMO' : 'MANUAL APPROVAL');
  setText('#planner-explanation', analysis.explanation || 'Compare ways to restore your safety margin within your policy.');
  setText('#rescue-count', String(stats.rescueCount || 0));
  setText('#total-spent', usd(stats.spentUsd || 0));
  setText('#event-count', String((state.events || []).length));
  setText('#activity-count', String((state.events || []).length));
  const warnings = (analysis.warnings || []).map((warning) => typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning));
  $('#analysis-warnings').hidden = warnings.length === 0;
  $('#analysis-warnings').innerHTML = warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join('');
  renderActions();
  renderChart();
  if (view === 'activity') renderActivity();
  if (view === 'setup') renderIntegrations();
}

function recommendationType() {
  const recommendation = state?.analysis?.recommendation;
  if (typeof recommendation === 'string') return recommendation;
  return recommendation?.type || recommendation?.action || null;
}

function renderActions() {
  const actions = state.analysis.actions || [];
  const recommended = recommendationType();
  const signature = JSON.stringify([actions, recommended]);
  if (actionSignature === signature) return;
  actionSignature = signature;
  if (!actions.length) {
    $('#action-cards').innerHTML = `<div class="empty-state">${icon('shield')}<h3>No rescue needed right now.</h3><p>Try a sell-off scenario to see how Guardian responds to changing prices.</p></div>`;
    return;
  }
  $('#action-cards').innerHTML = actions.map((action) => {
    const isRecommended = action.type === recommended && action.feasible;
    const detail = action.feasible
      ? `${compactNumber(action.amount, 4)} ${escapeHtml(action.asset || (action.type === 'repay' ? state.position.debt.symbol : 'ADA'))} · ${usd(action.costUsd)} estimated · ${health(action.projectedHealthFactor)} HF after`
      : escapeHtml(action.reason || 'This action does not fit your spending limit or Guardian wallet balance.');
    return `<div class="action-card${isRecommended ? ' recommended' : ''}"><span class="action-symbol">${icon(actionIcons[action.type])}</span><div class="action-info"><div class="action-title">${escapeHtml(actionNames[action.type] || action.type)}${isRecommended ? '<span class="recommended-tag">SUGGESTED</span>' : ''}</div><p class="action-details${action.feasible ? '' : ' blocked'}">${detail}</p></div><button class="action-preview" type="button" data-action="${escapeHtml(action.type)}" ${action.feasible ? '' : 'disabled'} aria-label="Preview ${escapeHtml(actionNames[action.type] || action.type).toLowerCase()}">Preview ${icon('arrow-up-right')}</button></div>`;
  }).join('');
}

function renderChart() {
  const history = state.history || [];
  const isPrice = chartMetric === 'price';
  const raw = history.filter((entry) => Number.isFinite(isPrice ? entry.priceUsd : entry.healthFactor));
  const entries = raw.slice(-80);
  const current = isPrice ? state.position.collateral.priceUsd : state.analysis.metrics.healthFactor;
  const threshold = isPrice ? state.analysis.metrics.liquidationPriceUsd : state.policy.triggerHealth;
  const first = entries[0] ? (isPrice ? entries[0].priceUsd : entries[0].healthFactor) : current;
  const change = first > 0 && Number.isFinite(current) ? ((current - first) / first) * 100 : 0;
  setText('#chart-current', isPrice ? usd(current, 4) : health(current));
  setText('#chart-change', entries.length > 1 ? `${change >= 0 ? '+' : ''}${number(change, 2)}% in view` : 'Ready when you are');
  $('#chart-change').classList.toggle('negative', change < 0);
  setText('#chart-unit', isPrice ? 'USD / ADA' : 'HEALTH FACTOR');
  setText('#chart-series-label', isPrice ? 'Simulated ADA price' : 'Position health');
  setText('#chart-threshold-label', isPrice ? 'Liquidation price' : 'Protection trigger');
  setText('#chart-samples', `${entries.length} observation${entries.length === 1 ? '' : 's'}`);
  $('#history-chart').setAttribute('aria-label', `${isPrice ? 'Simulated ADA price' : 'Position health'} over ${entries.length} observations. Current value ${isPrice ? usd(current, 4) : health(current)}. ${isPrice ? 'Liquidation price' : 'Protection trigger'} ${isPrice ? usd(threshold, 4) : health(threshold)}.`);
  $('#chart-empty').hidden = entries.length > 1;
  const fallback = Number.isFinite(current) ? current : 1;
  const values = entries.length ? entries.map((entry) => isPrice ? entry.priceUsd : entry.healthFactor) : [fallback];
  const plottedValues = Number.isFinite(threshold) ? [...values, threshold] : values;
  let min = Math.min(...plottedValues), max = Math.max(...plottedValues);
  const pad = Math.max((max - min) * 0.18, max * 0.07, 0.015);
  min = Math.max(0, min - pad); max += pad;
  const width = 648, height = 192, left = 8, top = 14;
  const y = (value) => top + height * (1 - (value - min) / (max - min));
  const x = (index) => left + (values.length > 1 ? index / (values.length - 1) : 0.5) * width;
  const points = values.map((value, index) => `${x(index).toFixed(2)},${y(value).toFixed(2)}`);
  const line = `M${points.join(' L')}`;
  const lastX = x(values.length - 1), lastY = y(values.at(-1));
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = min + (max - min) * index / 4;
    const label = isPrice ? `$${number(value, value < 1 ? 3 : 2)}` : number(value, 2);
    return `<line class="chart-grid" x1="${left}" x2="${left + width}" y1="${y(value)}" y2="${y(value)}"/><text class="chart-label" x="670" y="${y(value) + 3}">${label}</text>`;
  }).join('');
  const labels = entries.length > 1 ? [0, Math.floor((entries.length - 1) / 2), entries.length - 1].map((index) => {
    const date = new Date(entries[index].timestamp);
    const label = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<text class="chart-label" x="${x(index)}" y="237" text-anchor="${index === 0 ? 'start' : index === entries.length - 1 ? 'end' : 'middle'}">${escapeHtml(label)}</text>`;
  }).join('') : '';
  const thresholdLine = Number.isFinite(threshold) ? `<line class="chart-threshold" x1="${left}" x2="${left + width}" y1="${y(threshold)}" y2="${y(threshold)}"/>` : '';
  $('#history-chart').innerHTML = `<defs><linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#b5cb8e" stop-opacity=".22"/><stop offset="100%" stop-color="#b5cb8e" stop-opacity=".015"/></linearGradient></defs>${grid}${thresholdLine}${values.length > 1 ? `<path class="chart-area" d="${line} L${lastX},${top + height} L${left},${top + height} Z"/><path class="chart-path" d="${line}"/>` : ''}<circle class="chart-end" cx="${lastX}" cy="${lastY}" r="5"/>${labels}`;
}

function eventCategory(event) {
  const type = event.type?.toLowerCase() || '';
  if (/rescue|execut|repay|collateral|unwind|plan/.test(type)) return 'rescue';
  if (/risk|price|danger|stale|warning|liquid|blocked/.test(type)) return 'risk';
  return 'settings';
}

function renderActivity() {
  const filter = $('#activity-filter').value;
  const all = state.events || [];
  const events = all.filter((event) => filter === 'all' || eventCategory(event) === filter).slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const signature = JSON.stringify([filter, events]);
  if (signature === eventSignature) return;
  eventSignature = signature;
  if (!events.length) {
    $('#activity-list').innerHTML = `<div class="empty-state">${icon('activity')}<h3>${filter === 'all' ? 'A clean slate.' : 'Nothing here just yet.'}</h3><p>${filter === 'all' ? 'Start monitoring or try a scenario to begin your position timeline.' : 'Events that match this filter will appear here.'}</p></div>`;
    return;
  }
  $('#activity-list').innerHTML = events.map((event) => {
    const category = eventCategory(event);
    const date = new Date(event.timestamp);
    const time = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<div class="activity-item"><span class="event-icon ${category}">${icon(category === 'rescue' ? 'shield' : category === 'risk' ? 'activity' : 'sliders')}</span><div class="event-content"><p class="event-message">${escapeHtml(event.message || event.type)}</p><div class="event-type">${escapeHtml(String(event.type || 'event').replace(/[_-]/g, ' '))} · simulation · ${escapeHtml(time)}</div>${event.details ? `<details><summary>View event details</summary><pre>${escapeHtml(JSON.stringify(event.details, null, 2))}</pre></details>` : ''}</div><time class="event-time" datetime="${escapeHtml(event.timestamp)}" title="${escapeHtml(date.toLocaleString())}">${escapeHtml(time)}</time></div>`;
  }).join('');
}

function renderIntegrations() {
  const rows = [
    { ready: true, title: 'Local risk engine & simulator', state: 'Available now', description: 'Deterministic health calculations, Guardian wallet balance checks, rescue previews, session budget, and an exportable event trail.' },
    { ready: false, title: 'Lending protocol & price oracle', state: 'No live connection', description: 'The dashboard uses a sample loan and simulated prices. A production adapter must verify the protocol’s risk rules, positions, oracle data, and transaction support.' },
    { ready: false, title: 'Wallet signing & loan execution', state: 'Not connected', description: 'No wallet permissions are requested. A real rescue needs an authorized transaction and confirmed on-chain evidence. A Cardano testnet wallet alone does not prove Preprod.' },
    { ready: false, title: 'Sokosumi agent workspace', state: integrationLabel('sokosumi'), description: 'Configure your project’s own Vendor, Coworker, and runtime credential, then complete a task. See the repository setup commands.' },
    { ready: state.integrations?.masumi?.sellerPaymentVerified === true, title: 'Masumi Preprod payment', state: integrationLabel('masumi'), description: 'Provision this project’s dedicated payment database and wallets. Register with your team author name and verify an actual seller receipt before claiming payment.' },
  ];
  const evidence = (state.integrations?.evidence || []).map((receipt) => `<div class="integration-row"><span class="integration-status ready">${icon('check')}</span><div class="integration-copy"><h3>Saved seller payment evidence</h3><p>Task: ${escapeHtml(receipt.taskId)}<br><code>${escapeHtml(receipt.txHash)}</code></p><p>${escapeHtml(receipt.source || 'Saved worker verification. Not re-queried by this dashboard.')}</p></div></div>`).join('');
  $('#integration-list').innerHTML = rows.map((row) => `<div class="integration-row"><span class="integration-status${row.ready ? ' ready' : ''}">${icon(row.ready ? 'check' : 'clock')}</span><div class="integration-copy"><h3>${escapeHtml(row.title)}</h3><p>${escapeHtml(row.description)}</p><div class="integration-state">${escapeHtml(row.state)}</div></div></div>`).join('') + evidence;
}

function integrationLabel(name) {
  const configured = state.integrations?.[name];
  if (configured?.sellerPaymentVerified === true) return 'Saved seller receipt verified by worker';
  if (configured?.verified === true && configured?.status) return String(configured.status);
  if (configured?.registered === true) return 'Registration saved · payment not verified';
  if (configured?.status === 'invalid_state') return 'Saved registration is invalid · inspect setup';
  if (configured?.configured === true) return 'Configuration present · live execution unverified';
  return 'Not verified · setup required';
}

function selectView(event) {
  const requested = location.hash.slice(1);
  view = Object.hasOwn(viewNames, requested) ? requested : 'overview';
  document.querySelectorAll('.view').forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  document.querySelectorAll('.nav-link').forEach((link) => {
    const selected = link.dataset.view === view;
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  setText('#breadcrumb-current', viewNames[view]);
  document.title = `${viewNames[view]} · Guardian`;
  if (state) {
    if (view === 'policy' && !policyDirty) populatePolicy();
    if (view === 'activity') renderActivity();
    if (view === 'setup') renderIntegrations();
  }
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (event?.type === 'hashchange') $('#main').focus({ preventScroll: true });
}

function populatePolicy() {
  if (!state) return;
  const form = $('#policy-form');
  for (const [name, value] of Object.entries(state.policy)) {
    if (form.elements.namedItem(name)) form.elements.namedItem(name).value = value;
  }
  policyDirty = false;
  setText('#policy-form-status', '');
  $('#policy-form-status').classList.remove('error');
}

function openPosition() {
  if (!state) return toast('Wait for the local workspace to connect.', true);
  const { position } = state;
  const values = {
    label: position.label,
    collateralAmount: position.collateral.amount,
    priceUsd: position.collateral.priceUsd,
    debtAmount: position.debt.amount,
    debtPriceUsd: position.debt.priceUsd,
    reserveCollateral: position.reserve.collateral,
    reserveDebt: position.reserve.debt,
    liquidationThreshold: Number((position.collateral.liquidationThreshold * 100).toFixed(5)),
  };
  for (const [name, value] of Object.entries(values)) $('#position-form').elements.namedItem(name).value = value;
  $('#position-error').hidden = true;
  $('#position-dialog').showModal();
}

function planHealth(snapshot) {
  if (!snapshot) return undefined;
  if (Object.hasOwn(snapshot, 'healthFactor')) return snapshot.healthFactor;
  if (snapshot.metrics) return snapshot.metrics.healthFactor;
  if (snapshot.analysis?.metrics) return snapshot.analysis.metrics.healthFactor;
  if (snapshot.collateral && snapshot.debt) {
    const debt = snapshot.debt.amount * snapshot.debt.priceUsd;
    return debt <= 0 ? null : snapshot.collateral.amount * snapshot.collateral.priceUsd * snapshot.collateral.liquidationThreshold / debt;
  }
  return undefined;
}

async function previewRescue(type, button) {
  if (!state || pendingPlan || planning) return;
  const action = state.analysis.actions.find((item) => item.type === type);
  if (!action?.feasible) return toast(action?.reason || 'This rescue is not currently available.', true);
  const beforeHealth = state.analysis.metrics.healthFactor;
  planning = true;
  try {
    const response = await mutate('/api/plan', { action: type }, button);
    if (!response.plan?.id) throw new Error('The server did not return a rescue preview. Please try again.');
    pendingPlan = { ...response.plan, selectedAction: typeof response.plan.action === 'object' ? response.plan.action : action, type, idempotencyKey: crypto.randomUUID(), snapshotBeforeHealth: beforeHealth };
    showPreview();
    $('#rescue-dialog').showModal();
  } catch (error) { toast(error.message, true); }
  finally { planning = false; }
}

function showPreview() {
  const { selectedAction: action } = pendingPlan;
  const beforeHealth = planHealth(pendingPlan.before) ?? pendingPlan.snapshotBeforeHealth;
  const afterHealth = planHealth(pendingPlan.after) ?? action.projectedHealthFactor;
  const expires = new Date(pendingPlan.expiresAt);
  setText('#rescue-dialog-title', `${actionNames[pendingPlan.type] || 'Rescue'} preview.`);
  $('#rescue-preview').innerHTML = `<div class="preview-notice">${icon('flask')}<span>Monitoring is paused while you review. This action updates the simulation only; no blockchain transaction will be signed or submitted.</span></div><div class="preview-amount">${compactNumber(action.amount, 6)} ${escapeHtml(action.asset || (pendingPlan.type === 'repay' ? state.position.debt.symbol : 'ADA'))}</div><div class="preview-label">${pendingPlan.type === 'repay' ? 'to repay from your Guardian wallet (simulated)' : pendingPlan.type === 'add_collateral' ? 'to add from your Guardian wallet (simulated)' : 'of collateral to sell in a simulated unwind'}</div><div class="preview-health"><div><span>HEALTH BEFORE</span><strong>${health(beforeHealth)}</strong></div><span aria-hidden="true">→</span><div><span>PROJECTED HEALTH</span><strong>${health(afterHealth)}</strong></div></div><div class="preview-facts"><div><span>Estimated rescue cost</span><strong>${usd(action.costUsd)}</strong></div><div><span>Estimated transaction fee</span><strong>${compactNumber(action.feeAda ?? state.policy.feeAda, 4)} ADA</strong></div><div><span>Session budget remaining</span><strong>${usd(state.stats?.remainingBudgetUsd ?? Math.max(0, state.policy.maxSpendUsd - (state.stats?.spentUsd || 0)))}</strong></div><div><span>Action authorization</span><strong>Your confirmation · simulation only</strong></div></div><p class="preview-expiry">${Number.isNaN(expires.getTime()) ? 'This preview expires if the position changes.' : `Preview expires at ${escapeHtml(expires.toLocaleTimeString())}.`}<br>A price, policy, or position change may require a fresh preview.</p>`;
  $('#rescue-error').hidden = true;
  $('#confirm-rescue').disabled = false;
}

document.addEventListener('click', async (event) => {
  const close = event.target.closest('.close-dialog');
  if (close) close.closest('dialog').close();
  const chartButton = event.target.closest('[data-chart]');
  if (chartButton) {
    chartMetric = chartButton.dataset.chart;
    document.querySelectorAll('[data-chart]').forEach((button) => {
      button.classList.toggle('selected', button === chartButton);
      button.setAttribute('aria-pressed', String(button === chartButton));
    });
    if (state) renderChart();
  }
  const scenarioButton = event.target.closest('[data-scenario]');
  if (scenarioButton && !scenarioButton.disabled) {
    try {
      await mutate('/api/scenario', { scenario: scenarioButton.dataset.scenario }, scenarioButton);
      toast(`${scenarioButton.textContent.trim()} scenario applied to the simulation.`);
    } catch (error) { toast(error.message, true); }
  }
  const actionButton = event.target.closest('[data-action]');
  if (actionButton && !actionButton.disabled) await previewRescue(actionButton.dataset.action, actionButton);
});

$('#retry-connection').addEventListener('click', () => loadState({ force: true }));
$('#edit-position').addEventListener('click', openPosition);
$('#toggle-monitor').addEventListener('click', async (event) => {
  if (!state) return toast('Wait for the local workspace to connect.', true);
  const running = !state.monitor.running;
  try {
    await mutate('/api/monitor', { running }, event.currentTarget);
    toast(running ? 'Simulated price monitoring started.' : 'Monitoring paused. The simulation stays where you left it.');
  } catch (error) { toast(error.message, true); }
});

$('#policy-form').addEventListener('input', () => {
  policyDirty = true;
  setText('#policy-form-status', 'You have unsaved changes.');
  $('#policy-form-status').classList.remove('error');
});
$('#policy-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state) return toast('Wait for the local workspace to connect.', true);
  const form = event.currentTarget;
  const formData = new FormData(form);
  const policy = { ...state.policy };
  for (const [name, value] of formData) policy[name] = ['mode', 'preferredAction'].includes(name) ? value : Number(value);
  if (policy.targetHealth <= policy.triggerHealth) {
    $('#policy-form-status').classList.add('error');
    setText('#policy-form-status', 'Target health must be higher than trigger health.');
    return;
  }
  try {
    await mutate('/api/policy', { policy }, event.submitter);
    populatePolicy();
    setText('#policy-form-status', 'Policy saved.');
    toast(policy.mode === 'automatic' ? 'Policy saved. Automatic rescues are enabled for the simulation only.' : 'Your protection policy is saved.');
  } catch (error) {
    $('#policy-form-status').classList.add('error');
    setText('#policy-form-status', error.message);
  }
});
$('#discard-policy').addEventListener('click', () => { populatePolicy(); toast('Unsaved policy changes discarded.'); });

$('#position-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const value = (name) => Number(formData.get(name));
  const position = {
    ...state.position,
    label: String(formData.get('label')).trim(),
    collateral: { ...state.position.collateral, amount: value('collateralAmount'), priceUsd: value('priceUsd'), liquidationThreshold: value('liquidationThreshold') / 100 },
    debt: { ...state.position.debt, amount: value('debtAmount'), priceUsd: value('debtPriceUsd') },
    reserve: { collateral: value('reserveCollateral'), debt: value('reserveDebt') },
    priceUpdatedAt: new Date().toISOString(),
  };
  try {
    await mutate('/api/position', { position }, event.submitter);
    $('#position-dialog').close();
    toast('Sample position updated. No real loan was changed.');
  } catch (error) {
    setText('#position-error', error.message);
    $('#position-error').hidden = false;
  }
});

$('#confirm-rescue').addEventListener('click', async (event) => {
  if (!pendingPlan) return;
  try {
    await mutate('/api/execute', { planId: pendingPlan.id, idempotencyKey: pendingPlan.idempotencyKey }, event.currentTarget);
    $('#rescue-dialog').close();
    toast('Simulated rescue completed. Review the updated position and activity trail.');
  } catch (error) {
    setText('#rescue-error', `${error.message} Close this dialog and preview again if the position or policy changed.`);
    $('#rescue-error').hidden = false;
    await loadState({ force: true });
  }
});
$('#rescue-dialog').addEventListener('close', () => { pendingPlan = null; });

$('#activity-filter').addEventListener('change', () => { if (state) renderActivity(); });
$('#reset-demo').addEventListener('click', () => { $('#reset-error').hidden = true; $('#reset-dialog').showModal(); });
$('#confirm-reset').addEventListener('click', async (event) => {
  try {
    await mutate('/api/reset', {}, event.currentTarget);
    policyDirty = false;
    populatePolicy();
    $('#reset-dialog').close();
    location.hash = 'overview';
    toast('A fresh start. Your sample position and simulation have been reset.');
  } catch (error) {
    setText('#reset-error', error.message);
    $('#reset-error').hidden = false;
  }
});

window.addEventListener('hashchange', selectView);
document.addEventListener('visibilitychange', () => { if (!document.hidden && pendingMutations === 0) loadState(); });
paintIcons();
selectView();
loadState();
setInterval(() => { if (!document.hidden && pendingMutations === 0) loadState(); }, 2000);
