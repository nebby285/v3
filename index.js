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
let currentMarket  = null;   // { slug, wts, yesTokenId, noTokenId, startPrice, question, endSec }
let latestOdds     = { yes: 0.5, no: 0.5 };
let latestBTCPrice = null;
let clients        = new Set();  // connected browser clients

// ── POLYMARKET CLOB WS (live odds) ───────────────────────────────────────────
let clobWS       = null;
let clobReconnT  = null;

function connectClobWS() {
  if (clobWS) { try { clobWS.terminate(); } catch(e) {} }
  if (!currentMarket?.yesTokenId) return;

  console.log('[CLOB-WS] connecting...');
  clobWS = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

  clobWS.on('open', () => {
    console.log('[CLOB-WS] connected, subscribing to', currentMarket.yesTokenId);
    clobWS.send(JSON.stringify({
      auth: {},
      markets: [],
      assets_ids: [currentMarket.yesTokenId, currentMarket.noTokenId]
    }));
    // ping every 5s to keep alive
    clobWS._pingInterval = setInterval(() => {
      if (clobWS.readyState === WebSocket.OPEN) clobWS.ping();
    }, 5000);
  });

  clobWS.on('message', (raw) => {
    try {
      const events = JSON.parse(raw.toString());
      const arr = Array.isArray(events) ? events : [events];
      for (const ev of arr) {
        if (ev.event_type === 'price_change' || ev.event_type === 'last_trade_price') {
          const price = parseFloat(ev.price ?? ev.last_trade_price);
          if (isNaN(price)) continue;
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
        // intentionally skip 'book' events — they contain full orderbook snapshots
        // and the best ask is not the same as the market price, causes glitching
      }
    } catch(e) {}
  });

  clobWS.on('close', (code) => {
    console.log('[CLOB-WS] closed', code);
    clearInterval(clobWS._pingInterval);
    clobReconnT = setTimeout(connectClobWS, 3000);
  });

  clobWS.on('error', (e) => console.error('[CLOB-WS] error', e.message));
}

// ── POLYMARKET RTDS WS (live BTC price from Chainlink) ───────────────────────
let rtdsWS      = null;
let rtdsReconnT = null;

function connectRTDS() {
  if (rtdsWS) { try { rtdsWS.terminate(); } catch(e) {} }

  console.log('[RTDS-WS] connecting...');
  rtdsWS = new WebSocket('wss://ws-live-data.polymarket.com');

  rtdsWS.on('open', () => {
    console.log('[RTDS-WS] connected, subscribing to btcusdt chainlink');
    rtdsWS.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [
        { topic: 'crypto_prices_chainlink', type: '*', filters: '{"symbol":"btc/usd"}' }
      ]
    }));
    rtdsWS._pingInterval = setInterval(() => {
      if (rtdsWS.readyState === WebSocket.OPEN) {
        rtdsWS.send(JSON.stringify({ action: 'PING' }));
      }
    }, 5000);
  });

  rtdsWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.value) {
        latestBTCPrice = parseFloat(msg.payload.value);
        broadcast({ type: 'btc_price', price: latestBTCPrice, ts: msg.payload.timestamp });
      }
      // fallback: binance feed
      if (msg.topic === 'crypto_prices' && msg.payload?.symbol === 'btcusdt') {
        if (!latestBTCPrice) {
          latestBTCPrice = parseFloat(msg.payload.value);
          broadcast({ type: 'btc_price', price: latestBTCPrice });
        }
      }
    } catch(e) {}
  });

  rtdsWS.on('close', (code) => {
    console.log('[RTDS-WS] closed', code);
    clearInterval(rtdsWS._pingInterval);
    rtdsReconnT = setTimeout(connectRTDS, 3000);
  });

  rtdsWS.on('error', (e) => console.error('[RTDS-WS] error', e.message));
}

// ── MARKET LOOP (check/update current window every 10s) ──────────────────────
function getWindowTs(offset = 0) {
  const sec  = Math.floor(Date.now() / 1000);
  const step = 5 * 60;
  return (sec - (sec % step)) + offset * step;
}

async function fetchMarketData(slug) {
  // Try events endpoint first — has more fields including startPrice
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const d = await r.json();
    if (Array.isArray(d) && d.length && d[0].markets?.length) {
      return d[0].markets[0];
    }
  } catch(e) {}
  // Fallback to markets endpoint
  const r = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const d = await r.json();
  return Array.isArray(d) && d.length ? d[0] : null;
}

async function fetchStartPrice(tokenId, wts) {
  // Get the price at window open from CLOB timeseries
  try {
    const startTs = wts;
    const endTs   = wts + 60; // first minute
    const r = await fetch(
      `https://clob.polymarket.com/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=1`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const d = await r.json();
    if (d.history && d.history.length > 0) {
      // first price in history is the opening price — but this is YES token price not BTC
      // so we need the Chainlink price at that timestamp instead
    }
  } catch(e) {}
  return null;
}

function extractStartPrice(market) {
  // Try all known fields
  const candidates = [
    market.startPrice,
    market.xAxisValue,
    market.lowerBound,
    market.startValue,
  ];
  for (const c of candidates) {
    const v = parseFloat(c);
    if (!isNaN(v) && v > 10000) return v;
  }
  // Parse from question/description text
  const sources = [market.question || '', market.description || ''];
  for (const s of sources) {
    const matches = s.match(/\$([\d,]+\.?\d*)/g);
    if (matches) {
      const prices = matches.map(m => parseFloat(m.replace(/[$,]/g,''))).filter(p => p > 10000);
      if (prices.length) return prices[0];
    }
    // Also try plain numbers like 84231.50
    const plain = s.match(/\b(8\d{4}|9\d{4}|7\d{4})\.\d+/g);
    if (plain) return parseFloat(plain[0]);
  }
  return null;
}

async function fetchInitialOdds(tokenId) {
  try {
    const r = await fetch(`https://clob.polymarket.com/price?token_id=${tokenId}&side=BUY`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const d = await r.json();
    return parseFloat(d.price) || 0.5;
  } catch(e) { return 0.5; }
}

async function updateMarket() {
  const wts  = getWindowTs(0);
  const slug = `btc-updown-5m-${wts}`;

  // already tracking this window
  if (currentMarket?.wts === wts) return;

  console.log('[MARKET] loading', slug);
  try {
    const market = await fetchMarketData(slug);
    if (!market) { console.log('[MARKET] not found yet'); return; }

    const ids        = JSON.parse(market.clobTokenIds || '[]');
    const yesTokenId = ids[0];
    const noTokenId  = ids[1];
    const startPrice = extractStartPrice(market);
    const endSec     = wts + 5 * 60;

    currentMarket = { slug, wts, yesTokenId, noTokenId, startPrice, endSec,
      question: market.question };

    // If startPrice still null, use current BTC price as approximation
    // (the real price to beat is the Chainlink price at window open — very close to live price)
    if (!currentMarket.startPrice && latestBTCPrice) {
      currentMarket.startPrice = latestBTCPrice;
      console.log('[MARKET] using live BTC as startPrice fallback:', latestBTCPrice);
    }

    // get initial odds from REST
    if (yesTokenId) {
      const yp = await fetchInitialOdds(yesTokenId);
      latestOdds = { yes: yp, no: parseFloat((1-yp).toFixed(4)) };
    }

    // broadcast new market to all clients
    broadcast({ type: 'market', market: currentMarket, odds: latestOdds });

    // reconnect CLOB WS for new token IDs
    connectClobWS();
  } catch(e) {
    console.error('[MARKET] error', e.message);
  }
}

// check for new market every 15s
setInterval(updateMarket, 15000);
updateMarket();

// also pre-fetch next window
async function prefetchNext() {
  const wts  = getWindowTs(1);
  const slug = `btc-updown-5m-${wts}`;
  try {
    await fetchMarketData(slug); // just warm up
  } catch(e) {}
}
setInterval(prefetchNext, 60000);

// ── BROADCAST ─────────────────────────────────────────────────────────────────
function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(str);
    }
  }
}

// ── BROWSER WS CONNECTIONS ────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('[WS] client connected, total:', clients.size);

  // send current state immediately
  if (currentMarket) {
    ws.send(JSON.stringify({ type: 'market', market: currentMarket, odds: latestOdds }));
  }
  if (latestBTCPrice) {
    ws.send(JSON.stringify({ type: 'btc_price', price: latestBTCPrice }));
  }

  ws.on('close', () => {
    clients.delete(ws);
    console.log('[WS] client disconnected, total:', clients.size);
  });

  ws.on('error', () => clients.delete(ws));
});

// ── REST ENDPOINTS (fallback) ─────────────────────────────────────────────────
app.get('/state', (req, res) => {
  res.json({ market: currentMarket, odds: latestOdds, btcPrice: latestBTCPrice });
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ── START ─────────────────────────────────────────────────────────────────────
connectRTDS();

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[SERVER] running on port ${PORT}`));
