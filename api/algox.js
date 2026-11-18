export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const symbol = req.query.symbol || "SPY";
  const receivedAt = Date.now();
  try {
    const aRes = await fetch(`https://algoxflow.com/v1/gamma/${encodeURIComponent(symbol)}?strikes=1`);
    if (!aRes.ok) return res.status(aRes.status).json({ error: `AlgoX ${aRes.status}`, receivedAt });
    const data = await aRes.json();
    return res.status(200).json({ ...data, receivedAt });
  } catch (err) {
    return res.status(500).json({ error: err.message, receivedAt });
  }
}
