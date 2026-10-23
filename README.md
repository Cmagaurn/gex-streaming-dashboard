# GEX Streaming Dashboard

A simple, free, browser-based streaming dashboard that visualizes dealer gamma exposure (GEX) levels from the **AlgoX Flow** public API.

## Features

- Real-time (polled every 60s) gamma flip, call wall, put wall, spot, net GEX, and regime
- Strike-level net GEX bar chart (when available)
- Dark trading-desk theme
- Works for any liquid US ticker (SPX, SPY, QQQ, NVDA, AAPL, ES-related via SPX, etc.)
- Zero auth, CORS-friendly, free public data
- Attribution link back to AlgoX Flow

## Live Demo

Once deployed (or open `index.html` locally), it auto-loads SPX and starts streaming updates.

## API Used

```
GET https://algoxflow.com/v1/gamma/{ticker}
```

No API key required. Data is cached (~10–15 min). Respect fair use.

## Local Development

Just open `index.html` in a browser (or serve with any static server):

```bash
npx serve .
# or
python -m http.server 8000
```

## Deploy

- Drop the three files (`index.html`, `styles.css`, `app.js`) on any static host.
- Vercel, Netlify, GitHub Pages, Cloudflare Pages all work with zero config.

## Notes

- This is **not** true websocket streaming — AlgoX Flow provides snapshot JSON. Polling every 60s is more than enough given their cache TTL.
- Dealer gamma is modeled, not observed.
- Not financial advice.

Built for the ES Futures Analysis workflow. Data by [AlgoX Flow](https://algoxflow.com).
