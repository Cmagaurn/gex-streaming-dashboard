const ZEROGEX_MCP = "https://zerogex.io/mcp";
const ALGOX_BASE = "https://algoxflow.com/v1/gamma";
const POLL_INTERVAL = 60000;
const ES_MULTIPLIER = 10;
const MAX_HISTORY_DAYS = 5;
const NEAR_SPOT_PTS = 500;
const NEAR_SPOT_STEP = 25;

let chart = null;
let historyChart = null;
let metricsChart = null;
let pollTimer = null;
let prevTnx = null;
let prevOil = null;

const els = {
  tickerInput: document.getElementById("tickerInput"),
  loadBtn: document.getElementById("loadBtn"),
  status: document.getElementById("status"),
  spotLevel: document.getElementById("spotLevel"),
  flipLevel: document.getElementById("flipLevel"),
  callWall: document.getElementById("callWall"),
  putWall: document.getElementById("putWall"),
  netGex: document.getElementById("netGex"),
  regime: document.getElementById("regime"),
  meta: document.getElementById("meta"),
  canvas: document.getElementById("gexChart"),
  historyCanvas: document.getElementById("historyChart"),
  metricsCanvas: document.getElementById("metricsChart"),
  esPrice: document.getElementById("esPrice"),
  tnxPrice: document.getElementById("tnxPrice"),
  oilPrice: document.getElementById("oilPrice"),
  timeframe: document.getElementById("timeframe"),
  longProb: document.getElementById("longProb"),
  shortProb: document.getElementById("shortProb"),
  straddleProb: document.getElementById("straddleProb"),
  biasLabel: document.getElementById("biasLabel"),
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

async function fetchAlgoXSPY() {
  const res = await fetch(`${ALGOX_BASE}/SPY?strikes=1`);
  if (!res.ok) throw new Error(`AlgoX ${res.status}`);
  return res.json();
}

function toES(value) {
  return value == null ? null : Math.round(value * ES_MULTIPLIER * 100) / 100;
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

async function loadHistory() {
  // Shared history only — same data on every device
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

function renderHistoryChart(hist) {
  if (!els.historyCanvas) return;
  const labels = hist.map(e => new Date(e.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  const values = hist.map(e => e.netGex);
  const colors = values.map(v => (v >= 0 ? "#3fb950" : "#f85149"));

  if (historyChart) historyChart.destroy();

  historyChart = new Chart(els.historyCanvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Net GEX",
        data: values,
        borderColor: "#58a6ff",
        backgroundColor: "rgba(88,166,255,0.1)",
        fill: true,
        tension: 0.2,
        pointBackgroundColor: colors,
        pointRadius: 3,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: true, text: `5-Day Net GEX Trend (${hist.length} points)`, color: "#e6edf3" },
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
          grid: { color: "#30363d" }
        },
      },
    },
  });
}

function renderMetricsChart(hist) {
  if (!els.metricsCanvas) return;
  const withScores = hist.filter(e => e.long != null || e.short != null || e.straddle != null);
  const labels = withScores.map(e => new Date(e.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  const longVals = withScores.map(e => e.long ?? null);
  const shortVals = withScores.map(e => e.short ?? null);
  const straddleVals = withScores.map(e => e.straddle ?? null);

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
        title: { display: true, text: `Indicator Metrics History (${withScores.length} points)`, color: "#e6edf3" },
      },
      scales: {
        x: { ticks: { color: "#8b949e", maxTicksLimit: 12 }, grid: { color: "#30363d" } },
        y: { min: 0, max: 100, ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
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

async function fetchAll() {
  setStatus("Loading ZeroGEX levels + AlgoX profile + markets\u2026");
  try {
    const [zg, algox, esPrice, tnx, oil] = await Promise.all([
      fetchZeroGEX("ES"),
      fetchAlgoXSPY().catch(() => null),
      fetchYahoo("ES=F").catch(() => null),
      fetchYahoo("^TNX").catch(() => null),
      fetchYahoo("BZ=F").catch(() => null),
    ]);

    renderLevels(zg);
    updateMarketPrices(esPrice, tnx, oil);
    const hist = await loadHistory();
    renderIndicator(zg, hist);
    renderChart(algox, zg.spot || esPrice, zg);
    renderHistoryChart(hist);
    renderMetricsChart(hist);
    setStatus("Live \u00b7 ZeroGEX levels + AlgoX profile (ES \u00d710)");
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

function updateMarketPrices(es, tnx, oil) {
  if (els.esPrice) els.esPrice.textContent = `/ES: ${es != null ? es.toLocaleString() : "--"}`;
  const tnxArrow = arrowFor(tnx, prevTnx);
  if (els.tnxPrice) els.tnxPrice.innerHTML = `10Y: ${tnx != null ? tnx.toFixed(3) + "%" : "--"}${tnxArrow}`;
  if (tnx != null) prevTnx = tnx;
  const oilArrow = arrowFor(oil, prevOil);
  if (els.oilPrice) els.oilPrice.innerHTML = `BZ Oil: ${oil != null ? oil.toFixed(2) : "--"}${oilArrow}`;
  if (oil != null) prevOil = oil;
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (els.timeframe) els.timeframe.textContent = `Intraday \u00b7 Last refresh: ${timeStr}`;
}

function renderLevels(zg) {
  const { spot, flip, callWall, putWall, regime, netGex } = zg;
  if (els.spotLevel) els.spotLevel.textContent = `ES Spot: ${spot != null ? spot.toLocaleString() : "--"}`;
  if (els.flipLevel) els.flipLevel.textContent = `Gamma Flip: ${flip != null ? flip.toLocaleString() : "--"}`;
  if (els.callWall) els.callWall.textContent = `Call Wall: ${callWall != null ? callWall.toLocaleString() : "--"}`;
  if (els.putWall) els.putWall.textContent = `Put Wall: ${putWall != null ? putWall.toLocaleString() : "--"}`;
  if (els.netGex) els.netGex.textContent = `Net GEX: ${netGex || "--"}`;
  if (els.regime) {
    els.regime.textContent = `Regime: ${regime.toUpperCase()}`;
    els.regime.className = "level regime " + (regime === "short" || regime === "negative" ? "negative" : regime === "long" || regime === "positive" ? "positive" : "");
  }
  if (els.meta) els.meta.textContent = "Levels: ZeroGEX free delayed (ES from SPX) \u00b7 Profile: AlgoX SPY \u00d710 \u2192 ES";
}

function renderChart(algox, focusSpot, zg) {
  if (!algox || !algox.strikes || algox.strikes.length === 0) {
    setStatus("AlgoX profile unavailable. Levels still shown.", true);
    return;
  }

  let strikes = algox.strikes.map(s => ({
    strike: toES(s.strike),
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

  function findIdx(target) {
    if (target == null) return -1;
    let best = 0, bestDiff = Infinity;
    strikes.forEach((s, i) => {
      const d = Math.abs(s.strike - target);
      if (d < bestDiff) { bestDiff = d; best = i; }
    });
    return best;
  }
  const focusIdx = findIdx(focusSpot);
  const flipIdx = findIdx(zg?.flip);
  const callIdx = findIdx(zg?.callWall);
  const putIdx = findIdx(zg?.putWall);

  if (chart) chart.destroy();

  const levelsPlugin = {
    id: "levelsLines",
    afterDraw(chartInstance) {
      const yScale = chartInstance.scales.y;
      const xScale = chartInstance.scales.x;
      if (!yScale || !xScale) return;
      const ctx = chartInstance.ctx;
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
      draw(focusIdx, "#d29922", "Spot " + (focusSpot != null ? focusSpot.toLocaleString() : ""));
      draw(flipIdx, "#58a6ff", "Flip " + (zg?.flip != null ? zg.flip.toLocaleString() : ""));
      draw(callIdx, "#3fb950", "Call " + (zg?.callWall != null ? zg.callWall.toLocaleString() : ""));
      draw(putIdx, "#f85149", "Put " + (zg?.putWall != null ? zg.putWall.toLocaleString() : ""));
    }
  };

  chart = new Chart(els.canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Net GEX ($M per 1%)",
        data: values,
        backgroundColor: colors,
        borderWidth: 0,
        categoryPercentage: 0.9,
        barPercentage: 0.85,
      }]
    },
    plugins: [levelsPlugin],
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: "ES Gamma Profile (full spread) \u00b7 25-pt bars within \u00b1500 of spot",
          color: "#e6edf3"
        },
      },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
        y: { ticks: { color: "#8b949e", autoSkip: false, font: { size: 9 } }, grid: { color: "#30363d" } },
      },
    },
  });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  fetchAll();
  pollTimer = setInterval(fetchAll, POLL_INTERVAL);
}

if (els.loadBtn) els.loadBtn.addEventListener("click", startPolling);
if (els.tickerInput) els.tickerInput.addEventListener("keydown", (e) => { if (e.key === "Enter") startPolling(); });

startPolling();
