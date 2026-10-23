const API_BASE = "https://algoxflow.com/v1/gamma";
const POLL_INTERVAL = 60000; // 60 seconds

let chart = null;
let currentTicker = "SPX";
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
};

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.style.color = isError ? "#f85149" : "#8b949e";
}

async function fetchGamma(ticker) {
  setStatus(`Loading ${ticker}…`);
  try {
    const url = `${API_BASE}/${encodeURIComponent(ticker)}?strikes=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    render(data);
    setStatus(`Live · ${ticker}`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, true);
  }
}

function render(data) {
  const g = data.gamma || {};
  const spot = data.spot;
  const flip = g.zero_gamma_flip;
  const callW = g.call_wall;
  const putW = g.put_wall;
  const net = g.net_gex_millions;
  const regime = g.regime || "unknown";

  els.spotLevel.textContent = `Spot: ${spot != null ? spot.toLocaleString() : "--"}`;
  els.flipLevel.textContent = `Gamma Flip: ${flip != null ? flip.toLocaleString() : "--"}`;
  els.callWall.textContent = `Call Wall: ${callW != null ? callW.toLocaleString() : "--"}`;
  els.putWall.textContent = `Put Wall: ${putW != null ? putW.toLocaleString() : "--"}`;
  els.netGex.textContent = `Net GEX: ${net != null ? net.toLocaleString() + " M" : "--"}`;
  els.regime.textContent = `Regime: ${regime.toUpperCase()}`;
  els.regime.className = "level regime " + (regime === "positive" ? "positive" : regime === "negative" ? "negative" : "");

  const age = data.age_seconds != null ? Math.round(data.age_seconds) + "s" : "--";
  const asOf = data.as_of ? new Date(data.as_of).toLocaleTimeString() : "--";
  els.meta.textContent = `Updated: ${asOf} · Age: ${age} · Cached: ${data.cached ? "yes" : "no"}`;

  // Chart: horizontal bar of net GEX by strike (or simple levels if few strikes)
  const strikes = data.strikes || [];
  if (strikes.length === 0) {
    // Fallback synthetic points around levels
    const levels = [putW, spot, flip, callW].filter(v => v != null);
    if (levels.length) {
      drawLevelsChart(levels, spot, flip);
    }
    return;
  }

  const labels = strikes.map(s => s.strike);
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
        title: { display: true, text: `${data.ticker} Gamma by Strike`, color: "#e6edf3" },
      },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
        y: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
      },
    },
  });
}

function drawLevelsChart(levels, spot, flip) {
  // Simple fallback: just highlight key levels
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
      plugins: { legend: { display: false }, title: { display: true, text: "Key Levels (synthetic)", color: "#e6edf3" } },
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

// Auto-start
startPolling(currentTicker);
