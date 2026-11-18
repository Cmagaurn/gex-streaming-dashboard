export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const symbol = req.query.symbol || "ES";
  const receivedAt = Date.now();
  try {
    const zRes = await fetch("https://zerogex.io/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_gamma_levels", arguments: { symbol } }
      })
    });
    if (!zRes.ok) return res.status(zRes.status).json({ error: `ZeroGEX ${zRes.status}`, receivedAt });
    const json = await zRes.json();
    const text = json.result?.content?.[0]?.text || "";
    return res.status(200).json({ text, receivedAt });
  } catch (err) {
    return res.status(500).json({ error: err.message, receivedAt });
  }
}
