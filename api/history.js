const GITHUB_OWNER = "Cmagaurn";
const GITHUB_REPO = "gex-streaming-dashboard";
const HISTORY_PATH = "history.json";
const ZEROGEX_MCP = "https://zerogex.io/mcp";
const MAX_DAYS = 5;

async function fetchZeroGEX() {
  const res = await fetch(ZEROGEX_MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_gamma_levels", arguments: { symbol: "ES" } }
    })
  });
  if (!res.ok) throw new Error(`ZeroGEX ${res.status}`);
  const json = await res.json();
  const text = json.result?.content?.[0]?.text || "";
  return parseZeroGEX(text);
}

function parseZeroGEX(text) {
  const get = (label) => {
    const m = text.match(new RegExp(label + ":\\s*([\\d,.]+)", "i"));
    return m ? parseFloat(m[1].replace(/,/g, "")) : null;
  };
  const regimeMatch = text.match(/Modeled regime:\\s*(\\w+)/i);
  const netMatch = text.match(/Net dealer gamma at spot:\\s*([\\u2212\\-\\$0-9.,]+[BM])/i);
  return {
    spot: get("Spot the levels were computed against"),
    flip: get("Gamma flip"),
    callWall: get("Call wall"),
    putWall: get("Put wall"),
    regime: regimeMatch ? regimeMatch[1].toLowerCase() : "unknown",
    netGex: netMatch ? netMatch[1] : null,
  };
}

function parseNetGex(raw) {
  if (!raw) return null;
  const num = parseFloat(raw.replace(/[\\u2212\\-$,]/g, "").replace("B", "e9").replace("M", "e6"));
  return isNaN(num) ? null : (raw.includes("\\u2212") || raw.includes("-") ? -num : num);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "GITHUB_TOKEN not set in Vercel env vars" });
  }

  try {
    const getRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${HISTORY_PATH}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }
    );
    let history = [];
    let sha = null;
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
      history = JSON.parse(Buffer.from(data.content, "base64").toString());
    }

    if (req.method === "GET") {
      return res.status(200).json(history);
    }

    const zg = await fetchZeroGEX();
    const entry = {
      ts: Date.now(),
      spot: zg.spot,
      flip: zg.flip,
      netGex: parseNetGex(zg.netGex),
      regime: zg.regime,
    };
    history.push(entry);

    const cutoff = Date.now() - MAX_DAYS * 86400000;
    history = history.filter(e => e.ts >= cutoff);
    // Keep at most one point every 15 minutes for denser 5-day chart
    const by15 = {};
    history.forEach(e => {
      const key = Math.floor(e.ts / (15 * 60 * 1000));
      by15[key] = e;
    });
    history = Object.values(by15).sort((a, b) => a.ts - b.ts);
    // Cap total points so the file stays small
    if (history.length > 500) history = history.slice(-500);

    const content = Buffer.from(JSON.stringify(history, null, 2)).toString("base64");
    const putRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${HISTORY_PATH}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `Update gamma history ${new Date().toISOString()}`,
          content,
          sha,
        }),
      }
    );
    if (!putRes.ok) {
      const err = await putRes.text();
      return res.status(500).json({ error: "GitHub update failed", details: err });
    }

    return res.status(200).json({ ok: true, count: history.length, latest: entry });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}