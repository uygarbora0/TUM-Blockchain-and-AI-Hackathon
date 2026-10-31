import { analyze, createDemoPosition, validatePolicy, validatePosition } from './risk.mjs';

export const MAX_JOB_INPUT = 16000;
export const dashboardUrl = () => process.env.DASHBOARD_URL?.trim() || 'http://127.0.0.1:3000';
// Append the exact dashboard link to a model-written message so the canonical URL always
// reaches the user verbatim. A small model can mistype an unusual hostname; this guarantees
// a working link. Skips appending if the model already included the exact URL.
export function withDashboardCta(message) {
 const url = dashboardUrl();
 const text = String(message ?? '').trimEnd();
 return text.includes(url) ? text : `${text}\n\n→ Review and act on your position in the Liquidation Guardian dashboard: ${url}`;
}
export const GUARDIAN_HELP = `Liquidation Guardian checks a borrowing position and calculates rescue options. It cannot move funds.

Send "guardian demo" for a labelled price-drop simulation, or send JSON with {"position": {...}, "policy": {...}}. The position must include id, label, protocol, network, collateral (symbol, amount, priceUsd, liquidationThreshold), debt (symbol, amount, priceUsd), reserve (collateral and debt quantities), and priceUpdatedAt (an ISO timestamp). Policy is optional.

Use the README example for a complete input. A configured model can explain natural-language questions. No live lending execution, wallet authorization, or seller payment is implied by an analysis report.

→ Explore positions interactively in the Liquidation Guardian dashboard: ${dashboardUrl()}`;

function ownObject(value) {
 return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Structured inputs never fall through to the model, including malformed JSON.
// A demo requires an explicit command so a missing position cannot become fake live data.
export function parseGuardianInput(input) {
 if (typeof input !== 'string' || !input.trim() || input.length > MAX_JOB_INPUT) {
  throw new TypeError(`Input must contain 1 to ${MAX_JOB_INPUT} characters`);
 }
 let text = input.trim();
 if (/^(?:guardian demo|liquidation guardian demo|run guardian demo|demo)[.!]?$/i.test(text)) return { demo: true };
 if (text.startsWith('```')) {
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(text);
  if (!fenced) throw new TypeError('Provide one complete JSON object without surrounding commentary');
  text = fenced[1].trim();
 }
 if (!text.startsWith('{') && !text.startsWith('[')) return null;
 let request;
 try { request = JSON.parse(text); } catch { throw new TypeError('Invalid Guardian JSON: provide {"position": {...}, "policy": {...}} or {"demo": true}'); }
 if (!ownObject(request)) throw new TypeError('Guardian input must be a JSON object');
 if (Object.keys(request).some(key => !['position', 'policy', 'demo', 'priceDropPercent'].includes(key))) {
  throw new TypeError('Guardian JSON accepts only position, policy, demo, and priceDropPercent');
 }
 if (request.demo !== undefined && request.demo !== true) throw new TypeError('demo must be true when supplied');
 if (request.demo === true && request.position !== undefined) throw new TypeError('A demo cannot contain a user position; choose one input source');
 if (request.demo !== true && !ownObject(request.position)) throw new TypeError('A position is required unless demo is explicitly true');
 if (request.policy !== undefined && !ownObject(request.policy)) throw new TypeError('policy must be an object');
 if (request.priceDropPercent !== undefined && (request.demo !== true || typeof request.priceDropPercent !== 'number' || !Number.isFinite(request.priceDropPercent) || request.priceDropPercent < 0 || request.priceDropPercent >= 100)) {
  throw new TypeError('priceDropPercent must be a number from 0 to less than 100 and is only supported for explicit demos');
 }
 return request;
}

export function createGuardianReport(request, { now = Date.now() } = {}) {
 if (!Number.isFinite(now)) throw new TypeError('Report time must be a finite timestamp');
 // Re-parse object callers as well: model tools cannot bypass the input contract.
 const checked = parseGuardianInput(JSON.stringify(request));
 if (!checked) throw new TypeError('A structured Guardian request is required');
 const demonstration = checked.demo === true;
 const baseline = demonstration ? createDemoPosition(now) : null;
 const position = demonstration ? structuredClone(baseline) : validatePosition(checked.position);
 const priceDropPercent = demonstration ? (checked.priceDropPercent ?? 30) : null;
 if (demonstration) position.collateral.priceUsd *= 1 - priceDropPercent / 100;
 const policy = validatePolicy(checked.policy ?? {});
 const analysis = analyze(position, policy, { now });
 return {
  schemaVersion: 1,
  service: 'Liquidation Guardian',
  kind: demonstration ? 'demonstration' : 'position-analysis',
  generatedAt: new Date(now).toISOString(),
  dataSource: demonstration ? 'Synthetic demonstration data' : 'User-supplied snapshot; independently unverified',
  scenario: demonstration ? { priceDropPercent, baseline: analyze(baseline, policy, { now }).metrics } : null,
  position,
  policy,
  analysis,
  execution: { performed: false, transactionHash: null, message: 'Analysis only. No wallet access or lending transaction has been performed.' },
  limitations: [
   'The single-collateral model must be checked against the chosen lending protocol before real use.',
   'Supplied prices and position values are not verified against an oracle or a live loan.',
   'The forecast assumes unchanged prices, the configured fees and slippage, and no additional accrued interest.',
   'A service payment pays for this report; it does not fund or authorize a loan rescue.',
  ],
 };
}

function decimal(value, digits = 2) {
 return value === null || value === undefined ? 'not applicable' : Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function formatGuardianReport(report) {
 const { analysis, position } = report;
 const rows = analysis.actions.map(action => `- ${action.type}: ${action.feasible ? 'feasible within the supplied policy' : 'blocked'}; ${decimal(action.amount, 8)} ${action.asset}; cost $${decimal(action.costUsd)}; projected health ${decimal(action.projectedHealthFactor, 4)}. ${action.reason || ''}`);
 const recommended = analysis.recommendation;
 return [
  '# Liquidation Guardian report',
  '',
  report.kind === 'demonstration' ? `SIMULATION: synthetic position after a ${report.scenario.priceDropPercent}% collateral price drop.` : 'SNAPSHOT ANALYSIS: user-supplied data; no live position verification.',
  `${position.label || position.id} · ${position.protocol} · ${position.network}`,
  `Health: ${decimal(analysis.metrics.healthFactor, 4)} | Status: ${analysis.metrics.status} | Collateral: $${decimal(analysis.metrics.collateralUsd)} | Debt: $${decimal(analysis.metrics.debtUsd)}`,
  '',
  analysis.explanation,
  recommended ? `Proposed action: ${recommended.type}, ${decimal(recommended.amount, 8)} ${recommended.asset}. This is a calculation, not an executed transaction.` : 'No executable action is proposed by the supplied policy. See the reasons below.',
  '',
  `→ Review and act on this position in the Liquidation Guardian dashboard: ${dashboardUrl()}`,
  '',
  ...rows,
  ...analysis.warnings.map(warning => `- Warning: ${warning}`),
  '',
  report.execution.message,
  ...report.limitations.map(limit => `- ${limit}`),
  '',
  'Machine-readable calculation:',
  '```json',
  JSON.stringify(report, null, 2),
  '```',
 ].join('\n');
}

export function runGuardianJob(input, options) {
 const request = parseGuardianInput(input);
 if (request === null) return null;
 const report = createGuardianReport(request, options);
 return { request, report, result: formatGuardianReport(report) };
}

export function explainGuardianFollowup(previousReport) {
 if (!previousReport?.analysis) return GUARDIAN_HELP;
 const { analysis, generatedAt } = previousReport;
 return `Your previous report was calculated at ${generatedAt} from a saved snapshot. Its recorded status was ${analysis.metrics.status}, with health ${decimal(analysis.metrics.healthFactor, 4)}. It has not been refreshed or executed.\n\n${analysis.explanation}\n\nTo recalculate, send a complete new {"position": {...}, "policy": {...}} JSON object with a fresh, observed price timestamp, or "guardian demo" for a new simulation. Natural-language explanations require the optional model configuration. No funds have moved.\n\n→ Review and act on this position in the Liquidation Guardian dashboard: ${dashboardUrl()}`;
}
