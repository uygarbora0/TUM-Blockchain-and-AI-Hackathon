// Live ADA/USD from public exchange APIs. A price is accepted only when at
// least two sources respond and agree within MAX_SPREAD of their median.
const MAX_SPREAD = 0.02;
const SOURCES = [
  ['Kraken', 'https://api.kraken.com/0/public/Ticker?pair=ADAUSD', j => j.result[Object.keys(j.result)[0]].c[0]],
  ['CoinGecko', 'https://api.coingecko.com/api/v3/simple/price?ids=cardano&vs_currencies=usd', j => j.cardano.usd],
  ['Coinbase', 'https://api.coinbase.com/v2/prices/ADA-USD/spot', j => j.data.amount],
];

export async function marketPrice({ fetchImpl = fetch, clock = Date.now } = {}) {
  const quotes = await Promise.all(SOURCES.map(async ([name, url, pick]) => {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const price = Number(pick(await response.json()));
      if (!Number.isFinite(price) || price <= 0) throw new Error('no price');
      return { source: name, price };
    } catch (error) { return { source: name, error: error.message }; }
  }));
  const prices = quotes.filter(q => q.price).map(q => q.price).sort((a, b) => a - b);
  const at = new Date(clock()).toISOString();
  if (prices.length < 2) return { ok: false, at, quotes, reason: 'Fewer than two price sources responded.' };
  const median = prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
  const agreeing = prices.filter(p => Math.abs(p - median) / median <= MAX_SPREAD);
  if (agreeing.length < 2) return { ok: false, at, quotes, reason: 'Price sources disagree by more than 2%.' };
  // Micro-USD per ADA, the unit the oracle and lending contracts use.
  return { ok: true, at, quotes, priceUsd: median, priceMicro: BigInt(Math.round(median * 1e6)) };
}
