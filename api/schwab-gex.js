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
    if (gammaFlip == null && strikes.length) gammaFlip = strikes[Math.floor(strikes.length / 2)];

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate");
    return res.status(200).json({
      symbol,
      spot,
      strikes,
      gex,
      netGex,
      callWall,
      putWall,
      gammaFlip,
      updated: new Date().toISOString(),
      source: "schwab",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
