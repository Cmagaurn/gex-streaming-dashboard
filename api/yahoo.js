export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const symbol = req.query.symbol;
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  const range = req.query.range || "1d";
  const interval = req.query.interval || "1m";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  try {
    const yRes = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });
    if (!yRes.ok) return res.status(yRes.status).json({ error: `Yahoo ${yRes.status}` });
    const data = await yRes.json();
    const result = data.chart?.result?.[0];
    const price = result?.meta?.regularMarketPrice ?? null;
    const timestamps = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const series = timestamps.map((t, i) => ({ t: t * 1000, c: closes[i] })).filter(p => p.c != null);
    return res.status(200).json({ symbol, price, series, receivedAt: Date.now() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
