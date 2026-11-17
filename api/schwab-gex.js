export default async function handler(req, res) {
  const symbol = (req.query.symbol || "SPY").toUpperCase();
  const schwabSymbol = symbol === "SPX" || symbol === "ES" ? "$SPX" : symbol;

  const appKey = process.env.SCHWAB_APP_KEY;
  const appSecret = process.env.SCHWAB_APP_SECRET;
  const refreshToken = process.env.SCHWAB_REFRESH_TOKEN;

  if (!appKey || !appSecret || !refreshToken) {
    return res.status(500).json({ error: "Schwab credentials not configured" });
  }

  try {
    const tokenRes = await fetch("https://api.schwabapi.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${appKey}:${appSecret}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return res.status(502).json({ error: "Token refresh failed", detail: err });
    }

    const tokens = await tokenRes.json();
    const accessToken = tokens.access_token;

    const today = new Date().toISOString().slice(0, 10);
    const toDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const chainUrl = new URL("https://api.schwabapi.com/marketdata/v1/chains");
    chainUrl.searchParams.set("symbol", schwabSymbol);
    chainUrl.searchParams.set("contractType", "ALL");
    chainUrl.searchParams.set("strikeCount", "50");
    chainUrl.searchParams.set("includeUnderlyingQuote", "true");
    chainUrl.searchParams.set("fromDate", today);
    chainUrl.searchParams.set("toDate", toDate);

    const chainRes = await fetch(chainUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!chainRes.ok) {
      const err = await chainRes.text();
      return res.status(502).json({ error: "Chain fetch failed", detail: err });
    }

    const chain = await chainRes.json();
    if (chain.status !== "SUCCESS") {
      return res.status(502).json({ error: "Schwab returned non-success", status: chain.status });
    }

    const spot = chain.underlyingPrice;
    if (!spot) return res.status(502).json({ error: "No underlying price" });

    const gexByStrike = {};
    const processMap = (expMap, sign) => {
      for (const strikes of Object.values(expMap || {})) {
        for (const [strikeStr, contracts] of Object.entries(strikes)) {
          const strike = parseFloat(strikeStr);
          if (isNaN(strike)) continue;
          for (const c of contracts) {
            const gamma = c.gamma || 0;
            const oi = c.openInterest || 0;
            const gex = gamma * oi * 100 * spot * spot * 0.01 * sign;
            if (Math.abs(gex) > 0) {
              gexByStrike[strike] = (gexByStrike[strike] || 0) + gex;
            }
          }
        }
      }
    };

    processMap(chain.callExpDateMap, 1);
    processMap(chain.putExpDateMap, -1);

    const strikes = Object.keys(gexByStrike).map(Number).sort((a, b) => a - b);
    const gex = strikes.map(s => gexByStrike[s]);
    const netGex = gex.reduce((a, b) => a + b, 0);

    let callWall = null;
    let putWall = null;
    let maxGex = -Infinity;
    let minGex = Infinity;
    strikes.forEach((s, i) => {
      if (gex[i] > maxGex) { maxGex = gex[i]; callWall = s; }
      if (gex[i] < minGex) { minGex = gex[i]; putWall = s; }
    });

    let gammaFlip = null;
    let cum = 0;
    for (let i = 0; i < strikes.length; i++) {
      const prev = cum;
      cum += gex[i];
      if (prev * cum < 0) { gammaFlip = strikes[i]; break; }
    }
    if (gammaFlip == null && strikes.length > 1) {
      // fallback: strike nearest zero cumulative
      let best = strikes[0], bestAbs = Infinity;
      cum = 0;
      for (let i = 0; i < strikes.length; i++) {
        cum += gex[i];
        if (Math.abs(cum) < bestAbs) { bestAbs = Math.abs(cum); best = strikes[i]; }
      }
      gammaFlip = best;
    }

    // Approximate 25-delta risk reversal (front expiration)
    let skewRR = null;
    try {
      const expDates = Object.keys(chain.callExpDateMap || {}).sort();
      if (expDates.length > 0) {
        const front = expDates[0];
        const calls = chain.callExpDateMap[front] || {};
        const puts = chain.putExpDateMap[front] || {};
        let bestCall = null, bestCallDiff = Infinity;
        let bestPut = null, bestPutDiff = Infinity;
        for (const [k, arr] of Object.entries(calls)) {
          const c = arr[0];
          if (!c || c.delta == null || c.volatility == null) continue;
          const d = Math.abs(c.delta - 0.25);
          if (d < bestCallDiff) { bestCallDiff = d; bestCall = c; }
        }
        for (const [k, arr] of Object.entries(puts)) {
          const c = arr[0];
          if (!c || c.delta == null || c.volatility == null) continue;
          const d = Math.abs(Math.abs(c.delta) - 0.25);
          if (d < bestPutDiff) { bestPutDiff = d; bestPut = c; }
        }
        if (bestCall && bestPut) {
          skewRR = bestPut.volatility - bestCall.volatility; // already in vol points
        }
      }
    } catch (e) {}

    // ES futures quotes (front + next few)
    let esQuotes = [];
    if (symbol === "ES" || symbol === "SPX") {
      const months = ["H", "M", "U", "Z"];
      const now = new Date();
      let year = now.getFullYear() % 100;
      let mIdx = Math.floor(now.getMonth() / 3);
      const symbols = [];
      for (let i = 0; i < 4; i++) {
        symbols.push(`/ES${months[mIdx]}${year}`);
        mIdx++;
        if (mIdx >= 4) { mIdx = 0; year++; }
      }
      try {
        const qUrl = new URL("https://api.schwabapi.com/marketdata/v1/quotes");
        qUrl.searchParams.set("symbols", symbols.join(","));
        const qRes = await fetch(qUrl.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (qRes.ok) {
          const qData = await qRes.json();
          esQuotes = symbols.map(sym => {
            const q = qData[sym]?.quote || {};
            return {
              symbol: sym,
              last: q.lastPrice ?? q.mark ?? null,
              open: q.openPrice ?? null,
              prevClose: q.closePrice ?? q.previousClose ?? null,
              bid: q.bidPrice ?? null,
              ask: q.askPrice ?? null,
            };
          }).filter(q => q.last != null);
        }
      } catch (e) {}
    }

    
    // Put/call ratios and OI by strike (front expirations)
    let putVol = 0, callVol = 0, putOI = 0, callOI = 0;
    const oiByStrike = {};
    const volByStrike = {};
    const addOI = (expMap, isPut) => {
      for (const strikes of Object.values(expMap || {})) {
        for (const [strikeStr, contracts] of Object.entries(strikes)) {
          const strike = parseFloat(strikeStr);
          if (isNaN(strike)) continue;
          for (const c of contracts) {
            const vol = c.totalVolume || 0;
            const oi = c.openInterest || 0;
            if (isPut) { putVol += vol; putOI += oi; }
            else { callVol += vol; callOI += oi; }
            oiByStrike[strike] = (oiByStrike[strike] || 0) + oi;
            volByStrike[strike] = (volByStrike[strike] || 0) + vol;
          }
        }
      }
    };
    addOI(chain.callExpDateMap, false);
    addOI(chain.putExpDateMap, true);
    const pcVol = callVol ? (putVol / callVol) : null;
    const pcOI = callOI ? (putOI / callOI) : null;
    const oiStrikes = Object.keys(oiByStrike).map(Number).sort((a,b)=>a-b);
    const volStrikes = Object.keys(volByStrike).map(Number).sort((a,b)=>a-b);
    const volValues = volStrikes.map(s => volByStrike[s]);
    const oiValues = oiStrikes.map(s => oiByStrike[s]);

    return res.status(200).json({
      spot,
      strikes,
      gex,
      netGex,
      callWall,
      putWall,
      gammaFlip,
      skewRR,
      esQuotes,
      esOpen: esQuotes[0]?.open ?? null,
      esPrevClose: esQuotes[0]?.prevClose ?? null,
      pcVol,
      pcOI,
      oiStrikes,
      oiValues,
      volStrikes,
      volValues,
      source: "schwab",
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
