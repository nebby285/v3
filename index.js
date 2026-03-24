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
        lastChainlinkUpdate = Date.now();
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
    setTimeout(() => runEngine(), 3000);
  } catch(e) { console.error('[MARKET]', e.message); }
}
setInterval(updateMarket, 15000);
updateMarket();

// ── ENGINE ────────────────────────────────────────────────────
// Track Chainlink update frequency
let lastChainlinkUpdate = Date.now();
// (already set in RTDS handler — we'll update it there too)

async function fetchCandles() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=30', { signal: AbortSignal.timeout(6000) });
    return (await r.json()).map(c => ({ open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
  } catch(e) { console.warn('[CANDLES]', e.message); return null; }
}
function ema(v, p) { const k=2/(p+1); let e=v[0]; for(let i=1;i<v.length;i++) e=v[i]*k+e*(1-k); return e; }
function rsi(c, p=14) { if(c.length<p+1) return 50; let g=0,l=0; for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];d>0?g+=d:l-=d;} const ag=g/p,al=l/p; if(!al) return 100; return 100-(100/(1+ag/al)); }
function avg(a) { return a.reduce((s,x)=>s+x,0)/a.length; }

async function runEngine() {
  if (!currentMarket || !latestBTCPrice || !currentMarket.startPrice) return;
  const secsLeft = Math.max(0, currentMarket.endSec - Math.floor(Date.now()/1000));
  if (secsLeft <= 0) return;
  const elapsed = 300 - secsLeft;

  // Wait 60s minimum
  if (elapsed < 60) { broadcast({ type: 'engine_waiting', elapsed }); return; }
  // Already locked — re-broadcast
  if (lockedDecision && lockedDecision.wts === currentMarket.wts && !lockedDecision.resolved) {
    broadcast({ type: 'decision', decision: lockedDecision }); return;
  }

  const cp = latestBTCPrice, sp = currentMarket.startPrice;
  const yp = latestOdds.yes, np = latestOdds.no;
  const delta = ((cp - sp) / sp) * 100;
  const absDelta = Math.abs(delta);

  // Fetch candles for technical signals
  const candles = await fetchCandles();

  let bull = 0, bear = 0;
  let signals = [];

  // ── SIGNAL 1: Window Delta (weight 8) ─────────────────────
  if      (delta >  0.10) { bull += 8;   signals.push('delta strongly UP'); }
  else if (delta >  0.05) { bull += 6.4; signals.push('delta UP'); }
  else if (delta >  0.02) { bull += 4.8; signals.push('delta slightly UP'); }
  else if (delta >  0.005){ bull += 2.4; signals.push('delta barely UP'); }
  else if (delta < -0.10) { bear += 8;   signals.push('delta strongly DOWN'); }
  else if (delta < -0.05) { bear += 6.4; signals.push('delta DOWN'); }
  else if (delta < -0.02) { bear += 4.8; signals.push('delta slightly DOWN'); }
  else if (delta < -0.005){ bear += 2.4; signals.push('delta barely DOWN'); }

  // ── SIGNAL 2: Market Odds (weight 2) ──────────────────────
  if      (yp > 0.70) { bull += 2;   signals.push(`YES bid ${Math.round(yp*100)}¢`); }
  else if (yp > 0.55) { bull += 1.2; signals.push(`YES lean ${Math.round(yp*100)}¢`); }
  else if (np > 0.70) { bear += 2;   signals.push(`NO bid ${Math.round(np*100)}¢`); }
  else if (np > 0.55) { bear += 1.2; signals.push(`NO lean ${Math.round(np*100)}¢`); }

  // ── CANDLE SIGNALS ─────────────────────────────────────────
  let confMod = 0;
  if (candles && candles.length >= 5) {
    // SIGNAL 3: 1m Momentum (weight 2.5)
    if (candles.length >= 3) {
      const m1 = candles[candles.length-1].close - candles[candles.length-1].open;
      const m2 = candles[candles.length-2].close - candles[candles.length-2].open;
      if (m1>0 && m2>0) { bull += 2.5; signals.push('2 bull candles'); }
      else if (m1<0 && m2<0) { bear += 2.5; signals.push('2 bear candles'); }
      else if (m1>0) { bull += 1.25; signals.push('last candle bullish'); }
      else if (m1<0) { bear += 1.25; signals.push('last candle bearish'); }
    }
    // SIGNAL 4: 3m Trend (weight 2)
    if (candles.length >= 4) {
      const sl = candles.slice(-3);
      const bc = sl.filter(c=>c.close>c.open).length, rc = sl.filter(c=>c.close<c.open).length;
      if (bc===3) { bull += 2; signals.push('3/3 bull candles'); }
      else if (rc===3) { bear += 2; signals.push('3/3 bear candles'); }
      else if (bc===2) { bull += 1; signals.push('2/3 bull'); }
      else if (rc===2) { bear += 1; signals.push('2/3 bear'); }
    }
    // SIGNAL 5: EMA 9/21 (weight 1)
    if (candles.length >= 22) {
      const cl = candles.map(c=>c.close);
      const e9 = ema(cl.slice(-9),9), e21 = ema(cl.slice(-21),21);
      const g = ((e9-e21)/e21)*100;
      if (g > 0.02) { bull += 1; signals.push(`EMA9>EMA21 +${g.toFixed(3)}%`); }
      else if (g < -0.02) { bear += 1; signals.push(`EMA9<EMA21 ${g.toFixed(3)}%`); }
    }
    // SIGNAL 6: RSI (weight 1.5)
    if (candles.length >= 16) {
      const r = rsi(candles.map(c=>c.close), 14);
      if (r < 25) { bull += 1.5; signals.push(`RSI oversold ${r.toFixed(0)}`); }
      else if (r < 35) { bull += 0.75; signals.push(`RSI low ${r.toFixed(0)}`); }
      else if (r > 75) { bear += 1.5; signals.push(`RSI overbought ${r.toFixed(0)}`); }
      else if (r > 65) { bear += 0.75; signals.push(`RSI high ${r.toFixed(0)}`); }
    }
    // SIGNAL 7: Volume spike (confidence modifier)
    if (candles.length >= 7) {
      const recentVol = avg(candles.slice(-3).map(c=>c.volume));
      const priorVol  = avg(candles.slice(-6,-3).map(c=>c.volume));
      const ratio = recentVol / priorVol;
      if (ratio > 1.5) { confMod += 0.10; signals.push(`vol surge ${ratio.toFixed(1)}x`); }
      else if (ratio > 1.2) { confMod += 0.05; signals.push('vol elevated'); }
      else if (ratio < 0.6) { confMod -= 0.08; signals.push('vol dry'); }
    }
    // SIGNAL 8: Wick rejection (weight 1.5)
    if (candles.length >= 2) {
      const l = candles[candles.length-1];
      const body = Math.abs(l.close-l.open), range = l.high-l.low;
      if (range > 0) {
        const uw = (l.high - Math.max(l.open,l.close)) / range;
        const lw = (Math.min(l.open,l.close) - l.low) / range;
        if (uw > 0.5 && body/range < 0.3) { bear += 1.5; signals.push(`bear wick ${Math.round(uw*100)}%`); }
        else if (lw > 0.5 && body/range < 0.3) { bull += 1.5; signals.push(`bull wick ${Math.round(lw*100)}%`); }
      }
    }
    // SIGNAL 9: Choppiness penalty
    let dirChanges = 0;
    const sl5 = candles.slice(-5);
    for (let i=1;i<sl5.length;i++) {
      const p=sl5[i-1].close-sl5[i-1].open, q=sl5[i].close-sl5[i].open;
      if ((p>0&&q<0)||(p<0&&q>0)) dirChanges++;
    }
    if (dirChanges >= 3) { confMod -= 0.12; signals.push(`choppy ${dirChanges}/4`); }
  } else {
    signals.push('no candles — delta+odds only');
  }

  // ── SIGNAL 10: Chainlink update frequency ─────────────────
  const chainlinkAge = (Date.now() - lastChainlinkUpdate) / 1000;
  if (chainlinkAge > 25) {
    confMod -= 0.15;
    signals.push(`Chainlink stale ${chainlinkAge.toFixed(0)}s — low vol`);
  } else if (chainlinkAge > 12) {
    confMod -= 0.07;
    signals.push(`Chainlink slow ${chainlinkAge.toFixed(0)}s`);
  }

  // ── CONFIDENCE ─────────────────────────────────────────────
  let conf;
  if      (absDelta > 0.10) conf = 0.90;
  else if (absDelta > 0.05) conf = 0.75;
  else if (absDelta > 0.02) conf = 0.58;
  else if (absDelta > 0.005) conf = 0.40;
  else                       conf = 0.15;

  // Candle agreement boosts/reduces confidence
  const total = bull + bear;
  const signalAlignment = total > 0 ? (bull > bear ? bull/total : bear/total) : 0.5;
  conf = conf * 0.6 + signalAlignment * 0.4;

  // Apply modifiers
  conf = Math.max(0, Math.min(1, conf + confMod));

  // Odds aligned = small boost
  const oddsAligned = (bull > bear && yp > 0.55) || (bear > bull && np > 0.55);
  if (oddsAligned) conf = Math.min(1, conf + 0.05);
  if (elapsed > 200) conf = Math.min(1, conf + 0.04);

  const quality = Math.max(0, Math.min(1, conf * 0.75 + (Math.min(elapsed,240)/240) * 0.25));
  const edge = Math.abs(bull - bear);

  // ── DECISION ───────────────────────────────────────────────
  let decision = 'NO TRADE', reason = '';
  if (absDelta < 0.002) {
    decision = 'NO TRADE';
    reason = `delta flat (${delta.toFixed(4)}%)`;
  } else if (bull > bear) {
    decision = 'BUY UP';
    reason = signals.slice(0,3).join(' · ');
  } else {
    decision = 'BUY DOWN';
    reason = signals.slice(0,3).join(' · ');
  }

  console.log('[ENGINE]', decision, `conf:${Math.round(conf*100)}% quality:${Math.round(quality*100)}% delta:${delta.toFixed(3)}% elapsed:${elapsed}s | ${signals.join(', ')}`);

  lockedDecision = { wts: currentMarket.wts, decision, reason, bull, bear, conf, quality, edge, startPrice: sp, lockedAt: Date.now(), lockedAtElapsed: elapsed, resolved: false };
  broadcast({ type: 'decision', decision: lockedDecision });

  const time = new Date(currentMarket.wts * 1000).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true, timeZone:'America/New_York' });
  trackerData.history = trackerData.history.filter(h => h.window !== currentMarket.wts);
  trackerData.history.push({ time, decision, result: 'PENDING', window: currentMarket.wts });
  if (trackerData.history.length > 20) trackerData.history.shift();
  broadcast({ type: 'tracker', tracker: trackerData });
}

// Run engine every 10s
setInterval(async () => {
  if (!lockedDecision || lockedDecision.wts !== getWindowTs()) await runEngine();
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
