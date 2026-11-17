const ZEROGEX_MCP = "https://zerogex.io/mcp";
const ALGOX_BASE = "https://algoxflow.com/v1/gamma";
const POLL_INTERVAL = 60000;
const ES_MULTIPLIER = 10;
const MAX_HISTORY_DAYS = 5;
const NEAR_SPOT_PTS = 500;
const NEAR_SPOT_STEP = 25;
const HISTORY_POST_INTERVAL = 30 * 60 * 1000;
const ALL_SYMBOLS = ["ES", "SPX", "SPY", "NQ", "NDX", "QQQ"];
const COLORS = {
  ES: "#58a6ff",
  SPX: "#3fb950",
  SPY: "#d29922",
  NQ: "#f85149",
  NDX: "#bc8cff",
  QQQ: "#79c0ff",
};

const YAHOO_MAP = {
  ES: "ES=F",
  SPX: "^GSPC",
  SPY: "SPY",
  NQ: "NQ=F",
  NDX: "^NDX",
  QQQ: "QQQ",
};

const ALGOX_MAP = {
  ES: "SPY",
  SPX: "SPY",
  SPY: "SPY",
  NQ: "QQQ",
  NDX: "QQQ",
  QQQ: "QQQ",
};

const SCALE_MAP = {
  ES: 10,
  SPX: 10,
  SPY: 1,
  NQ: 40,
  NDX: 40,
  QQQ: 1,
};

const SQRT_252 = 15.87;

let chart = null;
let historyChart = null;
let metricsChart = null;
let multiChart = null;
let pollTimer = null;
let prevTnx = null;
let prevOil = null;
let prevVix = null;
let lastHistoryPost = 0;
let currentSymbol = "ES";

const els = {
  tickerSelect: document.getElementById("tickerSelect"),
  loadBtn: document.getElementById("loadBtn"),
  status: document.getElementById("status"),
  spotLevel: document.getElementById("spotLevel"),
  flipLevel: document.getElementById("flipLevel"),
  callWall: document.getElementById("callWall"),
  putWall: document.getElementById("putWall"),
  netGex: document.getElementById("netGex"),
  vixPrice: document.getElementById("vixPrice"),
  impliedMove: document.getElementById("impliedMove"),
  regime: document.getElementById("regime"),
  meta: document.getElementById("meta"),
  canvas: document.getElementById("gexChart"),
  historyCanvas: document.getElementById("historyChart"),
  metricsCanvas: document.getElementById("metricsChart"),
  multiCanvas: document.getElementById("multiHistoryChart"),
  esPrice: document.getElementById("esPrice"),
  tnxPrice: document.getElementById("tnxPrice"),
  oilPrice: document.getElementById("oilPrice"),
  timeframe: document.getElementById("timeframe"),
  longProb: document.getElementById("longProb"),
  shortProb: document.getElementById("shortProb"),
  straddleProb: document.getElementById("straddleProb"),
  biasLabel: document.getElementById("biasLabel"),
  schwabOverlay: document.getElementById("schwabOverlay"),
  schwabNote: document.getElementById("schwabNote"),
  schwabSpot: document.getElementById("schwabSpot"),
  schwabFlip: document.getElementById("schwabFlip"),
  schwabCall: document.getElementById("schwabCall"),
  schwabPut: document.getElementById("schwabPut"),
  schwabNet: document.getElementById("schwabNet"),
};

function setStatus(msg, isError = false) {
  if (!els.status) return;
  els.status.textContent = msg;
  els.status.style.color = isError ? "#f85149" : "#8b949e";
}

async function fetchYahoo(symbol) {
  const res = await fetch(`/api/yahoo?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`Yahoo proxy ${res.status}`);
  const data = await res.json();
  return data.price ?? null;
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
  if (!res.ok) throw new Error(`ZeroGEX ${res.status}`);
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

async function fetchAlgoX(symbol) {
  const algoxSym = ALGOX_MAP[symbol] || "SPY";
  const res = await fetch(`${ALGOX_BASE}/${algoxSym}?strikes=1`);
  if (!res.ok) throw new Error(`AlgoX ${res.status}`);
  return res.json();
}


async function fetchVixTerm() {
  try {
    const [vix, vix3m] = await Promise.all([
      fetchYahoo("^VIX"),
      fetchYahoo("^VIX3M")
    ]);
    return { vix, vix3m, ratio: (vix && vix3m) ? vix / vix3m : null };
  } catch { return null; }
}

async function fetchSchwabGex(symbol) {
  try {
    const res = await fetch(`/api/schwab-gex?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn("Schwab fetch failed", e);
    return null;
  }
}

function scaleStrike(value, symbol) {
  if (value == null) return null;
  const mult = SCALE_MAP[symbol] || 1;
  return Math.round(value * mult * 100) / 100;
}

function parseNetGex(raw) {
  if (!raw) return null;
  const negative = String(raw).includes("-");
  const cleaned = String(raw).replace(/[^0-9.BM]/g, "").replace("B", "e9").replace("M", "e6");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : (negative ? -num : num);
}

function formatGex(v) {
  if (v == null || isNaN(v)) return "--";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return sign + "$" + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(1) + "M";
  return sign + "$" + abs.toLocaleString();
}

function computeImpliedMove(spot, vix) {
  if (spot == null || vix == null || vix <= 0) return null;
  const dailyPct = vix / SQRT_252;
  const dailyPoints = spot * (dailyPct / 100);
  return {
    pct: dailyPct,
    points: dailyPoints,
    low: spot - dailyPoints,
    high: spot + dailyPoints,
  };
}

async function loadHistory() {
  try {
    const res = await fetch("/api/history?t=" + Date.now());
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        return data.filter(e => e && e.ts).sort((a, b) => a.ts - b.ts);
      }
    }
  } catch (e) {}
  try {
    const res = await fetch("/history.json?t=" + Date.now());
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        return data.filter(e => e && e.ts).sort((a, b) => a.ts - b.ts);
      }
    }
  } catch (e) {}
  return [];
}

async function postHistorySnapshot() {
  const now = Date.now();
  if (now - lastHistoryPost < HISTORY_POST_INTERVAL) return;
  lastHistoryPost = now;
  try {
    await fetch("/api/history", { method: "POST" });
  } catch (e) {
    console.warn("History post failed", e);
  }
}

function filterHist(hist, symbol) {
  return hist.filter(e => (e.symbol || "ES") === symbol);
}

async function renderHistoryChart(hist, symbol) {
  if (!els.historyCanvas) return;
  const filtered = filterHist(hist, symbol);
  const labels = filtered.map(e => new Date(e.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  const values = filtered.map(e => e.netGex);
  const colors = values.map(v => (v >= 0 ? "#3fb950" : "#f85149"));

  if (historyChart) historyChart.destroy();

  // Fetch 5d price series for right axis (best-effort)
  let priceData = labels.map(() => null);
  try {
    const ySym = symbol === "ES" ? "ES=F" : (symbol === "NQ" ? "NQ=F" : symbol);
    const yRes = await fetch(`/api/yahoo?symbol=${encodeURIComponent(ySym)}&range=5d&interval=15m`);
    if (yRes.ok) {
      const yData = await yRes.json();
      const series = yData.series || [];
      if (series.length && filtered.length) {
        priceData = filtered.map(e => {
          let best = null, bestDiff = Infinity;
          for (const p of series) {
            const d = Math.abs(p.t - e.ts);
            if (d < bestDiff) { bestDiff = d; best = p.c; }
          }
          return bestDiff < 30 * 60 * 1000 ? best : null;
        });
      }
    }
  } catch (e) { /* price overlay optional */ }

  historyChart = new Chart(els.historyCanvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Net GEX",
          data: values,
          borderColor: COLORS[symbol] || "#58a6ff",
          backgroundColor: "rgba(88,166,255,0.1)",
          fill: true,
          tension: 0.2,
          pointBackgroundColor: colors,
          pointRadius: 3,
          yAxisID: "y",
        },
        {
          label: "Price",
          data: priceData,
          borderColor: "#d2a8ff",
          backgroundColor: "transparent",
          tension: 0.2,
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y1",
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: true, text: `5-Day Net GEX Trend \u2014 ${symbol} (${filtered.length} points)`, color: "#e6edf3" },
        tooltip: {
          callbacks: {
            label: (ctx) => "Net GEX: " + formatGex(ctx.parsed.y)
          }
        }
      },
      scales: {
        x: { ticks: { color: "#8b949e", maxTicksLimit: 14 }, grid: { color: "#30363d" } },
        y: {
          ticks: {
            color: "#8b949e",
            callback: (v) => formatGex(v)
          },
          grid: { color: "#30363d" },
          position: "left",
        },
        y1: {
          position: "right",
          title: { display: true, text: "Price", color: "#d2a8ff" },
          ticks: { color: "#d2a8ff" },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

function renderMetricsChart(hist, symbol) {
  if (!els.metricsCanvas) return;
  const filtered = filterHist(hist, symbol).filter(e => e.long != null || e.short != null || e.straddle != null);
  const labels = filtered.map(e => new Date(e.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  const longVals = filtered.map(e => e.long ?? null);
  const shortVals = filtered.map(e => e.short ?? null);
  const straddleVals = filtered.map(e => e.straddle ?? null);

  if (metricsChart) metricsChart.destroy();

  metricsChart = new Chart(els.metricsCanvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Long %", data: longVals, borderColor: "#3fb950", backgroundColor: "rgba(63,185,80,0.1)", tension: 0.2, pointRadius: 2, fill: false },
        { label: "Short %", data: shortVals, borderColor: "#f85149", backgroundColor: "rgba(248,81,73,0.1)", tension: 0.2, pointRadius: 2, fill: false },
        { label: "Straddle %", data: straddleVals, borderColor: "#d29922", backgroundColor: "rgba(210,153,34,0.1)", tension: 0.2, pointRadius: 2, fill: false },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { color: "#e6edf3" } },
        title: { display: true, text: `Indicator Metrics History \u2014 ${symbol} (${filtered.length} points)`, color: "#e6edf3" },
      },
      scales: {
        x: { ticks: { color: "#8b949e", maxTicksLimit: 12 }, grid: { color: "#30363d" } },
        y: { min: 0, max: 100, ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
      },
    },
  });
}

function renderMultiChart(hist) {
  if (!els.multiCanvas) return;
  const bySym = {};
  ALL_SYMBOLS.forEach(s => { bySym[s] = hist.filter(e => (e.symbol || "ES") === s); });

  const allTs = [...new Set(hist.map(e => e.ts))].sort((a, b) => a - b);
  const labels = allTs.map(ts => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));

  const selected = (typeof currentSymbol !== "undefined" ? currentSymbol : "ES");
  const datasets = ALL_SYMBOLS.map(sym => {
    const points = bySym[sym];
    const map = Object.fromEntries(points.map(e => [e.ts, e.netGex]));
    const raw = allTs.map(ts => map[ts] ?? null);
    const absVals = raw.filter(v => v != null).map(Math.abs);
    const maxAbs = absVals.length ? Math.max(...absVals) : 1;
    // Normalize to -100..100 of own range so trends remain visible regardless of absolute scale
    const norm = raw.map(v => v == null ? null : (v / maxAbs) * 100);
    return {
      label: sym,
      data: norm,
      rawData: raw,               // keep original for tooltip
      borderColor: COLORS[sym],
      backgroundColor: "transparent",
      tension: 0.2,
      pointRadius: 2,
      borderWidth: sym === selected ? 3 : 1.5,
      spanGaps: true,
    };
  });

  if (multiChart) multiChart.destroy();

  multiChart = new Chart(els.multiCanvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { color: "#e6edf3" } },
        title: { display: true, text: "5-Day Net GEX \u2014 All Tickers", color: "#e6edf3" },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const raw = ctx.dataset.rawData ? ctx.dataset.rawData[ctx.dataIndex] : ctx.parsed.y;
              return `${ctx.dataset.label}: ${formatGex(raw)} (norm ${ctx.parsed.y.toFixed(0)})`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: "#8b949e", maxTicksLimit: 14 }, grid: { color: "#30363d" } },
        y: {
          title: { display: true, text: "Normalized (% of own range)", color: "#8b949e" },
          ticks: { color: "#8b949e", callback: (v) => v.toFixed(0) },
          grid: { color: "#30363d" },
          suggestedMin: -110,
          suggestedMax: 110,
        },
      },
    },
  });
}

function computeScores(zg, hist) {
  const { spot, flip, callWall, putWall, regime } = zg;
  const net = parseNetGex(zg.netGex);
  if (spot == null || flip == null) return { long: 0, short: 0, straddle: 0, bias: "Insufficient data" };

  const flipDistPct = Math.abs(spot - flip) / spot * 100;
  const nearFlip = flipDistPct < 0.4;
  const regimeLong = regime === "long" || regime === "positive";
  const regimeShort = regime === "short" || regime === "negative";
  const spotAboveFlip = spot > flip;
  const nearPut = putWall != null && Math.abs(spot - putWall) < 60;
  const nearCall = callWall != null && Math.abs(spot - callWall) < 60;

  let slopeUp = false;
  let slopeDown = false;
  if (hist && hist.length >= 3) {
    const recent = hist.slice(-3).map(e => e.netGex).filter(v => v != null);
    if (recent.length >= 2) {
      const delta = recent[recent.length - 1] - recent[0];
      slopeUp = delta > 0;
      slopeDown = delta < 0;
    }
  }

  let long = 0;
  if (regimeLong && spotAboveFlip) long += 40;
  if (nearPut) long += 20;
  if (slopeUp || (!slopeDown && hist && hist.length > 0)) long += 15;
  if (!nearFlip) long += 10;
  long = Math.min(100, Math.max(0, long));

  let short = 0;
  if (regimeShort && !spotAboveFlip) short += 40;
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

function renderIndicator(zg, hist) {
  const scores = computeScores(zg, hist);
  if (els.longProb) els.longProb.textContent = `Long: ${scores.long}%`;
  if (els.shortProb) els.shortProb.textContent = `Short: ${scores.short}%`;
  if (els.straddleProb) els.straddleProb.textContent = `Straddle: ${scores.straddle}%`;
  if (els.biasLabel) els.biasLabel.textContent = `Bias: ${scores.bias}`;
  return scores;
}

async function updateTickerGexBoxes() {
  const results = await Promise.allSettled(ALL_SYMBOLS.map(s => fetchZeroGEX(s)));
  results.forEach((r, i) => {
    const sym = ALL_SYMBOLS[i];
    const box = document.getElementById(`gex-${sym}`);
    if (!box) return;
    const valEl = box.querySelector(".val");
    if (r.status === "fulfilled" && r.value && r.value.netGex) {
      const n = parseNetGex(r.value.netGex);
      valEl.textContent = formatGex(n);
      valEl.style.color = n >= 0 ? "#3fb950" : "#f85149";
    } else {
      valEl.textContent = "--";
      valEl.style.color = "#8b949e";
    }
  });
}


const SCHWAB_CACHE_KEY = "gex_schwab_last";
function loadSchwabCache() {
  try { return JSON.parse(localStorage.getItem(SCHWAB_CACHE_KEY) || "null"); } catch { return null; }
}
function saveSchwabCache(s) {
  if (!s || !s.strikes || !s.strikes.length) return;
  try { localStorage.setItem(SCHWAB_CACHE_KEY, JSON.stringify({
    spot: s.spot, gammaFlip: s.gammaFlip, callWall: s.callWall, putWall: s.putWall,
    netGex: s.netGex, strikes: s.strikes, gex: s.gex, ts: Date.now()
  })); } catch {}
}

function updateSchwabBoxes(schwab) {
  const set = (el, val, color) => {
    if (!el) return;
    el.textContent = val != null ? (typeof val === "number" ? val.toLocaleString() : val) : "--";
    el.style.color = color || "#ffffff";
  };
  if (!schwab || !schwab.strikes || !schwab.strikes.length) {
    const cached = loadSchwabCache();
    if (cached) schwab = cached;
    else {
      set(els.schwabSpot, null);
      set(els.schwabFlip, null);
      set(els.schwabCall, null);
      set(els.schwabPut, null);
      set(els.schwabNet, null);
      return;
    }
  } else {
    saveSchwabCache(schwab);
  }
  set(els.schwabSpot, schwab.spot);
  set(els.schwabFlip, schwab.gammaFlip != null ? schwab.gammaFlip : '--');
  set(els.schwabCall, schwab.callWall);
  set(els.schwabPut, schwab.putWall);
  const net = schwab.netGex;
  set(els.schwabNet, net != null ? formatGex(net) : null, net >= 0 ? "#00ffff" : "#ff64ff");
}

async function fetchAll() {
  const symbol = (els.tickerSelect && els.tickerSelect.value) || "ES";
  currentSymbol = symbol;
  const showSchwab = true; // always show side-by-side
  if (els.schwabNote) els.schwabNote.textContent = showSchwab ? "(fetching Schwab...)" : "";
  setStatus(`Loading ${symbol} levels + profile + markets\u2026`);
  try {
    const yahooSym = YAHOO_MAP[symbol] || symbol;
    const promises = [
      fetchZeroGEX(symbol),
      fetchAlgoX(symbol),
      fetchYahoo(yahooSym),
      fetchYahoo("^TNX"),
      fetchYahoo("BZ=F"),
      fetchYahoo("^VIX"),
    ];
    if (showSchwab) promises.push(fetchSchwabGex(symbol));
    const results = await Promise.allSettled(promises);
    const [zgRes, algoxRes, price, tnx, oil, vix] = results;
    const schwab = showSchwab && results[6] && results[6].status === "fulfilled" ? results[6].value : null;
    if (showSchwab && els.schwabNote) {
      els.schwabNote.textContent = schwab ? "(Schwab overlay active)" : "(Schwab unavailable)";
    }
    const zg = zgRes.status === "fulfilled" ? zgRes.value : null;
    const algox = algoxRes.status === "fulfilled" ? algoxRes.value : null;
    if (!zg) console.warn("ZeroGEX failed", zgRes.reason);

    if (zg) renderLevels(zg, symbol);
    updateSchwabBoxes(schwab);
    updateEsQuotes(schwab);
    updatePutCall(schwab);
    updateSkew(schwab, symbol);
    updateMarketPrices(price?.status === "fulfilled" ? price.value : null,
      tnx?.status === "fulfilled" ? tnx.value : null,
      oil?.status === "fulfilled" ? oil.value : null,
      vix?.status === "fulfilled" ? vix.value : null,
      symbol,
      zg?.spot,
      schwab);
    const hist = await loadHistory();
    const symbolHist = filterHist(hist, symbol);
    if (zg) renderIndicator(zg, symbolHist);
    const focusSpot = schwab?.spot ?? zg?.spot ?? (price?.status === "fulfilled" ? price.value : null);
    renderChart(algox, focusSpot, zg, symbol, schwab);
    window._lastHist = hist;
    window._lastSymbol = symbol;
    renderHistoryChart(hist, symbol);
    renderSkewChart(hist, symbol);
    renderMetricsChart(hist, symbol);
    renderMultiChart(hist);
    updateTickerGexBoxes();
    postHistorySnapshot();
    setStatus(`Live \u00b7 ${symbol} ZeroGEX + AlgoX`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, true);
  }
}

function arrowFor(current, previous) {
  if (current == null || previous == null) return "";
  if (current > previous) return ' <span style="color:#3fb950">\u25B2</span>';
  if (current < previous) return ' <span style="color:#f85149">\u25BC</span>';
  return "";
}

function updateMarketPrices(price, tnx, oil, vix, symbol, spot, schwab) {
  if (els.esPrice) els.esPrice.textContent = `${symbol}: ${price != null ? price.toLocaleString() : "--"}`;
  const tnxArrow = arrowFor(tnx, prevTnx);
  if (els.tnxPrice) els.tnxPrice.innerHTML = `10Y: ${tnx != null ? tnx.toFixed(3) + "%" : "--"}${tnxArrow}`;
  if (tnx != null) prevTnx = tnx;
  const oilArrow = arrowFor(oil, prevOil);
  if (els.oilPrice) els.oilPrice.innerHTML = `BZ Oil: ${oil != null ? oil.toFixed(2) : "--"}${oilArrow}`;
  if (oil != null) prevOil = oil;
  const vixArrow = arrowFor(vix, prevVix);
  if (els.vixPrice) els.vixPrice.innerHTML = `VIX: ${vix != null ? vix.toFixed(2) : "--"}${vixArrow}`;
  if (vix != null) prevVix = vix;

  const refSpot = spot || price;
  const im = computeImpliedMove(refSpot, vix);
  if (els.impliedMove) {
    if (im) {
      let todayMove = null;
      if (typeof schwab !== 'undefined' && schwab && schwab.esQuotes && schwab.esQuotes[0]) {
        const q = schwab.esQuotes[0];
        const ref = q.open ?? q.prevClose;
        if (ref != null && q.last != null) todayMove = q.last - ref;
      }
      els.impliedMove.innerHTML = `Implied Move: \u00b1${im.points.toFixed(1)} pts (${im.pct.toFixed(2)}%)<br><span style="color:#8b949e;font-size:0.85rem">Today: ${todayMove != null ? (todayMove >= 0 ? "+" : "") + todayMove.toFixed(1) : "--"} pts</span>`;
    } else {
      els.impliedMove.textContent = "Implied Move: --";
    }
  }

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (els.timeframe) els.timeframe.textContent = `Intraday \u00b7 Last refresh: ${timeStr}`;
}

function renderLevels(zg, symbol) {
  const { spot, flip, callWall, putWall, regime, netGex } = zg;
  if (els.spotLevel) els.spotLevel.textContent = `${symbol} Spot: ${spot != null ? spot.toLocaleString() : "--"}`;
  if (els.flipLevel) els.flipLevel.textContent = `Gamma Flip: ${flip != null ? flip.toLocaleString() : "--"}`;
  if (els.callWall) els.callWall.textContent = `Call Wall: ${callWall != null ? callWall.toLocaleString() : "--"}`;
  if (els.putWall) els.putWall.textContent = `Put Wall: ${putWall != null ? putWall.toLocaleString() : "--"}`;
  if (els.netGex) els.netGex.textContent = `Net GEX: ${netGex || "--"}`;
  if (els.regime) {
    els.regime.textContent = `Regime: ${regime.toUpperCase()}`;
    els.regime.className = "level regime " + (regime === "short" || regime === "negative" ? "negative" : regime === "long" || regime === "positive" ? "positive" : "");
  }
  if (els.meta) els.meta.textContent = `Levels: ZeroGEX free delayed (${symbol}) \u00b7 Profile: AlgoX`;
}

function renderChart(algox, focusSpot, zg, symbol, schwab) {
  const canvas = els.canvas;
  if (!canvas) {
    console.warn("gexChart canvas missing");
    return;
  }
  if (canvas.clientHeight < 50) {
    console.warn("Canvas height too small, retrying chart in 300ms");
    setTimeout(() => renderChart(algox, focusSpot, zg, symbol, schwab), 300);
    return;
  }

  if (!algox || !algox.strikes || algox.strikes.length === 0) {
    setStatus("AlgoX profile unavailable. Levels still shown.", true);
    if (!chart) {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#8b949e";
      ctx.font = "14px sans-serif";
      ctx.fillText("Gamma profile unavailable (AlgoX). Levels still shown above.", 20, 40);
    }
    return;
  }

  let strikes = algox.strikes.map(s => ({
    strike: scaleStrike(s.strike, symbol),
    gex: s.net_gex_millions
  })).filter(s => s.strike != null).sort((a, b) => a.strike - b.strike);

  if (focusSpot != null) {
    const nearMin = focusSpot - NEAR_SPOT_PTS;
    const nearMax = focusSpot + NEAR_SPOT_PTS;
    const far = strikes.filter(s => s.strike < nearMin || s.strike > nearMax);
    const near = strikes.filter(s => s.strike >= nearMin && s.strike <= nearMax);
    const binned = {};
    near.forEach(s => {
      const key = Math.round(s.strike / NEAR_SPOT_STEP) * NEAR_SPOT_STEP;
      if (!binned[key]) binned[key] = { strike: key, gex: 0, n: 0 };
      binned[key].gex += s.gex;
      binned[key].n += 1;
    });
    const nearBinned = Object.values(binned).map(b => ({ strike: b.strike, gex: b.gex / b.n }));
    strikes = [...far, ...nearBinned].sort((a, b) => a.strike - b.strike);
  }

  const labels = strikes.map(s => s.strike.toLocaleString());
  const values = strikes.map(s => s.gex);
  const colors = values.map(v => (v >= 0 ? "#3fb950" : "#f85149"));

  let schwabOverlay = null;
  let schwabMaxAbs = 0;
  if ((!schwab || !schwab.strikes || !schwab.strikes.length) && typeof loadSchwabCache === 'function') schwab = loadSchwabCache() || schwab;
  if (schwab && schwab.strikes && schwab.gex) {
    const schwabMap = {};
    schwab.strikes.forEach((s, i) => {
      // Do not apply ES/SPX 10x scale to Schwab $SPX strikes; chart is already in cash levels
      const scaled = (symbol === "ES" || symbol === "SPX") ? s : scaleStrike(s, symbol);
      if (scaled != null) schwabMap[scaled] = schwab.gex[i];
    });
    // Build Schwab series aligned to the same strike keys used by the chart
    const chartStrikes = strikes.map(s => s.strike);
    schwabOverlay = chartStrikes.map(cs => {
      let best = null, bestDiff = Infinity;
      Object.keys(schwabMap).forEach(k => {
        const sk = parseFloat(k);
        const d = Math.abs(sk - cs);
        if (d < bestDiff && d <= NEAR_SPOT_STEP) {
          bestDiff = d;
          best = schwabMap[k];
        }
      });
      const v = best != null ? best / 1e6 : 0;
      schwabMaxAbs = Math.max(schwabMaxAbs, Math.abs(v));
      return v;
    });
    // Normalize Schwab magnitudes to match ZeroGEX scale so both are comparable
    if (schwabMaxAbs > 0 && values.length) {
      const algoxMax = Math.max(...values.map(v => Math.abs(v || 0)), 1);
      const factor = algoxMax / schwabMaxAbs;
      schwabOverlay = schwabOverlay.map(v => v * factor);
      schwabMaxAbs = algoxMax;
    }
  }
  const algoxMaxAbs = Math.max(...values.map(v => Math.abs(v || 0)), 0);
  const xMax = Math.max(algoxMaxAbs, schwabMaxAbs) * 1.15 || 100;

  function findIdx(target) {
    if (target == null) return -1;
    let best = 0, bestDiff = Infinity;
    strikes.forEach((s, i) => {
      const d = Math.abs(s.strike - target);
      if (d < bestDiff) { bestDiff = d; best = i; }
    });
    return best;
  }

  if (chart) {
    try { chart.destroy(); } catch (e) { console.warn("chart.destroy failed", e); }
    chart = null;
  }

  const levelsPlugin = {
    id: "levelsLines",
    afterDraw(chartInstance) {
      const yScale = chartInstance.scales.y;
      const xScale = chartInstance.scales.x;
      if (!yScale || !xScale) return;
      const ctx = chartInstance.ctx;
      // Draw session volume profile on the right side
      if (schwab && schwab.volStrikes && schwab.volValues) {
        const volMap = {};
        schwab.volStrikes.forEach((vs, i) => { volMap[vs] = schwab.volValues[i]; });
        let maxVol = 1;
        Object.values(volMap).forEach(v => { if (v > maxVol) maxVol = v; });
        const meta = chartInstance.getDatasetMeta(0);
        meta.data.forEach((bar, i) => {
          const strike = strikes[i].strike;
          let best = 0, bestDiff = Infinity;
          Object.keys(volMap).forEach(k => {
            const d = Math.abs(parseFloat(k) - strike);
            if (d < bestDiff && d <= NEAR_SPOT_STEP * 2) { bestDiff = d; best = volMap[k]; }
          });
          if (best <= 0 || !bar) return;
          const frac = best / maxVol;
          const barH = bar.height * 0.85;
          const width = (xScale.right - xScale.left) * 0.4 * frac;
          ctx.save();
          ctx.fillStyle = "rgba(88,166,255,0.55)";
          ctx.fillRect(xScale.right - width, bar.y - barH / 2, width, barH);
          ctx.restore();
        });
      }


      const draw = (idx, color, label) => {
        if (idx < 0) return;
        const y = yScale.getPixelForValue(idx);
        if (y < yScale.top || y > yScale.bottom) return;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(xScale.left, y);
        ctx.lineTo(xScale.right, y);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.font = "11px sans-serif";
        ctx.fillText(label, xScale.left + 6, y - 4);
        ctx.restore();
      };
      const spot = schwab?.spot ?? focusSpot;
      const flip = schwab?.gammaFlip ?? zg?.flip;
      const call = schwab?.callWall ?? zg?.callWall;
      const put = schwab?.putWall ?? zg?.putWall;
      draw(findIdx(spot), "#ffffff", "Spot " + (spot != null ? spot.toLocaleString() : ""));
      draw(findIdx(flip), "#00ffff", "Flip " + (flip != null ? flip.toLocaleString() : ""));
      draw(findIdx(call), "#00ffff", "Call " + (call != null ? call.toLocaleString() : ""));
      draw(findIdx(put), "#ff64ff", "Put " + (put != null ? put.toLocaleString() : ""));
    }
  };

  try {
  const schwabColors = (schwabOverlay || []).map(v => v == null ? "transparent" : (v >= 0 ? "rgba(0,255,255,0.85)" : "rgba(255,100,255,0.85)"));
  chart = new Chart(els.canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "ZeroGEX / AlgoX ($M)",
          data: values,
          backgroundColor: colors,
          borderWidth: 0,
          categoryPercentage: 0.8,
          barPercentage: 0.45,
        },
        {
          label: "Schwab ($M)",
          data: schwabOverlay || [],
          backgroundColor: schwabColors,
          minBarLength: 2,
          borderWidth: 0,
          categoryPercentage: 0.8,
          barPercentage: 0.45,
          xAxisID: "x",
        }
      ]
    },
    plugins: [levelsPlugin],
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { 
          display: true, 
          position: "top",
          labels: { 
            color: "#ffffff",
            font: { size: 12 },
            generateLabels: () => [
              { text: "ZeroGEX +", fillStyle: "#3fb950", strokeStyle: "#3fb950", lineWidth: 0, fontColor: "#ffffff" },
              { text: "ZeroGEX −", fillStyle: "#f85149", strokeStyle: "#f85149", lineWidth: 0, fontColor: "#ffffff" },
              { text: "Schwab +", fillStyle: "rgba(0,255,255,0.85)", strokeStyle: "#00ffff", lineWidth: 0, fontColor: "#00ffff" },
              { text: "Schwab −", fillStyle: "rgba(255,100,255,0.85)", strokeStyle: "#ff64ff", lineWidth: 0, fontColor: "#ff64ff" }
            ]
          }
        },
        title: {
          display: true,
          text: `${symbol} Gamma Profile (full spread) \u00b7 25-pt bars within \u00b1500 of spot`,
          color: "#e6edf3"
        },
      },
      scales: {
        x: {
          title: { display: true, text: "Net GEX ($M)", color: "#8b949e" },
          ticks: { color: "#8b949e" },
          grid: { color: "#30363d" },
          suggestedMin: -xMax,
          suggestedMax: xMax
        },
        x1: {
          title: { display: true, text: "Open Interest", color: "#8b949e" },
          ticks: { color: "#8b949e" },
          grid: { drawOnChartArea: false },
          position: "top",
        },
        y: {
          ticks: { color: "#8b949e" },
          grid: { color: "#30363d" }
        }
      }
    }
  });
  } catch (e) {
    console.error("Chart creation failed", e);
    setStatus("Chart render error. Levels still shown.", true);
  }
}

if (els.loadBtn) els.loadBtn.addEventListener("click", fetchAll);
if (els.tickerSelect) els.tickerSelect.addEventListener("change", fetchAll);

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(fetchAll, POLL_INTERVAL);
}



function updatePutCall(schwab) {
  const el = document.getElementById("pcBox");
  if (!el) return;
  if (!schwab || (schwab.pcVol == null && schwab.pcOI == null)) {
    el.textContent = "--";
    return;
  }
  const vol = schwab.pcVol != null ? schwab.pcVol.toFixed(2) : "--";
  const oi = schwab.pcOI != null ? schwab.pcOI.toFixed(2) : "--";
  el.innerHTML = `${vol} / ${oi}`;
}

function updateEsQuotes(schwab) {
  const box = document.getElementById("schwabSpot");
  if (!box) return;
  if (!schwab || !schwab.esQuotes || !schwab.esQuotes.length) {
    box.textContent = '--';
    return;
  }
  const front = schwab.esQuotes[0];
  const others = schwab.esQuotes.slice(1, 3).map(q => 
    `<span style="font-size:0.75rem;color:#8b949e;margin-left:6px">${q.symbol.replace("/","")}: ${q.last?.toLocaleString() ?? "--"}</span>`
  ).join("");
  box.innerHTML = `${front.symbol.replace("/","")}<br>${front.last?.toLocaleString() ?? "--"}${others}`;
}



const SKEW_STORE_KEY = "gex_skew_rr";
function loadSkewStore() {
  try { return JSON.parse(localStorage.getItem(SKEW_STORE_KEY) || "[]"); } catch { return []; }
}
function saveSkewPoint(rr, symbol) {
  if (rr == null) return;
  const store = loadSkewStore();
  store.push({ ts: Date.now(), symbol: symbol || "ES", skewRR: rr });
  const cutoff = Date.now() - 5 * 24 * 60 * 60 * 1000;
  const trimmed = store.filter(p => p.ts > cutoff);
  localStorage.setItem(SKEW_STORE_KEY, JSON.stringify(trimmed.slice(-500)));
}

let skewChart = null;
function renderSkewChart(hist, symbol) {
  const canvas = document.getElementById("skewChart");
  if (!canvas) return;
  const serverPts = (hist || []).filter(e => (e.symbol || "ES") === symbol && e.skewRR != null)
    .map(e => ({ ts: e.ts, skewRR: e.skewRR }));
  const localPts = loadSkewStore().filter(p => (p.symbol || "ES") === symbol);
  const points = [...serverPts, ...localPts].sort((a, b) => a.ts - b.ts);
  const labels = points.map(e => new Date(e.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  const values = points.map(e => e.skewRR);
  if (skewChart) skewChart.destroy();
  skewChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "25Δ Risk Reversal (vol pts)",
        data: values,
        borderColor: "#d29922",
        backgroundColor: "rgba(210,153,34,0.1)",
        fill: true,
        tension: 0.2,
        pointRadius: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { color: "#e6edf3" } },
        title: { display: true, text: "25-Delta Risk Reversal (front month)", color: "#e6edf3" }
      },
      scales: {
        x: { ticks: { color: "#8b949e", maxTicksLimit: 12 }, grid: { color: "#30363d" } },
        y: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" } }
      }
    }
  });
}

function updateSkew(schwab, symbol) {
  const el = document.getElementById("skewRR");
  if (!el) return;
  if (schwab && schwab.skewRR != null) {
    el.textContent = `25Δ RR: ${schwab.skewRR.toFixed(2)} vol pts`;
    saveSkewPoint(schwab.skewRR, symbol);
    renderSkewChart(window._lastHist || [], symbol);
    el.style.color = schwab.skewRR > 0 ? "#f85149" : "#3fb950";
  } else {
    el.textContent = "25Δ RR: --";
  }
}

fetchAll();
startPolling();
