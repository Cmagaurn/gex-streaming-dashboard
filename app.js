const ZEROGEX_MCP = "https://zerogex.io/mcp";
const POLL_INTERVAL = 60000;

let chart = null;
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
  const result = data.chart?.result?.[0];
  return result?.meta?.regularMarketPrice ?? null;
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
    raw: text
  };
}

async function fetchGamma(ticker) {
  setStatus(`Loading ${ticker} (ZeroGEX) + markets\u2026`);
  try {
    const gammaPromise = fetchZeroGEX(ticker);
    const esPromise = fetchYahoo("ES=F").catch(() => null);
    const tnxPromise = fetchYahoo("^TNX").catch(() => null);
    const oilPromise = fetchYahoo("BZ=F").catch(() => null);

    const [gammaData, esPrice, tnxPrice, oilPrice] = await Promise.all([
      gammaPromise, esPromise, tnxPromise, oilPromise
    ]);

    render(gammaData);
    updateMarketPrices(esPrice, tnxPrice, oilPrice);
    setStatus(`Live \u00b7 ${ticker} (ZeroGEX delayed)`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, true);
  }
}

function updateMarketPrices(es, tnx, oil) {
  els.esPrice.textContent = `/ES: ${es != null ? es.toLocaleString() : "--"}`;
  els.tnxPrice.textContent = `10Y: ${tnx != null ? tnx.toFixed(3) + "%" : "--"}`;
  els.oilPrice.textContent = `BZ Oil: ${oil != null ? oil.toFixed(2) : "--"}`;

  if (chart && chart.data.datasets.length >= 3) {
    const len = chart.data.labels.length;
    chart.data.datasets[1].data = Array(len).fill(tnx);
    chart.data.datasets[2].data = Array(len).fill(oil);
    chart.update();
  }

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  els.timeframe.textContent = `Intraday \u00b7 Last refresh: ${timeStr}`;
}

function render(data) {
  const spot = data.spot;
  const flip = data.flip;
  const callW = data.callWall;
  const putW = data.putWall;
  const regime = data.regime || "unknown";
  const net = data.netGex;

  els.spotLevel.textContent = `ES Spot: ${spot != null ? spot.toLocaleString() : "--"}`;
  els.flipLevel.textContent = `Gamma Flip: ${flip != null ? flip.toLocaleString() : "--"}`;
  els.callWall.textContent = `Call Wall: ${callW != null ? callW.toLocaleString() : "--"}`;
  els.putWall.textContent = `Put Wall: ${putW != null ? putW.toLocaleString() : "--"}`;
  els.netGex.textContent = `Net GEX: ${net || "--"}`;
  els.regime.textContent = `Regime: ${regime.toUpperCase()}`;
  els.regime.className = "level regime " + (regime.includes("short") || regime === "negative" ? "negative" : regime.includes("long") || regime === "positive" ? "positive" : "");

  els.meta.textContent = "Source: ZeroGEX free delayed levels (ES projected from SPX chain)";

  if (chart) chart.destroy();

  const labels = ["Put Wall", "Spot", "Flip", "Call Wall"];
  const levelValues = [putW, spot, flip, callW].map(v => v || 0);

  chart = new Chart(els.canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Gamma Levels (ES)",
          data: levelValues,
          backgroundColor: ["#f85149", "#e6edf3", "#d29922", "#3fb950"],
          yAxisID: "y",
        },
        {
          label: "10Y Yield",
          data: [null, null, null, null],
          borderColor: "#58a6ff",
          backgroundColor: "transparent",
          type: "line",
          yAxisID: "y1",
          pointRadius: 0,
          borderWidth: 2,
        },
        {
          label: "BZ Oil",
          data: [null, null, null, null],
          borderColor: "#d29922",
          backgroundColor: "transparent",
          type: "line",
          yAxisID: "y1",
          pointRadius: 0,
          borderWidth: 2,
          borderDash: [5, 5],
        }
      ]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { color: "#e6edf3" } },
        title: { display: true, text: "ES Gamma Levels (ZeroGEX) + Cross-Asset", color: "#e6edf3" },
      },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
        y: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" }, position: "left" },
        y1: {
          type: "linear",
          display: true,
          position: "right",
          ticks: { color: "#58a6ff" },
          grid: { drawOnChartArea: false },
          title: { display: true, text: "10Y / Oil", color: "#58a6ff" }
        }
      },
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

startPolling(currentTicker);
