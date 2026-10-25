export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const symbol = req.query.symbol;
  if (!symbol) return res.status(400).json({ error: "symbol required" });

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
  try {
    const yRes = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });
    if (!yRes.ok) return res.status(yRes.status).json({ error: `Yahoo ${yRes.status}` });
    const data = await yRes.json();
    const price = data.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
    return res.status(200).json({ symbol, price });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}