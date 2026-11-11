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
  schwabNet: do
