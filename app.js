const ZEROGEX_MCP = "https://zerogex.io/mcp";
const ALGOX_BASE = "https://algoxflow.com/v1/gamma";
const POLL_INTERVAL = 60000;
const ES_MULTIPLIER = 10;
const ZOOM_POINTS = 250;
const HISTORY_KEY = "gex_history_es";
const MAX_HISTORY_DAYS = 5;

let chart = null;
let historyChart = null;
let currentTicker = "ES";
let pollTimer = null;

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
  esPrice: document.getElementById("esPrice"),
  tnxPrice: document.getElementById("tnxPrice"),
  oilPrice: document.getElementById("oilPrice"),
  timeframe: document.getElementById("timeframe"),
};

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.style.color = isError ? "#f85149" : "#8b949e";
}

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo ${symbol} ${res.status}`);
  const data = await res.json();
  return data.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
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
  const get = (label) => {
    const m = text.match(new RegExp(label + ":\\s*([\\d,.]+)", "i"));
    return m ? parseFloat(m[1].replace(/,/g, "")) : null;
  };
  const regimeMatch = text.match(/Modeled regime:\s*(\w+)/i);
  const netMatch = text.match(/Net dealer gamma at spot:\s*([\u2212\-\$0-9.,]+[BM])/i);
  return {
    spot: get("Spot the levels were computed against"),
    flip: get("Gamma flip"),
    callWall: get("Call wall"),
    putWall: get("Put wall"),
    regime: regimeMatch ? regimeMatch[1].toLowerCase() : "unknown",
    netGex: netMatch ? netMatch[1] : null,
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
  const num = parseFloat(raw.replace(/[\u2212\-$,]/g, "").replace("B", "e9").replace("M", "e6"));
  return isNaN(num) ? null : (raw.includes("\u2212") || raw.includes("-") ? -num : num);
}

function saveHistory(zg) {
  try {
    const entry = {
      ts: Date.now(),
      spot: zg.spot,
      flip: zg.flip,
      netGex: parseNetGex(zg.netGex),
      regime: zg.regime,
    };
    let hist = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    hist.push(entry);
    const cutoff = Date.now() - MAX_HISTORY_DAYS * 86400000;
    hist = hist.filter(e => e.ts >= cutoff);
    const byHour = {};
    hist.forEach(e => {
      const key = Math.floor(e.ts / 3600000);
      byHour[key] = e;
    });
    hist = Object.values(byHour).sort((a, b) => a.ts - b.ts);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
    return hist;
  } catch (e) {
    console.warn("History save failed", e);
    return [];
  }
}

async function loadHistory() {
  try {
    const res = await fetch("/api/history");
    if (res.ok) {
      const remote = await res.json();
      if (Array.isArray(remote) && remote.length) return remote;
    }
  } catch (e) {}
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function renderHistoryChart(hist) {
  if (!els.historyCanvas) return;
  const labels = hist.map(e => new Date(e.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" }));
  const values = hist.map(e => e.netGex);
  const colors = values.map(v => v >= 0 ? "#3fb950" : "#f85149");

  if (historyChart) historyChart.destroy();

  historyChart = new Chart(els.historyCanvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Net GEX ($)",
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
        title: { display: true, text: "5-Day Net GEX Trend (repo history)", color: "#e6edf3" },
      },
      scales: {
        x: { ticks: { color: "#8b949e", maxTicksLimit: 8 }, grid: { color: "#30363d" } },
        y: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
      },
    },
  });
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
    renderChart(algox, zg.spot || esPrice);
    const hist = await loadHistory();
    saveHistory(zg);
    renderHistoryChart(hist);
    setStatus("Live \u00b7 ZeroGEX levels + AlgoX profile (ES \u00d710)");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, true);
  }
}

function updateMarketPrices(es, tnx, oil) {
  els.esPrice.textContent = `/ES: ${es != null ? es.toLocaleString() : "--"}`;
  els.tnxPrice.textContent = `10Y: ${tnx != null ? tnx.toFixed(3) + "%" : "--"}`;
  els.oilPrice.textContent = `BZ Oil: ${oil != null ? oil.toFixed(2) : "--"}`;

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  els.timeframe.textContent = `Intraday \u00b7 Last refresh: ${timeStr}`;
}

function renderLevels(zg) {
  const { spot, flip, callWall, putWall, regime, netGex } = zg;
  els.spotLevel.textContent = `ES Spot: ${spot != null ? spot.toLocaleString() : "--"}`;
  els.flipLevel.textContent = `Gamma Flip: ${flip != null ? flip.toLocaleString() : "--"}`;
  els.callWall.textContent = `Call Wall: ${callWall != null ? callWall.toLocaleString() : "--"}`;
  els.putWall.textContent = `Put Wall: ${putWall != null ? putWall.toLocaleString() : "--"}`;
  els.netGex.textContent = `Net GEX: ${netGex || "--"}`;
  els.regime.textContent = `Regime: ${regime.toUpperCase()}`;
  els.regime.className = "level regime " + (regime.includes("short") || regime === "negative" ? "negative" : regime.includes("long") || regime === "positive" ? "positive" : "");
  els.meta.textContent = "Levels: ZeroGEX free delayed (ES from SPX) \u00b7 Profile: AlgoX SPY \u00d710 \u2192 ES";
}

function renderChart(algox, focusSpot) {
  if (!algox || !algox.strikes || algox.strikes.length === 0) {
    setStatus("AlgoX profile unavailable (budget or error). Levels still shown.", true);
    return;
  }

  const strikes = algox.strikes.map(s => ({
    strike: toES(s.strike),
    gex: s.net_gex_millions
  })).filter(s => s.strike != null);

  const minStrike = focusSpot ? focusSpot - ZOOM_POINTS : Math.min(...strikes.map(s => s.strike));
  const maxStrike = focusSpot ? focusSpot + ZOOM_POINTS : Math.max(...strikes.map(s => s.strike));
  const zoomed = strikes.filter(s => s.strike >= minStrike && s.strike <= maxStrike);

  const labels = zoomed.map(s => s.strike.toLocaleString());
  const values = zoomed.map(s => s.gex);
  const colors = values.map(v => v >= 0 ? "#3fb950" : "#f85149");

  if (chart) chart.destroy();

  chart = new Chart(els.canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Net GEX ($M per 1%)",
        data: values,
        backgroundColor: colors,
        borderWidth: 0,
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `ES Gamma Profile (AlgoX SPY \u00d710) \u00b7 Zoomed \u00b1${ZOOM_POINTS} pts`,
          color: "#e6edf3"
        },
      },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
        y: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
      },
    },
  });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  fetchAll();
  pollTimer = setInterval(fetchAll, POLL_INTERVAL);
}

els.loadBtn.addEventListener("click", startPolling);
els.tickerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") startPolling();
});

startPolling();
