import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
app.use(cors());
app.use(express.json());

// ── STATE ─────────────────────────────────────────────────────
let currentMarket  = null;
let latestOdds     = { yes: 0.5, no: 0.5 };
let latestBTCPrice = null;
let clients        = new Set();
let lockedDecision = null;
let trackerData    = { wins: 0, losses: 0, skips: 0, history: [] };

// Chainlink price buffer — stores last 90s of prices with timestamps
// So we can look up exact price at any window boundary
const chainlinkBuffer = [];
function getPriceAtTime(targetMs) {
  if (!chainlinkBuffer.length) return latestBTCPrice;
  let best = chainlinkBuffer[0];
  for (const e of chainlinkBuffer) {
    if (Math.abs(e.ts - targetMs) < Math.abs(best.ts - targetMs)) best = e;
  }
  return best.price;
}

// ── HELPERS ───────────────────────────────────────────────────
function getWindowTs() { const s = Math.floor(Date.now()/1000); return s - (s % 300); }
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

// ── CLOB WS (live odds) ───────────────────────────────────────
let clobWS = null;
function connectClobWS() {
  if (clobWS) { try { clobWS.terminate(); } catch(e) {} }
  if (!currentMarket?.yesTokenId) return;
  clobWS = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
  clobWS.on('open', () => {
    clobWS.send(JSON.stringify({ auth:{}, markets:[], assets_ids:[currentMarket.yesTokenId, currentMarket.noTokenId] }));
    clobWS._ping = setInterval(() => { if (clobWS.readyState === WebSocket.OPEN) clobWS.ping(); }, 5000);
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
  clobWS.on('close', () => { clearInterval(clobWS._ping); setTimeout(connectClobWS, 3000); });
  clobWS.on('error', (e) => console.error('[CLOB]', e.message));
}

// ── RTDS WS (Chainlink BTC price) ─────────────────────────────
let rtdsWS = null;
function connectRTDS() {
  if (rtdsWS) { try { rtdsWS.terminate(); } catch(e) {} }
  rtdsWS = new WebSocket('wss://ws-live-data.polymarket.com');
  rtdsWS.on('open', () => {
    rtdsWS.send(JSON.stringify({ action:'subscribe', subscriptions:[{ topic:'crypto_prices_chainlink', type:'*', filters:'{"symbol":"btc/usd"}' }] }));
    rtdsWS._ping = setInterval(() => { if (rtdsWS.readyState === WebSocket.OPEN) rtdsWS.send(JSON.stringify({ action:'PING' })); }, 5000);
  });
  rtdsWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.value) {
        latestBTCPrice = parseFloat(msg.payload.value);
        const now = Date.now();
        chainlinkBuffer.push({ ts: now, price: latestBTCPrice });
        if (chainlinkBuffer.length > 200) chainlinkBuffer.shift();
        broadcast({ type: 'btc_price', price: latestBTCPrice });
      }
    } catch(e) {}
  });
  rtdsWS.on('close', () => { clearInterval(rtdsWS._ping); setTimeout(connectRTDS, 3000); });
  rtdsWS.on('error', (e) => console.error('[RTDS]', e.message));
}

// ── MARKET LOOP ───────────────────────────────────────────────
async function fetchMarketData(slug) {
  const r = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const d = await r.json();
  return Array.isArray(d) && d.length ? d[0] : null;
}
async function fetchInitialOdds(tokenId) {
  try {
    const r = await fetch(`https://clob.polymarket.com/price?token_id=${tokenId}&side=BUY`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d = await r.json();
    const p = parseFloat(d.price);
    return (!isNaN(p) && p > 0 && p < 1) ? p : 0.5;
  } catch(e) { return 0.5; }
}

async function updateMarket() {
  const wts = getWindowTs(), slug = `btc-updown-5m-${wts}`;
  if (currentMarket?.wts === wts) return;
  console.log('[MARKET] loading', slug);
  try {
    const market = await fetchMarketData(slug);
    if (!market) { console.log('[MARKET] not found yet'); return; }
    const ids = JSON.parse(market.clobTokenIds || '[]');
    const yesTokenId = ids[0], noTokenId = ids[1], endSec = wts + 300;

    // Resolve previous window before switching
    if (lockedDecision && !lockedDecision.resolved && lockedDecision.wts !== wts) {
      const { decision, startPrice } = lockedDecision;
      let result = 'SKIP';
      if (decision !== 'NO TRADE' && latestBTCPrice && startPrice) {
        const won = decision === 'BUY UP' ? latestBTCPrice >= startPrice : latestBTCPrice < startPrice;
        result = won ? 'WIN' : 'LOSS';
        if (won) trackerData.wins++; else trackerData.losses++;
      } else if (decision === 'NO TRADE') {
        trackerData.skips++;
      }
      const idx = trackerData.history.findIndex(h => h.window === lockedDecision.wts);
      if (idx >= 0) trackerData.history[idx].result = result;
      lockedDecision.resolved = true;
      console.log('[TRACKER]', decision, '→', result, `W:${trackerData.wins} L:${trackerData.losses}`);
      broadcast({ type: 'tracker', tracker: trackerData });
    }

    lockedDecision = null;

    // Price to beat = Chainlink price at exact window open time
    const startPrice = getPriceAtTime(wts * 1000) || latestBTCPrice;
    currentMarket = { slug, wts, yesTokenId, noTokenId, startPrice, endSec };
    console.log('[MARKET] startPrice:', startPrice, '(Chainlink at window open)');

    if (yesTokenId) {
      const yp = await fetchInitialOdds(yesTokenId);
      latestOdds = { yes: yp, no: parseFloat((1-yp).toFixed(4)) };
    }
    broadcast({ type: 'market', market: currentMarket, odds: latestOdds });
    connectClobWS();
    setTimeout(runEngine, 3000);
  } catch(e) { console.error('[MARKET]', e.message); }
}
setInterval(updateMarket, 15000);
updateMarket();

// ── ENGINE ────────────────────────────────────────────────────
function runEngine() {
  if (!currentMarket || !latestBTCPrice || !currentMarket.startPrice) return;
  const secsLeft = Math.max(0, currentMarket.endSec - Math.floor(Date.now()/1000));
  if (secsLeft <= 0) return;
  const elapsed = 300 - secsLeft;

  // Wait 60s minimum before deciding
  if (elapsed < 60) {
    broadcast({ type: 'engine_waiting', elapsed });
    return;
  }
  // Already locked for this window — re-broadcast
  if (lockedDecision && lockedDecision.wts === currentMarket.wts && !lockedDecision.resolved) {
    broadcast({ type: 'decision', decision: lockedDecision });
    return;
  }

  const cp = latestBTCPrice, sp = currentMarket.startPrice;
  const yp = latestOdds.yes, np = latestOdds.no;
  const delta = ((cp - sp) / sp) * 100;

  let bull = 0, bear = 0;
  // Window delta (weight 8) — dominant signal
  if      (delta >  0.10) bull += 8;
  else if (delta >  0.05) bull += 6.4;
  else if (delta >  0.02) bull += 4.8;
  else if (delta >  0.005) bull += 2.4;
  else if (delta < -0.10) bear += 8;
  else if (delta < -0.05) bear += 6.4;
  else if (delta < -0.02) bear += 4.8;
  else if (delta < -0.005) bear += 2.4;
  // Market odds (weight 2)
  if      (yp > 0.70) bull += 2;
  else if (yp > 0.55) bull += 1.2;
  else if (np > 0.70) bear += 2;
  else if (np > 0.55) bear += 1.2;

  const total = bull + bear;
  const edge = Math.abs(bull - bear);
  const absDelta = Math.abs(delta);
  let conf;
  if      (absDelta > 0.10) conf = 0.90;
  else if (absDelta > 0.05) conf = 0.75;
  else if (absDelta > 0.02) conf = 0.58;
  else if (absDelta > 0.005) conf = 0.40;
  else                       conf = 0.15;
  const oddsAligned = (bull > bear && yp > 0.55) || (bear > bull && np > 0.55);
  if (oddsAligned) conf = Math.min(1, conf + 0.08);
  if (elapsed > 200) conf = Math.min(1, conf + 0.05);
  conf = Math.max(0, Math.min(1, conf));
  const quality = Math.max(0, Math.min(1, conf * 0.75 + (Math.min(elapsed, 240) / 240) * 0.25));

  let decision = 'NO TRADE', reason = '';
  // Only NO TRADE if delta is genuinely flat (within ±0.002%)
  if (Math.abs(delta) < 0.002) {
    decision = 'NO TRADE';
    reason = `delta too flat (${delta.toFixed(4)}%) — no clear direction`;
  } else if (bull > bear) {
    decision = 'BUY UP';
    reason = `delta +${delta.toFixed(3)}% | bull ${bull.toFixed(1)} vs bear ${bear.toFixed(1)} | conf ${Math.round(conf*100)}%`;
  } else {
    decision = 'BUY DOWN';
    reason = `delta ${delta.toFixed(3)}% | bear ${bear.toFixed(1)} vs bull ${bull.toFixed(1)} | conf ${Math.round(conf*100)}%`;
  }

  console.log('[ENGINE]', decision, `| conf:${Math.round(conf*100)}% edge:${edge.toFixed(1)} delta:${delta.toFixed(3)}% elapsed:${elapsed}s`);

  lockedDecision = { wts: currentMarket.wts, decision, reason, bull, bear, conf, quality, edge, startPrice: sp, lockedAt: Date.now(), lockedAtElapsed: elapsed, resolved: false };
  broadcast({ type: 'decision', decision: lockedDecision });

  // Add PENDING to tracker history
  const time = new Date(currentMarket.wts * 1000).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true, timeZone:'America/New_York' });
  trackerData.history = trackerData.history.filter(h => h.window !== currentMarket.wts);
  trackerData.history.push({ time, decision, result: 'PENDING', window: currentMarket.wts });
  if (trackerData.history.length > 20) trackerData.history.shift();
  broadcast({ type: 'tracker', tracker: trackerData });
}

// Run engine every 10s
setInterval(() => {
  if (!lockedDecision || lockedDecision.wts !== getWindowTs()) runEngine();
  else broadcast({ type: 'decision', decision: lockedDecision });
}, 10000);

// ── BROWSER WS ────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('[WS] client connected, total:', clients.size);
  if (currentMarket)  ws.send(JSON.stringify({ type: 'market', market: currentMarket, odds: latestOdds }));
  if (latestBTCPrice) ws.send(JSON.stringify({ type: 'btc_price', price: latestBTCPrice }));
  if (lockedDecision && !lockedDecision.resolved) ws.send(JSON.stringify({ type: 'decision', decision: lockedDecision }));
  ws.send(JSON.stringify({ type: 'tracker', tracker: trackerData }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ── REST ──────────────────────────────────────────────────────
app.get('/candles', async (req, res) => {
  try {
    const r = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=30', { signal: AbortSignal.timeout(6000) });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/tracker', (req, res) => res.json(trackerData));
app.get('/health',  (req, res) => res.json({ ok: true, market: currentMarket?.slug, btc: latestBTCPrice, decision: lockedDecision?.decision || null }));

connectRTDS();
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[SERVER] port ${PORT}`));
