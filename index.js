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
let clients        = new Set();

// ── LOCKED DECISION — one per window, same for ALL clients ────────────────────
let lockedDecision = null;
// { wts, decision, reason, bull, bear, conf, quality, edge, ev,
//   tokenPrice, startPrice, signals, lockedAt, resolved }

// ── TRACKER ───────────────────────────────────────────────────────────────────
let trackerData = { wins: 0, losses: 0, skips: 0, history: [] };

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getWindowTs(offset = 0) {
  const sec = Math.floor(Date.now() / 1000);
  return (sec - (sec % 300)) + offset * 300;
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

// ── PRICE TO BEAT ─────────────────────────────────────────────────────────────
async function fetchPriceToBeat(windowTs) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${windowTs*1000}&endTime=${(windowTs+180)*1000}&limit=3`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    if (Array.isArray(d) && d.length > 0) {
      const target = windowTs * 1000;
      let best = d[0];
      for (const c of d) if (Math.abs(c[0]-target) < Math.abs(best[0]-target)) best = c;
      return parseFloat(best[1]);
    }
  } catch(e) { console.error('[PTB]', e.message); }
  return null;
}

// ── BINANCE CANDLES ───────────────────────────────────────────────────────────
async function fetchCandles(limit = 30) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`, { signal: AbortSignal.timeout(5000) });
    return (await r.json()).map(c => ({
      ts: c[0]/1000, open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5])
    }));
  } catch(e) { return null; }
}

// ── MATH ──────────────────────────────────────────────────────────────────────
function ema(v, p) { const k=2/(p+1); let e=v[0]; for(let i=1;i<v.length;i++) e=v[i]*k+e*(1-k); return e; }
function rsi(c, p=14) { if(c.length<p+1) return 50; let g=0,l=0; for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];d>0?g+=d:l-=d;} const ag=g/p,al=l/p; if(!al) return 100; return 100-(100/(1+ag/al)); }
function avg(a) { return a.reduce((x,y)=>x+y,0)/a.length; }
function clamp(v,mn,mx) { return Math.max(mn,Math.min(mx,v)); }
function atr(candles, p=5) {
  if(candles.length < p+1) return 0;
  const trs = candles.slice(-p).map((c,i,a) => {
    if(i===0) return c.high-c.low;
    return Math.max(c.high-c.low, Math.abs(c.high-a[i-1].close), Math.abs(c.low-a[i-1].close));
  });
  return avg(trs);
}

// ── SIGNAL WEIGHTS ────────────────────────────────────────────────────────────
// Researched optimal weights for 5m Polymarket binary markets:
// Window delta is king (confirmed by multiple sources), market odds divergence
// is the second most important signal (exploiting lag between Chainlink and market)
const W = {
  windowDelta:     8.0,  // dominant — directly answers the question
  marketOddsDiv:   3.0,  // NEW: our model vs market price = exploitable edge
  momentum1m:      2.5,
  trend3m:         2.0,
  trend5m:         1.5,
  acceleration:    1.5,
  emaCross:        1.0,
  rsiExtreme:      1.5,
  volatilityRegime:1.5,  // NEW: ATR-based regime detection
  fakeBreakout:    1.5,
  meanReversion:   1.0,
  volumeSurge:     1.0,  // confidence modifier
  timeInWindow:    1.0,  // confidence modifier
};

// ── SIGNALS ───────────────────────────────────────────────────────────────────

function signalWindowDelta(cp, sp) {
  if(!cp||!sp) return { bull:0, bear:0, note:'no data' };
  const d = ((cp-sp)/sp)*100;
  let bull=0, bear=0;
  // Research: delta > 0.10% = nearly certain, sweet spot is 0.02–0.10%
  if(d > 0.15)      { bull=1.0; }
  else if(d > 0.05) { bull=0.85; }
  else if(d > 0.02) { bull=0.65; }
  else if(d > 0.005){ bull=0.35; }
  else if(d < -0.15){ bear=1.0; }
  else if(d < -0.05){ bear=0.85; }
  else if(d < -0.02){ bear=0.65; }
  else if(d < -0.005){ bear=0.35; }
  return { bull, bear, deltaPct: d.toFixed(4), note: d.toFixed(4)+'% vs PTB' };
}

// NEW: Market odds divergence — if our model says 65% UP but market only shows 52%,
// that gap is exploitable alpha. Market lags Chainlink by seconds.
function signalMarketOddsDivergence(modelBullProb, yesPrice, noPrice) {
  if(!yesPrice||!noPrice) return { bull:0, bear:0, note:'no odds' };
  const marketUpProb  = yesPrice;   // ¢55 = 55% implied probability
  const marketDnProb  = noPrice;
  const bullDiv = modelBullProb - marketUpProb;  // positive = we're more bullish than market
  const bearDiv = (1-modelBullProb) - marketDnProb;

  if(bullDiv > 0.12)      return { bull:1.0, bear:0, note:`model +${(bullDiv*100).toFixed(0)}% vs market — bullish edge` };
  else if(bullDiv > 0.06) return { bull:0.6, bear:0, note:`model +${(bullDiv*100).toFixed(0)}% vs market` };
  else if(bearDiv > 0.12) return { bull:0, bear:1.0, note:`model +${(bearDiv*100).toFixed(0)}% bearish vs market` };
  else if(bearDiv > 0.06) return { bull:0, bear:0.6, note:`model +${(bearDiv*100).toFixed(0)}% bearish vs market` };
  return { bull:0, bear:0, note:'no divergence from market' };
}

function signalMomentum1m(c) {
  if(c.length<3) return { bull:0, bear:0, note:'insufficient' };
  const m1=c[c.length-1].close-c[c.length-1].open, m2=c[c.length-2].close-c[c.length-2].open;
  if(m1>0&&m2>0) return { bull:1, bear:0, note:'2 bull candles' };
  if(m1<0&&m2<0) return { bull:0, bear:1, note:'2 bear candles' };
  if(m1>0)       return { bull:0.5, bear:0, note:'last candle bullish' };
  if(m1<0)       return { bull:0, bear:0.5, note:'last candle bearish' };
  return { bull:0, bear:0, note:'doji/flat' };
}

function signalTrend3m(c) {
  if(c.length<4) return { bull:0, bear:0, note:'insufficient' };
  const s=c.slice(-3), bc=s.filter(x=>x.close>x.open).length, rc=s.filter(x=>x.close<x.open).length;
  if(bc===3) return { bull:1, bear:0, note:'3/3 bull' };
  if(rc===3) return { bull:0, bear:1, note:'3/3 bear' };
  if(bc===2) return { bull:0.5, bear:0, note:'2/3 bull' };
  if(rc===2) return { bull:0, bear:0.5, note:'2/3 bear' };
  return { bull:0, bear:0, note:'mixed' };
}

function signalTrend5m(c) {
  if(c.length<6) return { bull:0, bear:0, note:'insufficient' };
  const m=c[c.length-1].close-c[c.length-5].open, p=(m/c[c.length-5].open)*100;
  if(p > 0.08) return { bull:1, bear:0, note:'5m +'+p.toFixed(3)+'%' };
  if(p > 0.02) return { bull:0.6, bear:0, note:'5m +'+p.toFixed(3)+'%' };
  if(p < -0.08) return { bull:0, bear:1, note:'5m '+p.toFixed(3)+'%' };
  if(p < -0.02) return { bull:0, bear:0.6, note:'5m '+p.toFixed(3)+'%' };
  return { bull:0, bear:0, note:'5m flat' };
}

function signalAcceleration(c) {
  if(c.length<4) return { bull:0, bear:0, note:'insufficient' };
  const n=c.length, m1=c[n-1].close-c[n-1].open, m2=c[n-2].close-c[n-2].open;
  const acc=Math.abs(m1)>Math.abs(m2), same=(m1>0)===(m2>0);
  if(acc&&same&&m1>0) return { bull:1, bear:0, note:'bullish accel' };
  if(acc&&same&&m1<0) return { bull:0, bear:1, note:'bearish accel' };
  if(!acc&&same&&m1>0) return { bull:0.2, bear:0, note:'bull decel' };
  if(!acc&&same&&m1<0) return { bull:0, bear:0.2, note:'bear decel' };
  return { bull:0, bear:0, note:'reversal' };
}

function signalEMACross(c) {
  if(c.length<22) return { bull:0, bear:0, note:'insufficient' };
  const cl=c.map(x=>x.close), e9=ema(cl.slice(-9),9), e21=ema(cl.slice(-21),21);
  const g=((e9-e21)/e21)*100;
  if(g > 0.02) return { bull:1, bear:0, note:'EMA9>EMA21 +'+g.toFixed(3)+'%' };
  if(g < -0.02) return { bull:0, bear:1, note:'EMA9<EMA21 '+g.toFixed(3)+'%' };
  return { bull:0, bear:0, note:'EMA flat' };
}

function signalRSI(c) {
  if(c.length<16) return { bull:0, bear:0, note:'insufficient' };
  const r=rsi(c.map(x=>x.close),14);
  if(r<25) return { bull:1, bear:0, note:'RSI oversold '+r.toFixed(0) };
  if(r<35) return { bull:0.5, bear:0, note:'RSI low '+r.toFixed(0) };
  if(r>75) return { bull:0, bear:1, note:'RSI overbought '+r.toFixed(0) };
  if(r>65) return { bull:0, bear:0.5, note:'RSI high '+r.toFixed(0) };
  return { bull:0, bear:0, note:'RSI neutral '+r.toFixed(0) };
}

// NEW: Volatility regime — high ATR = mean reversion bias (DOWN after spike UP),
// low ATR = trend continuation. Research confirmed this for 5m binary markets.
function signalVolatilityRegime(c, cp, sp) {
  if(c.length<8||!cp||!sp) return { bull:0, bear:0, confidence_mod:0, note:'insufficient' };
  const atrVal = atr(c, 5);
  const avgClose = avg(c.slice(-10).map(x=>x.close));
  const atrPct = (atrVal/avgClose)*100;
  const delta = ((cp-sp)/sp)*100;

  // High volatility (ATR > 0.08%) → mean reversion likely
  if(atrPct > 0.08) {
    // If already up a lot in high vol → fade it (DOWN)
    if(delta > 0.08)  return { bull:0, bear:0.8, confidence_mod:-0.05, note:`high vol (${atrPct.toFixed(3)}%) + extended UP → reversion` };
    if(delta < -0.08) return { bull:0.8, bear:0, confidence_mod:-0.05, note:`high vol (${atrPct.toFixed(3)}%) + extended DOWN → reversion` };
    return { bull:0, bear:0, confidence_mod:-0.1, note:`high vol (${atrPct.toFixed(3)}%) choppy — lower confidence` };
  }
  // Low volatility (ATR < 0.03%) → trend continuation
  if(atrPct < 0.03) {
    if(delta > 0.005) return { bull:0.5, bear:0, confidence_mod:0.05, note:`low vol trend continuation UP` };
    if(delta < -0.005) return { bull:0, bear:0.5, confidence_mod:0.05, note:`low vol trend continuation DOWN` };
  }
  return { bull:0, bear:0, confidence_mod:0, note:`normal vol (${atrPct.toFixed(3)}%)` };
}

function signalFakeBreakout(c) {
  if(c.length<3) return { bull:0, bear:0, note:'insufficient' };
  const l=c[c.length-1], body=Math.abs(l.close-l.open), range=l.high-l.low;
  if(!range) return { bull:0, bear:0, note:'no range' };
  const uw=(l.high-Math.max(l.open,l.close))/range;
  const lw=(Math.min(l.open,l.close)-l.low)/range;
  if(uw>0.5&&body/range<0.3) return { bull:0, bear:1, note:'bear wick '+Math.round(uw*100)+'%' };
  if(lw>0.5&&body/range<0.3) return { bull:1, bear:0, note:'bull wick '+Math.round(lw*100)+'%' };
  if(body/range>0.7) return l.close>l.open ? { bull:0.5, bear:0, note:'strong bull candle' } : { bull:0, bear:0.5, note:'strong bear candle' };
  return { bull:0, bear:0, note:'normal candle' };
}

function signalMeanReversion(c, cp) {
  if(c.length<10||!cp) return { bull:0, bear:0, note:'insufficient' };
  const m=avg(c.slice(-10).map(x=>x.close)), d=((cp-m)/m)*100;
  if(d > 0.15) return { bull:0, bear:0.8, note:'+'+d.toFixed(3)+'% above mean' };
  if(d > 0.08) return { bull:0, bear:0.4, note:'+'+d.toFixed(3)+'% above mean' };
  if(d < -0.15) return { bull:0.8, bear:0, note:d.toFixed(3)+'% below mean' };
  if(d < -0.08) return { bull:0.4, bear:0, note:d.toFixed(3)+'% below mean' };
  return { bull:0, bear:0, note:'near mean' };
}

function signalVolumeSurge(c) {
  if(c.length<7) return { confidence_mod:0, note:'insufficient' };
  const ra=avg(c.slice(-3).map(x=>x.volume)), pa=avg(c.slice(-6,-3).map(x=>x.volume)), ratio=ra/pa;
  if(ratio>1.5) return { confidence_mod:0.12, note:'vol surge '+ratio.toFixed(2)+'x' };
  if(ratio>1.2) return { confidence_mod:0.06, note:'vol elevated' };
  if(ratio<0.6) return { confidence_mod:-0.12, note:'vol dry '+ratio.toFixed(2)+'x' };
  return { confidence_mod:0, note:'vol normal' };
}

// NEW: Optimal timing — research shows T-90s to T-120s is the sweet spot.
// Early window = noise, last seconds = token already priced in.
// Returns confidence modifier and whether we should even fire yet.
function signalTimeInWindow(secsLeft, total=300) {
  const elapsed = total - secsLeft;
  const elapsedPct = elapsed / total;

  // Too early (< 60s elapsed) — not enough info, delay firing
  if(elapsed < 60)  return { confidence_mod:-0.25, shouldFire:false, note:`too early (${elapsed}s elapsed) — waiting` };
  // Sweet spot: 90s–180s elapsed (T-210s to T-120s remaining)
  if(elapsed >= 90 && elapsed <= 180) return { confidence_mod:0.15, shouldFire:true, note:`optimal window (${elapsed}s elapsed)` };
  // Good: 60–90s or 180–240s elapsed
  if(elapsed >= 60 && elapsed < 90)  return { confidence_mod:0.05, shouldFire:true, note:`early-mid window (${elapsed}s)` };
  if(elapsed > 180 && elapsed <= 240) return { confidence_mod:0.05, shouldFire:true, note:`mid-late window (${elapsed}s)` };
  // Very late (> 240s = last 60s) — token already priced in, skip
  if(elapsed > 240) return { confidence_mod:-0.15, shouldFire:true, note:`late window — token priced in` };
  return { confidence_mod:0, shouldFire:true, note:`${elapsed}s elapsed` };
}

function measureChoppiness(c) {
  if(c.length<5) return { chopScore:0.5, note:'insufficient' };
  const s=c.slice(-5); let dc=0;
  for(let i=1;i<s.length;i++){const p=s[i-1].close-s[i-1].open,q=s[i].close-s[i].open;if((p>0&&q<0)||(p<0&&q>0))dc++;}
  return { chopScore:dc/4, note:dc+'/4 dir changes' };
}

// ── TOKEN PRICE MODEL ─────────────────────────────────────────────────────────
// Research-backed piecewise model: delta% → expected token cost
// Source: observed live Polymarket trading behavior
function estimateTokenPrice(deltaPct, direction) {
  const absDelta = Math.abs(deltaPct);
  const isCorrectDirection = (direction === 'UP' && deltaPct > 0) || (direction === 'DOWN' && deltaPct < 0);

  if(!isCorrectDirection) {
    // Wrong direction — token is cheap (other side is expensive)
    if(absDelta > 0.10) return 0.08;   // nearly certain loser
    if(absDelta > 0.05) return 0.20;
    if(absDelta > 0.02) return 0.35;
    return 0.50;  // close to even
  }
  // Correct direction
  if(absDelta < 0.005) return 0.50;   // coin flip
  if(absDelta < 0.02)  return 0.55;   // slight lean
  if(absDelta < 0.05)  return 0.65;   // moderate edge
  if(absDelta < 0.10)  return 0.78;   // strong
  if(absDelta < 0.15)  return 0.88;   // very strong
  return 0.94;                          // near certain
}

// ── EXPECTED VALUE CALCULATION ────────────────────────────────────────────────
// EV = (win_probability × $1.00) - token_cost - fees
// Polymarket fee ~2% on some markets, gas ~$0.01 (negligible for signal purposes)
// Only trade if EV > 0.03 (3% positive edge minimum)
function calculateEV(winProb, tokenCost, fee=0.02) {
  const payout = 1.00;
  const cost   = tokenCost * (1 + fee);
  return (winProb * payout) - cost;
}

// ── MAIN ENGINE ───────────────────────────────────────────────────────────────
async function runEngine() {
  if(!currentMarket || !latestBTCPrice || !currentMarket.startPrice) return;

  const nowSec   = Math.floor(Date.now() / 1000);
  const secsLeft = Math.max(0, currentMarket.endSec - nowSec);
  if(secsLeft <= 0) return;

  const elapsed = 300 - secsLeft;

  // ── TIMING GATE — don't fire before 60s elapsed ───────────────────────────
  if(elapsed < 60) {
    console.log(`[ENGINE] too early (${elapsed}s), waiting for 60s mark`);
    return;
  }

  // ── Already locked this window ─────────────────────────────────────────────
  if(lockedDecision && lockedDecision.wts === currentMarket.wts && !lockedDecision.resolved) {
    // Re-broadcast to any new connections but don't re-evaluate
    return;
  }

  console.log(`[ENGINE] evaluating at T+${elapsed}s...`);

  const candles = await fetchCandles(30);
  if(!candles || candles.length < 5) { console.log('[ENGINE] no candles'); return; }

  const cp = latestBTCPrice;
  const sp = currentMarket.startPrice;
  const yp = latestOdds.yes;
  const np = latestOdds.no;

  // Run all signals
  const s1  = signalWindowDelta(cp, sp);
  const s2  = signalMomentum1m(candles);
  const s3  = signalTrend3m(candles);
  const s4  = signalTrend5m(candles);
  const s5  = signalAcceleration(candles);
  const s6  = signalEMACross(candles);
  const s7  = signalRSI(candles);
  const s8  = signalVolumeSurge(candles);       // confidence modifier
  const s9  = signalVolatilityRegime(candles, cp, sp);
  const s10 = signalFakeBreakout(candles);
  const s11 = signalMeanReversion(candles, cp);
  const s12 = signalTimeInWindow(secsLeft);      // confidence modifier

  // Weighted scores
  let bull=0, bear=0;
  bull += s1.bull*W.windowDelta;    bear += s1.bear*W.windowDelta;
  bull += s2.bull*W.momentum1m;     bear += s2.bear*W.momentum1m;
  bull += s3.bull*W.trend3m;        bear += s3.bear*W.trend3m;
  bull += s4.bull*W.trend5m;        bear += s4.bear*W.trend5m;
  bull += s5.bull*W.acceleration;   bear += s5.bear*W.acceleration;
  bull += s6.bull*W.emaCross;       bear += s6.bear*W.emaCross;
  bull += s7.bull*W.rsiExtreme;     bear += s7.bear*W.rsiExtreme;
  bull += s9.bull*W.volatilityRegime; bear += s9.bear*W.volatilityRegime;
  bull += s10.bull*W.fakeBreakout;  bear += s10.bear*W.fakeBreakout;
  bull += s11.bull*W.meanReversion; bear += s11.bear*W.meanReversion;

  // Model probability (bull probability)
  const total = bull + bear;
  const rawBullProb = total > 0 ? bull / total : 0.5;

  // Market odds divergence — now we know our model prob, compare to market
  const s13 = signalMarketOddsDivergence(rawBullProb, yp, np);
  bull += s13.bull * W.marketOddsDiv;
  bear += s13.bear * W.marketOddsDiv;

  // Recalculate with divergence signal included
  const total2   = bull + bear;
  const edge     = Math.abs(bull - bear);
  const maxScore = Object.values(W).reduce((a,b)=>a+b,0);

  // Confidence
  let conf = total2 > 0 ? edge / total2 : 0;
  conf += (s8.confidence_mod  || 0);
  conf += (s9.confidence_mod  || 0);
  conf += (s12.confidence_mod || 0);
  const chop = measureChoppiness(candles);
  conf -= chop.chopScore * 0.2;
  conf  = clamp(conf, 0, 1);

  const strength = total2 / maxScore;
  const quality  = clamp((strength + conf) / 2, 0, 1);

  // Determine direction and token cost
  const direction = bull > bear ? 'UP' : 'DOWN';
  const deltaPct  = parseFloat(s1.deltaPct || '0');
  const tokenPrice = estimateTokenPrice(deltaPct, direction);

  // Win probability from model
  const winProb = direction === 'UP'
    ? clamp(bull / (bull + bear + 0.001), 0.01, 0.99)
    : clamp(bear / (bull + bear + 0.001), 0.01, 0.99);

  // Expected Value — the key new metric
  const ev = calculateEV(winProb, tokenPrice);

  // ── DECISION THRESHOLDS ────────────────────────────────────────────────────
  // Research: only trade when token is ¢52–¢80 (sweet spot for value)
  // Too cheap = no real edge, too expensive = market already priced in
  const tokenPriceCents = Math.round(tokenPrice * 100);
  const TOKEN_MIN = 0.52;  // below this = coin flip, no edge
  const TOKEN_MAX = 0.82;  // above this = market already knows, no value left
  const MIN_CONF  = 0.35;
  const MIN_EDGE  = 1.5;
  const MIN_EV    = 0.03;  // minimum 3% expected value

  let decision = 'NO TRADE';
  let reason   = '';

  if(!s12.shouldFire) {
    decision = 'NO TRADE';
    reason   = s12.note;
  } else if(conf < MIN_CONF) {
    decision = 'NO TRADE';
    reason   = `confidence too low (${(conf*100).toFixed(0)}%)`;
  } else if(quality < 0.35) {
    decision = 'NO TRADE';
    reason   = `signal quality too low (${(quality*100).toFixed(0)}%)`;
  } else if(edge < MIN_EDGE) {
    decision = 'NO TRADE';
    reason   = `edge too small (${edge.toFixed(2)})`;
  } else if(tokenPrice < TOKEN_MIN) {
    decision = 'NO TRADE';
    reason   = `token too cheap (¢${tokenPriceCents}) — no real edge yet`;
  } else if(tokenPrice > TOKEN_MAX) {
    decision = 'NO TRADE';
    reason   = `token too expensive (¢${tokenPriceCents}) — market already priced in`;
  } else if(ev < MIN_EV) {
    decision = 'NO TRADE';
    reason   = `negative EV (${(ev*100).toFixed(1)}%) — not worth it at ¢${tokenPriceCents}`;
  } else if(bull > bear) {
    decision = 'BUY UP';
    reason   = `bull ${bull.toFixed(2)} vs bear ${bear.toFixed(2)} | EV +${(ev*100).toFixed(1)}% at ¢${tokenPriceCents}`;
  } else {
    decision = 'BUY DOWN';
    reason   = `bear ${bear.toFixed(2)} vs bull ${bull.toFixed(2)} | EV +${(ev*100).toFixed(1)}% at ¢${tokenPriceCents}`;
  }

  console.log(`[ENGINE] LOCKED: ${decision} | T+${elapsed}s | edge:${edge.toFixed(2)} conf:${(conf*100).toFixed(0)}% EV:${(ev*100).toFixed(1)}% token:¢${tokenPriceCents}`);

  // Lock the decision for this window
  lockedDecision = {
    wts: currentMarket.wts,
    decision, reason, bull, bear, conf, quality, edge, ev,
    tokenPrice, winProb, deltaPct,
    startPrice: sp,
    lockedAt: Date.now(),
    lockedAtElapsed: elapsed,
    resolved: false,
    signals: {
      s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, chop
    }
  };

  // Broadcast to all clients
  broadcast({ type: 'decision', decision: lockedDecision });

  // Add as PENDING in tracker history
  const time = new Date(currentMarket.wts*1000).toLocaleTimeString('en-US', {
    hour:'2-digit', minute:'2-digit', hour12:true, timeZone:'America/New_York'
  });
  trackerData.history = trackerData.history.filter(h => h.window !== currentMarket.wts);
  trackerData.history.push({ time, decision, result:'PENDING', window: currentMarket.wts, ev: ev.toFixed(3) });
  if(trackerData.history.length > 50) trackerData.history.shift();
}

// ── ENGINE LOOP ───────────────────────────────────────────────────────────────
// Runs every 10 seconds — but only fires a decision once per window
// after the 60s timing gate
setInterval(runEngine, 10000);

// ── RESOLVE PREVIOUS WINDOW ───────────────────────────────────────────────────
function resolveLastDecision(newWindowWts) {
  if(!lockedDecision || lockedDecision.resolved) return;
  if(lockedDecision.wts === newWindowWts) return;

  const { decision, startPrice } = lockedDecision;
  const finalPrice = latestBTCPrice;

  let result = 'SKIP';
  if(decision !== 'NO TRADE' && finalPrice && startPrice) {
    const btcWentUp = finalPrice >= startPrice;
    const won = (decision === 'BUY UP' && btcWentUp) || (decision === 'BUY DOWN' && !btcWentUp);
    result = won ? 'WIN' : 'LOSS';
    if(won) trackerData.wins++;
    else    trackerData.losses++;
  } else if(decision === 'NO TRADE') {
    trackerData.skips++;
    result = 'SKIP';
  }

  // Update history entry
  const idx = trackerData.history.findIndex(h => h.window === lockedDecision.wts);
  if(idx >= 0) trackerData.history[idx].result = result;

  lockedDecision.resolved = true;
  console.log(`[TRACKER] ${decision} → ${result} | W:${trackerData.wins} L:${trackerData.losses} S:${trackerData.skips}`);

  // Broadcast updated tracker
  broadcast({ type: 'tracker', tracker: trackerData });
}

// ── CLOB WS ───────────────────────────────────────────────────────────────────
let clobWS = null, clobReconnT = null;

function connectClobWS() {
  if(clobWS) { try { clobWS.terminate(); } catch(e) {} }
  if(!currentMarket?.yesTokenId) return;
  clobWS = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
  clobWS.on('open', () => {
    clobWS.send(JSON.stringify({ auth:{}, markets:[], assets_ids:[currentMarket.yesTokenId, currentMarket.noTokenId] }));
    clobWS._ping = setInterval(() => { if(clobWS.readyState===WebSocket.OPEN) clobWS.ping(); }, 5000);
  });
  clobWS.on('message', (raw) => {
    try {
      const arr = [].concat(JSON.parse(raw.toString()));
      for(const ev of arr) {
        if(ev.event_type !== 'price_change' && ev.event_type !== 'last_trade_price') continue;
        const price = parseFloat(ev.price ?? ev.last_trade_price);
        if(isNaN(price)||price<=0||price>=1) continue;
        const isYes = ev.asset_id === currentMarket.yesTokenId;
        if(isYes) { latestOdds.yes=price; latestOdds.no=parseFloat((1-price).toFixed(4)); }
        else       { latestOdds.no=price;  latestOdds.yes=parseFloat((1-price).toFixed(4)); }
        broadcast({ type:'odds', yes:latestOdds.yes, no:latestOdds.no });
      }
    } catch(e) {}
  });
  clobWS.on('close', () => { clearInterval(clobWS._ping); clobReconnT=setTimeout(connectClobWS,3000); });
  clobWS.on('error', (e) => console.error('[CLOB]',e.message));
}

// ── RTDS WS ───────────────────────────────────────────────────────────────────
let rtdsWS = null, rtdsReconnT = null;

function connectRTDS() {
  if(rtdsWS) { try { rtdsWS.terminate(); } catch(e) {} }
  rtdsWS = new WebSocket('wss://ws-live-data.polymarket.com');
  rtdsWS.on('open', () => {
    rtdsWS.send(JSON.stringify({ action:'subscribe', subscriptions:[{ topic:'crypto_prices_chainlink', type:'*', filters:'{"symbol":"btc/usd"}' }] }));
    rtdsWS._ping = setInterval(() => { if(rtdsWS.readyState===WebSocket.OPEN) rtdsWS.send(JSON.stringify({action:'PING'})); }, 5000);
  });
  rtdsWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if(msg.topic==='crypto_prices_chainlink' && msg.payload?.value) {
        latestBTCPrice = parseFloat(msg.payload.value);
        broadcast({ type:'btc_price', price:latestBTCPrice });
      }
    } catch(e) {}
  });
  rtdsWS.on('close', () => { clearInterval(rtdsWS._ping); rtdsReconnT=setTimeout(connectRTDS,3000); });
  rtdsWS.on('error', (e) => console.error('[RTDS]',e.message));
}

// ── MARKET LOOP ───────────────────────────────────────────────────────────────
async function fetchMarketData(slug) {
  const r = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`, { headers:{'User-Agent':'Mozilla/5.0'} });
  const d = await r.json();
  return Array.isArray(d) && d.length ? d[0] : null;
}

async function fetchInitialOdds(tokenId) {
  try {
    const r = await fetch(`https://clob.polymarket.com/price?token_id=${tokenId}&side=BUY`, { headers:{'User-Agent':'Mozilla/5.0'} });
    const d = await r.json();
    const p = parseFloat(d.price);
    return (!isNaN(p) && p>0 && p<1) ? p : 0.5;
  } catch(e) { return 0.5; }
}

async function updateMarket() {
  const wts  = getWindowTs(0);
  const slug = `btc-updown-5m-${wts}`;
  if(currentMarket?.wts === wts) return;

  console.log('[MARKET] loading', slug);
  try {
    const market = await fetchMarketData(slug);
    if(!market) { console.log('[MARKET] not found yet'); return; }

    const ids        = JSON.parse(market.clobTokenIds || '[]');
    const yesTokenId = ids[0], noTokenId = ids[1];
    const endSec     = wts + 300;
    const startPrice = await fetchPriceToBeat(wts) || latestBTCPrice;

    // Resolve previous window before switching
    resolveLastDecision(wts);

    currentMarket = { slug, wts, yesTokenId, noTokenId, startPrice, endSec };
    console.log('[MARKET] loaded, startPrice:', startPrice);

    if(yesTokenId) {
      const yp   = await fetchInitialOdds(yesTokenId);
      latestOdds = { yes:yp, no:parseFloat((1-yp).toFixed(4)) };
    }

    broadcast({ type:'market', market:currentMarket, odds:latestOdds });
    connectClobWS();
  } catch(e) { console.error('[MARKET]',e.message); }
}

setInterval(updateMarket, 15000);
updateMarket();

// ── BROWSER WS ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('[WS] client connected, total:', clients.size);
  if(currentMarket)  ws.send(JSON.stringify({ type:'market', market:currentMarket, odds:latestOdds }));
  if(latestBTCPrice) ws.send(JSON.stringify({ type:'btc_price', price:latestBTCPrice }));
  if(lockedDecision && !lockedDecision.resolved) ws.send(JSON.stringify({ type:'decision', decision:lockedDecision }));
  ws.send(JSON.stringify({ type:'tracker', tracker:trackerData }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ── REST ──────────────────────────────────────────────────────────────────────
app.get('/state',   (req, res) => res.json({ market:currentMarket, odds:latestOdds, btcPrice:latestBTCPrice }));
app.get('/health',  (req, res) => res.json({ ok:true }));
app.get('/tracker', (req, res) => res.json(trackerData));
app.post('/tracker',(req, res) => {
  const { wins, losses, skips, history } = req.body;
  if(typeof wins==='number')    trackerData.wins    = wins;
  if(typeof losses==='number')  trackerData.losses  = losses;
  if(typeof skips==='number')   trackerData.skips   = skips;
  if(Array.isArray(history))    trackerData.history = history.slice(-50);
  res.json({ ok:true });
});

connectRTDS();
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`[SERVER] running on port ${PORT}`));
