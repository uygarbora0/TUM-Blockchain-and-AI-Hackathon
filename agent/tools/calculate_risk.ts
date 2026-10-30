import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { runGuardianJob, dashboardUrl } from '../../guardian/job.mjs';

export default defineTool({
 description: 'Calculate a borrowing snapshot health factor and bounded rescue alternatives using the deterministic Liquidation Guardian engine. Read-only; never executes transactions. Pass the user-provided position and optional policy as JSON, or {"demo":true} only for an explicitly requested simulation.',
 inputSchema: z.object({
  requestJson: z.string().min(1).max(16000).describe('JSON object {position, policy?}. Position: id, label, protocol, network, collateral {symbol,amount,priceUsd,liquidationThreshold}, debt {symbol,amount,priceUsd}, reserve {collateral,debt}, priceUpdatedAt. Explicit demo alternative: {demo:true,priceDropPercent?:number,policy?:object}.'),
 }),
 execute({ requestJson }) {
  const result = runGuardianJob(requestJson);
  if (!result) throw new Error('calculate_risk requires structured JSON or an explicit guardian demo command');
  return { ...result.report, dashboardUrl: dashboardUrl() };
 },
});
