const GITHUB_OWNER = "Cmagaurn";
const GITHUB_REPO = "gex-streaming-dashboard";
const HISTORY_PATH = "history.json";
const ZEROGEX_MCP = "https://zerogex.io/mcp";
const MAX_DAYS = 5;
const BUCKET_MS = 5 * 60 * 1000;
const SYMBOLS = ["ES", "SPX", "SPY", "NQ", "NDX", "QQQ"];

function isWithinCollectionWindow(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    hour: "numeric",
    hour12: false,
    minute: "numeric",
  });
  const parts = fmt.formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekday = get("weekday");
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  const minutesOfDay = hour * 60 + minute;
  if (weekday === "Sun") return minutesOfDay >= 15 * 60;
  if (["Mon", "Tue", "Wed", "Thu"].includes(weekday)) return true;
  if (weekday === "Fri") return minutesOfDay < 20 * 60;
  return false;
}

async function fetchZeroGEX(symbol) {
  const res = await fetch(ZEROGEX_MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_gamma_levels", arguments: { symbol } }
    })
  });
  if (!res.ok) throw new Error(`ZeroGEX ${symbol} ${res.status}`);
  const json = await res.json();
  const text = json.result?.content?.[0]?.text || "";
  return parseZeroGEX(text);
}

function parseZeroGEX(text) {
  const getNum = (label) => {
    const idx = text.toLowerCase().indexOf(label.toLowerCase());
    if (idx < 0) return null;
    const after = text.slice(idx + label.length);
    const m = after.match(/[:\s]*([0-9,]+\.?[0-9]*)/);
    return m ? parseFloat(m[1].replace(/,/g, "")) : null;
  };
  const regimeLine = (text.match(/Modeled regime:[^\n]*/i) || [""])[0];
  let regime = "unknown";
  if (/short/i.test(regimeLine)) regime = "short";
  else if (/long/i.test(regimeLine)) regime = "long";
  const netLine = (text.match(/Net dealer gamma at spot:[^\n]*/i) || [""])[0];
  const netM = netLine.match(/(-?\$?[0-9.]+[BM])/i);
  return {
    spot: getNum("Spot the levels were computed against"),
    flip: getNum("Gamma flip"),
    callWall: getNum("Call wall"),
    putWall: getNum("Put wall"),
    regime,
    netGex: netM ? netM[1] : null,
  };
}

function parseNetGex(raw) {
  if (!raw) return null;
  const negative = String(raw).includes("-");
  const cleaned = String(raw).replace(/[^0-9.BM]/g, "").replace("B", "e9").replace("M", "e6");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : (negative ? -num : num);
}

function computeScores(zg, hist) {
  const { spot, flip, callWall, putWall, regime } = zg;
  const net = parseNetGex(zg.netGex);
  if (spot == null || flip == null) return { long: 0, short: 0, straddle: 0, bias: "Insufficient data" };
  const flipDistPct = Math.abs(spot - flip) / spot * 100;
  const nearFlip = flipDistPct < 0.4;
  const regimeLong = regime === "long" || regime === "positive";
  const regimeShort = regime === "short" || regime === "negative";
  const spotAbove = spot > flip;
  const nearPut = putWall != null && Math.abs(spot - putWall) < 60;
  const nearCall = callWall != null && Math.abs(spot - callWall) < 60;
  let slopeUp = false, slopeDown = false;
  if (hist && hist.length >= 3) {
    const recent = hist.slice(-3).map(e => e.netGex).filter(v => v != null);
    if (recent.length >= 2) {
      const delta = recent[recent.length - 1] - recent[0];
      slopeUp = delta > 0;
      slopeDown = delta < 0;
    }
  }
  let long = 0;
  if (regimeLong && spotAbove) long += 40;
  if (nearPut) long += 20;
  if (slopeUp || (!slopeDown && hist && hist.length > 0)) long += 15;
  if (!nearFlip) long += 10;
  long = Math.min(100, Math.max(0, long));
  let short = 0;
  if (regimeShort && !spotAbove) short += 40;
  if (nearCall) short += 20;
  if (slopeDown) short += 15;
  if (!nearFlip) short += 10;
  short = Math.min(100, Math.max(0, short));
  let straddle = 0;
  if (nearFlip) straddle += 50;
  if (net != null && Math.abs(net) > 1e9) straddle += 25;
  if (nearFlip || (regime !== "long" && regime !== "short")) straddle += 15;
  straddle = Math.min(100, Math.max(0, straddle));
  const total = long + short + straddle || 1;
  const longN = Math.round((long / total) * 100);
  const shortN = Math.round((short / total) * 100);
  const straddleN = Math.round((straddle / total) * 100);
  let bias = "Neutral";
  if (longN > shortN && longN > straddleN && longN >= 40) bias = "Long bias";
  else if (shortN > longN && shortN > straddleN && shortN >= 40) bias = "Short bias";
  else if (straddleN >= 40) bias = "Straddle / expansion bias";
  return { long: longN, short: shortN, straddle: straddleN, bias };
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
      if (!Array.isArray(history)) history = [];
    }

    if (req.method === "GET") {
      return res.status(200).json(history);
    }

    if (!isWithinCollectionWindow()) {
      return res.status(200).json({ ok: true, skipped: true, reason: "Outside collection window (Sun 3PM CDT – Fri 8PM CDT)" });
    }

    const now = Date.now();
    const newEntries = [];

    for (const symbol of SYMBOLS) {
      try {
        const zg = await fetchZeroGEX(symbol);
        const symbolHist = history.filter(e => e.symbol === symbol || (!e.symbol && symbol === "ES"));
        const scores = computeScores(zg, symbolHist);
        const entry = {
          ts: now,
          symbol,
          spot: zg.spot,
          flip: zg.flip,
          callWall: zg.callWall,
          putWall: zg.putWall,
          netGex: parseNetGex(zg.netGex),
          regime: zg.regime,
          long: scores.long,
          short: scores.short,
          straddle: scores.straddle,
          bias: scores.bias,
        };
        history.push(entry);
        newEntries.push(entry);
      } catch (e) {
        console.warn(`Failed ${symbol}:`, e.message);
      }
    }

    const cutoff = now - MAX_DAYS * 86400000;
    history = history.filter(e => e && e.ts >= cutoff);

    // Bucket per symbol per 5 min
    const byBucket = {};
    history.forEach(e => {
      const sym = e.symbol || "ES";
      const key = `${sym}:${Math.floor(e.ts / BUCKET_MS)}`;
      if (!byBucket[key] || e.ts > byBucket[key].ts) byBucket[key] = e;
    });
    history = Object.values(byBucket).sort((a, b) => a.ts - b.ts);

    if (history.length > 2400) history = history.slice(-2400);

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
      return res.status(500).json({ error: "GitHub update failed", details: err.slice(0, 300) });
    }

    return res.status(200).json({ ok: true, count: history.length, added: newEntries.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}