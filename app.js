const API_BASE = "https://algoxflow.com/v1/gamma";
const POLL_INTERVAL = 60000; // 60 seconds
const ES_MULTIPLIER = 10; // SPY * 10 ≈ ES (S&P 500 futures)

let chart = null;
let currentTicker = "SPY";
let pollTimer = null;
let showES = true; // convert SPY levels to ES equivalent

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
};

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.style.color = isError ? "#f85149" : "#8b949e";
}

function toES(value) {
  if (value == null) return null;
  return Math.round(value * ES_MULTIPLIER * 100) / 100;
}

async function fetchGamma(ticker) {
  setStatus(`Loading ${ticker}…`);
  try {
    const url = `${API_BASE}/${encodeURIComponent(ticker)}?strikes=1`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));

    if (res.status === 503 || data.error === "budget_exhausted") {
      setStatus(`503: Daily refresh budget spent for ${ticker}. Try a previously cached ticker.`, true);
      els.meta.textContent = data.message || "AlgoX free API budget exhausted. Cached tickers still work.";
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    render(data);
    setStatus(`Live · ${ticker} → ES (×${ES_MULTIPLIER})`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, true);
  }
}

function render(data) {
  const g = data.gamma || {};
  const spySpot = data.spot;
  const spyFlip = g.zero_gamma_flip;
  const spyCall = g.call_wall;
  const spyPut = g.put_wall;
  const net = g.net_gex_millions;
  const regime = g.regime || "unknown";

  // Convert to ES equivalent when streaming SPY
  const isSPY = data.ticker === "SPY";
  const spot = isSPY && showES ? toES(spySpot) : spySpot;
  const flip = isSPY && showES ? toES(spyFlip) : spyFlip;
  const callW = isSPY && showES ? toES(spyCall) : spyCall;
  const putW = isSPY && showES ? toES(spyPut) : spyPut;

  const unit = isSPY && showES ? "ES" : data.ticker;

  els.spotLevel.textContent = `${unit} Spot: ${spot != null ? spot.toLocaleString() : "--"}`;
  els.flipLevel.textContent = `Gamma Flip: ${flip != null ? flip.toLocaleString() : "--"}`;
  els.callWall.textContent = `Call Wall: ${callW != null ? callW.toLocaleString() : "--"}`;
  els.putWall.textContent = `Put Wall: ${putW != null ? putW.toLocaleString() : "--"}`;
  els.netGex.textContent = `Net GEX: ${net != null ? net.toLocaleString() + " M" : "--"}`;
  els.regime.textContent = `Regime: ${regime.toUpperCase()}`;
  els.regime.className = "level regime " + (regime === "positive" ? "positive" : regime === "negative" ? "negative" : "");

  const age = data.age_seconds != null ? Math.round(data.age_seconds) + "s" : "--";
  const asOf = data.as_of ? new Date(data.as_of).toLocaleTimeString() : "--";
  let meta = `Updated: ${asOf} · Age: ${age} · Cached: ${data.cached ? "yes" : "no"}`;
  if (isSPY && showES) {
    meta += ` · Source: SPY ×${ES_MULTIPLIER} → ES equivalent`;
  }
  els.meta.textContent = meta;

  const strikes = data.strikes || [];
  if (strikes.length === 0) {
    drawLevelsChart(putW, spot, flip, callW);
    return;
  }

  const labels = strikes.map(s => {
    const val = isSPY && showES ? toES(s.strike) : s.strike;
    return val != null ? val.toLocaleString() : s.strike;
  });
  const values = strikes.map(s => s.net_gex_millions);
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
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: true, text: `${unit} Gamma by Strike (from SPY)`, color: "#e6edf3" },
      },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
        y: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
      },
    },
  });
}

function drawLevelsChart(putW, spot, flip, callW) {
  if (chart) chart.destroy();
  chart = new Chart(els.canvas, {
    type: "bar",
    data: {
      labels: ["Put Wall", "Spot", "Flip", "Call Wall"],
      datasets: [{
        label: "Levels",
        data: [1, 1, 1, 1],
        backgroundColor: ["#f85149", "#e6edf3", "#d29922", "#3fb950"],
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, title: { display: true, text: "Key Levels (ES equivalent)", color: "#e6edf3" } },
      scales: { x: { display: false }, y: { ticks: { color: "#8b949e" } } },
    },
  });
}

function startPolling(ticker) {
  if (pollTimer) clearInterval(pollTimer);
  currentTicker = ticker.toUpperCase();
  fetchGamma(currentTicker);
  pollTimer = setInterval(() => fetchGamma(currentTicker), POLL_INTERVAL);
}

els.loadBtn.addEventListener("click", () => {
  const t = els.tickerInput.value.trim();
  if (t) startPolling(t);
});

els.tickerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.loadBtn.click();
});

// Auto-start on SPY (converted to ES)
startPolling(currentTicker);
