import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

// ── STATE ─────────────────────────────────────────────────────────────────────
let currentMarket  = null;
let latestOdds     = { yes: 0.5, no: 0.5 };
let latestBTCPrice = null;
let windowOpenPrice = null; // Chainlink price captured at exact window open
let clients        = new Set();

// ── CLOB WS (live odds) ───────────────────────────────────────────────────────
let clobWS      = null;
let clobReconnT = null;

function connectClobWS() {
  if (clobWS) { try { clobWS.terminate(); } catch(e) {} }
  if (!currentMarket?.yesTokenId) return;

  clobWS = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

  clobWS.on('open', () => {
    console.log('[CLOB-WS] connected');
    clobWS.send(JSON.stringify({
      auth: {},
      markets: [],
      assets_ids: [currentMarket.yesTokenId, currentMarket.noTokenId]
    }));
    clobWS._ping = setInterval(() => {
      if (clobWS.readyState === WebSocket.OPEN) clobWS.ping();
    }, 5000);
  });

  clobWS.on('message', (raw) => {
    try {
      const arr = [].concat(JSON.parse(raw.toString()));
      for (const ev of arr) {
        // Only use price_change and last_trade_price — skip book events (they glitch)
        if (ev.event_type !== 'price_change' && ev.event_type !== 'last_trade_price') continue;
        const price = parseFloat(ev.price ?? ev.last_trade_price);
        if (isNaN(price) || price <= 0 || price >= 1) continue;
        const isYes = ev.asset_id === currentMarket.yesTokenId;
        if (isYes) {
          latestOdds.yes = price;
          latestOdds.no  = parseFloat((1 - price).toFixed(4));
        } else {
          latestOdds.no  = price;
          latestOdds.yes = parseFloat((1 - price).toFixed(4));
        }
        broadcast({ type: 'odds', yes: latestOdds.yes, no: latestOdds.no });
      }
    } catch(e) {}
  });

  clobWS.on('close', () => {
    clearInterval(clobWS._ping);
    clobReconnT = setTimeout(connectClobWS, 3000);
  });

  clobWS.on('error', (e) => console.error('[CLOB-WS]', e.message));
}

// ── RTDS WS (live Chainlink BTC price) ───────────────────────────────────────
let rtdsWS      = null;
let rtdsReconnT = null;
let lastWindowTs = null;

function connectRTDS() {
  if (rtdsWS) { try { rtdsWS.terminate(); } catch(e) {} }

  rtdsWS = new WebSocket('wss://ws-live-data.polymarket.com');

  rtdsWS.on('open', () => {
    console.log('[RTDS-WS] connected');
    rtdsWS.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [
        { topic: 'crypto_prices_chainlink', type: '*', filters: '{"symbol":"btc/usd"}' }
      ]
    }));
    rtdsWS._ping = setInterval(() => {
      if (rtdsWS.readyState === WebSocket.OPEN)
        rtdsWS.send(JSON.stringify({ action: 'PING' }));
    }, 5000);
  });

  // Ring buffer: keep last 30 Chainlink prices with their timestamps
  const priceBuffer = [];

  rtdsWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.value) {
        const price   = parseFloat(msg.payload.value);
        // Chainlink sends its own timestamp in the payload (ms)
        const chainTs = msg.payload.timestamp ? Math.floor(msg.payload.timestamp / 1000) : Math.floor(Date.now() / 1000);

        latestBTCPrice = price;

        // Store in ring buffer (keep last 30)
        priceBuffer.push({ price, ts: chainTs });
        if (priceBuffer.length > 30) priceBuffer.shift();

        // Detect new window
        const step  = 5 * 60;
        const winTs = chainTs - (chainTs % step);

        if (winTs !== lastWindowTs) {
          lastWindowTs = winTs;

          // Find the Chainlink price whose timestamp is closest to winTs
          // (the first update AT or just after window open)
          const candidates = priceBuffer.filter(p => p.ts >= winTs);
          const best = candidates.length > 0
            ? candidates.reduce((a, b) => Math.abs(a.ts - winTs) < Math.abs(b.ts - winTs) ? a : b)
            : { price };

          windowOpenPrice = best.price;
          console.log('[PRICE-TO-BEAT] window', winTs, '→ $'+windowOpenPrice, '(chainlink ts:', best.ts+')');

          if (currentMarket) {
            currentMarket.startPrice = windowOpenPrice;
            broadcast({ type: 'market', market: currentMarket, odds: latestOdds });
          }
        }

        broadcast({ type: 'btc_price', price, ts: chainTs });
      }
    } catch(e) {}
  });

  rtdsWS.on('close', () => {
    clearInterval(rtdsWS._ping);
    rtdsReconnT = setTimeout(connectRTDS, 3000);
  });

  rtdsWS.on('error', (e) => console.error('[RTDS-WS]', e.message));
}

// ── MARKET LOOP ───────────────────────────────────────────────────────────────
function getWindowTs(offset = 0) {
  const sec  = Math.floor(Date.now() / 1000);
  const step = 5 * 60;
  return (sec - (sec % step)) + offset * step;
}

async function fetchMarketData(slug) {
  const r = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const d = await r.json();
  return Array.isArray(d) && d.length ? d[0] : null;
}

async function fetchInitialOdds(tokenId) {
  try {
    const r = await fetch(`https://clob.polymarket.com/price?token_id=${tokenId}&side=BUY`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const d = await r.json();
    const p = parseFloat(d.price);
    return (!isNaN(p) && p > 0 && p < 1) ? p : 0.5;
  } catch(e) { return 0.5; }
}

async function updateMarket() {
  const wts  = getWindowTs(0);
  const slug = `btc-updown-5m-${wts}`;
  if (currentMarket?.wts === wts) return;

  console.log('[MARKET] loading', slug);
  try {
    const market = await fetchMarketData(slug);
    if (!market) { console.log('[MARKET] not found yet'); return; }

    const ids        = JSON.parse(market.clobTokenIds || '[]');
    const yesTokenId = ids[0];
    const noTokenId  = ids[1];
    const endSec     = wts + 5 * 60;

    // Price to beat = Chainlink price captured at window open
    // Use windowOpenPrice if we have it, else current live price
    const startPrice = windowOpenPrice || latestBTCPrice || null;

    currentMarket = { slug, wts, yesTokenId, noTokenId, startPrice, endSec, question: market.question };

    if (yesTokenId) {
      const yp   = await fetchInitialOdds(yesTokenId);
      latestOdds = { yes: yp, no: parseFloat((1-yp).toFixed(4)) };
    }

    broadcast({ type: 'market', market: currentMarket, odds: latestOdds });
    connectClobWS();
    console.log('[MARKET] loaded, startPrice:', startPrice);
  } catch(e) {
    console.error('[MARKET] error', e.message);
  }
}

setInterval(updateMarket, 15000);
updateMarket();

// ── BROADCAST ─────────────────────────────────────────────────────────────────
function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(str);
  }
}

// ── BROWSER WS ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('[WS] client connected, total:', clients.size);
  if (currentMarket) ws.send(JSON.stringify({ type: 'market', market: currentMarket, odds: latestOdds }));
  if (latestBTCPrice) ws.send(JSON.stringify({ type: 'btc_price', price: latestBTCPrice }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

app.get('/state', (req, res) => res.json({ market: currentMarket, odds: latestOdds, btcPrice: latestBTCPrice }));
app.get('/health', (req, res) => res.json({ ok: true }));

connectRTDS();
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[SERVER] running on port ${PORT}`));
