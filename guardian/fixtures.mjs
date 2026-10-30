/** A fictional loan. None of these values represents a live protocol or wallet. */
export function createDemoPosition(now = Date.now()) {
  if (!Number.isFinite(now) || now < 0) throw new TypeError('now must be a valid timestamp');
  return {
    id: 'guardian-demo',
    label: 'ADA safety vault',
    protocol: 'Guardian Sandbox',
    network: 'simulation',
    collateral: {symbol: 'ADA', amount: 10000, priceUsd: 0.65, liquidationThreshold: 0.8},
    debt: {symbol: 'dUSD', amount: 3000, priceUsd: 1},
    reserve: {collateral: 2000, debt: 1000},
    priceUpdatedAt: new Date(now).toISOString(),
  };
}
