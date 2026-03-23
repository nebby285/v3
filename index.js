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
let currentMarket   = null;
let latestOdds      = { yes: 0.5, no: 0.5 };
let latestBTCPrice  = null;
let clients         = new Set();

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getWindowTs(offset = 0) {
  const sec = Math.floor(Date.now() / 1000);
  return (sec - (sec % 300)) + offset * 300;
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

// Price to beat = Binance 1m candle OPEN at the exact window start timestamp
// We query startTime=windowTs*1000 and get 3 candles to be safe, take the first one's open
async function fetchPriceToBeat(windowTs) {
  try {
    // Primary: Binance exact 1m candle open at window timestamp
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${windowTs*1000}&endTime=${(windowTs+180)*1000}&limit=3`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    if (Array.isArray(d) && d.length > 0) {
      // Find the candle whose open time matches windowTs most closely
      const target = windowTs * 1000;
      let best = d[0];
      for (const c of d) {
        if (Math.abs(c[0] - target) < Math.abs(best[0] - target)) best = c;
      }
      const openPrice = parseFloat(best[1]);
      console.log('[PTB] Binance candle open:', openPrice, 'candle ts:', new Date(best[0]).toISOString(), 'target:', new Date(target).toISOString());
      return openPrice;
    }
  } catch(e) {
    console.error('[PTB] Binance error:', e.message);
  }
  return null;
}

// ── CLOB WS (live odds) ───────────────────────────────────────────────────────
let clobWS = null, clobReconnT = null;

function connectClobWS() {
  if (clobWS) { try { clobWS.terminate(); } catch(e) {} }
  if (!currentMarket?.yesTokenId) return;

  clobWS = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

  clobWS.on('open', () => {
    console.log('[CLOB] connected');
    clobWS.send(JSON.stringify({
      auth: {}, markets: [],
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
        if (ev.event_type !== 'price_change' && ev.event_type !== 'last_trade_price') continue;
        const price = parseFloat(ev.price ?? ev.last_trade_price);
        if (isNaN(price) || price <= 0 || price >= 1) continue;
        const isYes = ev.asset_id === currentMarket.yesTokenId;
        if (isYes) { latestOdds.yes = price; latestOdds.no = parseFloat((1-price).toFixed(4)); }
        else        { latestOdds.no  = price; latestOdds.yes = parseFloat((1-price).toFixed(4)); }
        broadcast({ type: 'odds', yes: latestOdds.yes, no: latestOdds.no });
      }
    } catch(e) {}
  });

  clobWS.on('close', () => { clearInterval(clobWS._ping); clobReconnT = setTimeout(connectClobWS, 3000); });
  clobWS.on('error', (e) => console.error('[CLOB]', e.message));
}

// ── RTDS WS (live Chainlink BTC price) ───────────────────────────────────────
let rtdsWS = null, rtdsReconnT = null;

function connectRTDS() {
  if (rtdsWS) { try { rtdsWS.terminate(); } catch(e) {} }
  rtdsWS = new WebSocket('wss://ws-live-data.polymarket.com');

  rtdsWS.on('open', () => {
    console.log('[RTDS] connected');
    rtdsWS.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '{"symbol":"btc/usd"}' }]
    }));
    rtdsWS._ping = setInterval(() => {
      if (rtdsWS.readyState === WebSocket.OPEN)
        rtdsWS.send(JSON.stringify({ action: 'PING' }));
    }, 5000);
  });

  rtdsWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.value) {
        latestBTCPrice = parseFloat(msg.payload.value);
        broadcast({ type: 'btc_price', price: latestBTCPrice });
      }
    } catch(e) {}
  });

  rtdsWS.on('close', () => { clearInterval(rtdsWS._ping); rtdsReconnT = setTimeout(connectRTDS, 3000); });
  rtdsWS.on('error', (e) => console.error('[RTDS]', e.message));
}

// ── MARKET LOOP ───────────────────────────────────────────────────────────────
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
    const endSec     = wts + 300;

    // Fetch price to beat from Binance 1m candle open
    const startPrice = await fetchPriceToBeat(wts) || latestBTCPrice;

    currentMarket = { slug, wts, yesTokenId, noTokenId, startPrice, endSec };
    console.log('[MARKET] startPrice:', startPrice);

    if (yesTokenId) {
      const yp   = await fetchInitialOdds(yesTokenId);
      latestOdds = { yes: yp, no: parseFloat((1-yp).toFixed(4)) };
    }

    broadcast({ type: 'market', market: currentMarket, odds: latestOdds });
    connectClobWS();
  } catch(e) {
    console.error('[MARKET] error', e.message);
  }
}

setInterval(updateMarket, 15000);
updateMarket();

// ── BROWSER WS ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('[WS] client connected, total:', clients.size);
  if (currentMarket)  ws.send(JSON.stringify({ type: 'market', market: currentMarket, odds: latestOdds }));
  if (latestBTCPrice) ws.send(JSON.stringify({ type: 'btc_price', price: latestBTCPrice }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

app.get('/state',  (req, res) => res.json({ market: currentMarket, odds: latestOdds, btcPrice: latestBTCPrice }));
app.get('/health', (req, res) => res.json({ ok: true }));

// ── PERSISTENT TRACKER ────────────────────────────────────────────────────────
// Stored in memory on the server — survives browser closes, works across devices
// Resets only when Railway restarts (which is rare)
let trackerData = {
  wins: 0, losses: 0, skips: 0,
  history: []  // last 50 entries
};

// GET tracker — frontend loads this on page open
app.get('/tracker', (req, res) => {
  res.json(trackerData);
});

// POST tracker — frontend sends updated tracker after each resolved window
app.post('/tracker', (req, res) => {
  const { wins, losses, skips, history } = req.body;
  if (typeof wins === 'number') trackerData.wins   = wins;
  if (typeof losses === 'number') trackerData.losses = losses;
  if (typeof skips === 'number') trackerData.skips  = skips;
  if (Array.isArray(history)) trackerData.history   = history.slice(-50);
  console.log(`[TRACKER] W:${trackerData.wins} L:${trackerData.losses} S:${trackerData.skips}`);
  res.json({ ok: true });
});

connectRTDS();
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[SERVER] running on port ${PORT}`));
