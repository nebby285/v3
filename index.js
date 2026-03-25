import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server });
app.use(cors());
app.use(express.json());

let currentMarket  = null;
let latestOdds     = { yes: 0.5, no: 0.5 };
let latestBTCPrice = null;
let clients        = new Set();
let lockedDecision = null;
let trackerData    = { wins: 0, losses: 0, skips: 0, history: [] };

// Snapshot of Chainlink price taken at exact window boundary for accurate resolution
let windowClosePrice = null;
let windowCloseWts   = null;

const ADMIN_PASSWORD = '5656';
let paperData = { balance: 100, startBalance: 100, betSize: 10, trades: [], totalInvested: 0, totalReturned: 0 };

function getWindowTs(offset = 0) {
  const sec = Math.floor(Date.now() / 1000);
  return (sec - (sec % 300)) + offset * 300;
}
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

// Snapshot Chainlink price at exact window boundary (last 2s of each window)
setInterval(() => {
  if (!latestBTCPrice || !currentMarket) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const secsLeft = Math.max(0, currentMarket.endSec - nowSec);
  // Capture price in the last 2 seconds of the window
  if (secsLeft <= 2 && secsLeft >= 0) {
    windowClosePrice = latestBTCPrice;
    windowCloseWts   = currentMarket.wts;
    console.log(`[SNAPSHOT] captured close price $${windowClosePrice} at ${secsLeft}s left for window ${windowCloseWts}`);
  }
}, 500);

// ── PRICE TO BEAT ─────────────────────────────────────────────
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

// ── CANDLES ───────────────────────────────────────────────────
async function fetchCandles(limit = 30) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`, { signal: AbortSignal.timeout(5000) });
    return (await r.json()).map(c => ({
      ts: c[0]/1000, open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5])
    }));
  } catch(e) { return null; }
}

// ── MATH ──────────────────────────────────────────────────────
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

// ── SIGNAL WEIGHTS ────────────────────────────────────────────
const W = {
  windowDelta: 8.0, marketOddsDiv: 3.0, momentum1m: 2.5, trend3m: 2.0,
  trend5m: 1.5, acceleration: 1.5, emaCross: 1.0, rsiExtreme: 1.5,
  volatilityRegime: 1.5, fakeBreakout: 1.5, meanReversion: 1.0,
  volumeSurge: 1.0, timeInWindow: 1.0,
};

// ── SIGNALS ───────────────────────────────────────────────────
function signalWindowDelta(cp, sp) {
  if(!cp||!sp) return { bull:0, bear:0, note:'no data' };
  const d = ((cp-sp)/sp)*100;
  let bull=0, bear=0;
  if(d > 0.15) bull=1.0; else if(d > 0.05) bull=0.85; else if(d > 0.02) bull=0.65; else if(d > 0.005) bull=0.35;
  else if(d < -0.15) bear=1.0; else if(d < -0.05) bear=0.85; else if(d < -0.02) bear=0.65; else if(d < -0.005) bear=0.35;
  return { bull, bear, deltaPct: d.toFixed(4), note: d.toFixed(4)+'% vs PTB' };
}
function signalMarketOddsDivergence(modelBullProb, yesPrice, noPrice) {
  if(!yesPrice||!noPrice) return { bull:0, bear:0, note:'no odds' };
  const bullDiv = modelBullProb - yesPrice;
  const bearDiv = (1-modelBullProb) - noPrice;
  if(bullDiv > 0.12) return { bull:1.0, bear:0, note:`model +${(bullDiv*100).toFixed(0)}% vs market` };
  else if(bullDiv > 0.06) return { bull:0.6, bear:0, note:`model +${(bullDiv*100).toFixed(0)}% vs market` };
  else if(bearDiv > 0.12) return { bull:0, bear:1.0, note:`model +${(bearDiv*100).toFixed(0)}% bearish vs market` };
  else if(bearDiv > 0.06) return { bull:0, bear:0.6, note:`model +${(bearDiv*100).toFixed(0)}% bearish` };
  return { bull:0, bear:0, note:'no divergence' };
}
function signalMomentum1m(c) {
  if(c.length<3) return { bull:0, bear:0, note:'insufficient' };
  const m1=c[c.length-1].close-c[c.length-1].open, m2=c[c.length-2].close-c[c.length-2].open;
  if(m1>0&&m2>0) return { bull:1, bear:0, note:'2 bull candles' };
  if(m1<0&&m2<0) return { bull:0, bear:1, note:'2 bear candles' };
  if(m1>0) return { bull:0.5, bear:0, note:'last candle bullish' };
  if(m1<0) return { bull:0, bear:0.5, note:'last candle bearish' };
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
function signalVolatilityRegime(c, cp, sp) {
  if(c.length<8||!cp||!sp) return { bull:0, bear:0, confidence_mod:0, note:'insufficient' };
  const atrVal = atr(c, 5), avgClose = avg(c.slice(-10).map(x=>x.close));
  const atrPct = (atrVal/avgClose)*100, delta = ((cp-sp)/sp)*100;
  if(atrPct > 0.08) {
    if(delta > 0.08)  return { bull:0, bear:0.8, confidence_mod:-0.05, note:`high vol + extended UP → reversion` };
    if(delta < -0.08) return { bull:0.8, bear:0, confidence_mod:-0.05, note:`high vol + extended DOWN → reversion` };
    return { bull:0, bear:0, confidence_mod:-0.1, note:`high vol choppy` };
  }
  if(atrPct < 0.03) {
    if(delta > 0.005) return { bull:0.5, bear:0, confidence_mod:0.05, note:`low vol trend UP` };
    if(delta < -0.005) return { bull:0, bear:0.5, confidence_mod:0.05, note:`low vol trend DOWN` };
  }
  return { bull:0, bear:0, confidence_mod:0, note:`normal vol (${atrPct.toFixed(3)}%)` };
}
function signalFakeBreakout(c) {
  if(c.length<3) return { bull:0, bear:0, note:'insufficient' };
  const l=c[c.length-1], body=Math.abs(l.close-l.open), range=l.high-l.low;
  if(!range) return { bull:0, bear:0, note:'no range' };
  const uw=(l.high-Math.max(l.open,l.close))/range, lw=(Math.min(l.open,l.close)-l.low)/range;
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
  if(ratio<0.6) return { confidence_mod:-0.12, note:'vol dry' };
  return { confidence_mod:0, note:'vol normal' };
}
function signalTimeInWindow(secsLeft, total=300) {
  const elapsed = total - secsLeft;
  if(elapsed < 60)  return { confidence_mod:-0.25, shouldFire:false, note:`too early (${elapsed}s)` };
  if(elapsed >= 90 && elapsed <= 180) return { confidence_mod:0.15, shouldFire:true, note:`optimal (${elapsed}s)` };
  if(elapsed >= 60 && elapsed < 90)  return { confidence_mod:0.05, shouldFire:true, note:`early-mid (${elapsed}s)` };
  if(elapsed > 180 && elapsed <= 240) return { confidence_mod:0.05, shouldFire:true, note:`mid-late (${elapsed}s)` };
  if(elapsed > 240) return { confidence_mod:-0.15, shouldFire:true, note:`late window` };
  return { confidence_mod:0, shouldFire:true, note:`${elapsed}s elapsed` };
}
function measureChoppiness(c) {
  if(c.length<5) return { chopScore:0.5, note:'insufficient' };
  const s=c.slice(-5); let dc=0;
  for(let i=1;i<s.length;i++){const p=s[i-1].close-s[i-1].open,q=s[i].close-s[i].open;if((p>0&&q<0)||(p<0&&q>0))dc++;}
  return { chopScore:dc/4, note:dc+'/4 dir changes' };
}

function estimateTokenPrice(deltaPct, direction) {
  const absDelta = Math.abs(deltaPct);
  const correct = (direction === 'UP' && deltaPct > 0) || (direction === 'DOWN' && deltaPct < 0);
  if(!correct) {
    if(absDelta > 0.10) return 0.08;
    if(absDelta > 0.05) return 0.20;
    if(absDelta > 0.02) return 0.35;
    return 0.50;
  }
  if(absDelta < 0.005) return 0.50;
  if(absDelta < 0.02)  return 0.55;
  if(absDelta < 0.05)  return 0.65;
  if(absDelta < 0.10)  return 0.78;
  if(absDelta < 0.15)  return 0.88;
  return 0.94;
}
function calculateEV(winProb, tokenCost, fee=0.02) {
  return (winProb * 1.00) - tokenCost * (1 + fee);
}

// ── MAIN ENGINE ───────────────────────────────────────────────
async function runEngine() {
  if(!currentMarket || !latestBTCPrice || !currentMarket.startPrice) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const secsLeft = Math.max(0, currentMarket.endSec - nowSec);
  if(secsLeft <= 0) return;
  const elapsed = 300 - secsLeft;
  if(elapsed < 60) return;
  if(lockedDecision && lockedDecision.wts === currentMarket.wts && !lockedDecision.resolved) {
    broadcast({ type:'decision', decision:lockedDecision });
    return;
  }
  console.log(`[ENGINE] evaluating at T+${elapsed}s...`);
  const candles = await fetchCandles(30);
  if(!candles || candles.length < 5) { console.log('[ENGINE] no candles'); return; }
  const cp=latestBTCPrice, sp=currentMarket.startPrice, yp=latestOdds.yes, np=latestOdds.no;
  const s1=signalWindowDelta(cp,sp), s2=signalMomentum1m(candles), s3=signalTrend3m(candles);
  const s4=signalTrend5m(candles), s5=signalAcceleration(candles), s6=signalEMACross(candles);
  const s7=signalRSI(candles), s8=signalVolumeSurge(candles), s9=signalVolatilityRegime(candles,cp,sp);
  const s10=signalFakeBreakout(candles), s11=signalMeanReversion(candles,cp), s12=signalTimeInWindow(secsLeft);
  let bull=0, bear=0;
  bull+=s1.bull*W.windowDelta; bear+=s1.bear*W.windowDelta;
  bull+=s2.bull*W.momentum1m; bear+=s2.bear*W.momentum1m;
  bull+=s3.bull*W.trend3m; bear+=s3.bear*W.trend3m;
  bull+=s4.bull*W.trend5m; bear+=s4.bear*W.trend5m;
  bull+=s5.bull*W.acceleration; bear+=s5.bear*W.acceleration;
  bull+=s6.bull*W.emaCross; bear+=s6.bear*W.emaCross;
  bull+=s7.bull*W.rsiExtreme; bear+=s7.bear*W.rsiExtreme;
  bull+=s9.bull*W.volatilityRegime; bear+=s9.bear*W.volatilityRegime;
  bull+=s10.bull*W.fakeBreakout; bear+=s10.bear*W.fakeBreakout;
  bull+=s11.bull*W.meanReversion; bear+=s11.bear*W.meanReversion;
  const total=bull+bear, rawBullProb=total>0?bull/total:0.5;
  const s13=signalMarketOddsDivergence(rawBullProb, yp, np);
  bull+=s13.bull*W.marketOddsDiv; bear+=s13.bear*W.marketOddsDiv;
  const total2=bull+bear, edge=Math.abs(bull-bear), maxScore=Object.values(W).reduce((a,b)=>a+b,0);
  let conf=total2>0?edge/total2:0;
  conf+=(s8.confidence_mod||0)+(s9.confidence_mod||0)+(s12.confidence_mod||0);
  const chop=measureChoppiness(candles);
  conf-=chop.chopScore*0.2; conf=clamp(conf,0,1);
  const strength=total2/maxScore, quality=clamp((strength+conf)/2,0,1);
  const direction=bull>bear?'UP':'DOWN';
  const deltaPct=parseFloat(s1.deltaPct||'0');
  const tokenPrice=estimateTokenPrice(deltaPct, direction);
  const winProb=direction==='UP'?clamp(bull/(bull+bear+0.001),0.01,0.99):clamp(bear/(bull+bear+0.001),0.01,0.99);
  const ev=calculateEV(winProb, tokenPrice);
  const tokenPriceCents=Math.round(tokenPrice*100);
  const TOKEN_MIN=0.52, TOKEN_MAX=0.82, MIN_CONF=0.35, MIN_EDGE=1.5, MIN_EV=0.03;
  let decision='NO TRADE', reason='';
  if(!s12.shouldFire) { decision='NO TRADE'; reason=s12.note; }
  else if(conf<MIN_CONF) { decision='NO TRADE'; reason=`confidence too low (${(conf*100).toFixed(0)}%)`; }
  else if(quality<0.35) { decision='NO TRADE'; reason=`quality too low (${(quality*100).toFixed(0)}%)`; }
  else if(edge<MIN_EDGE) { decision='NO TRADE'; reason=`edge too small (${edge.toFixed(2)})`; }
  else if(tokenPrice<TOKEN_MIN) { decision='NO TRADE'; reason=`token too cheap ¢${tokenPriceCents}`; }
  else if(tokenPrice>TOKEN_MAX) { decision='NO TRADE'; reason=`token too expensive ¢${tokenPriceCents}`; }
  else if(ev<MIN_EV) { decision='NO TRADE'; reason=`negative EV (${(ev*100).toFixed(1)}%) at ¢${tokenPriceCents}`; }
  else if(bull>bear) { decision='BUY UP'; reason=`bull ${bull.toFixed(2)} vs bear ${bear.toFixed(2)} | EV +${(ev*100).toFixed(1)}% at ¢${tokenPriceCents}`; }
  else { decision='BUY DOWN'; reason=`bear ${bear.toFixed(2)} vs bull ${bull.toFixed(2)} | EV +${(ev*100).toFixed(1)}% at ¢${tokenPriceCents}`; }
  console.log(`[ENGINE] LOCKED: ${decision} | conf:${(conf*100).toFixed(0)}% edge:${edge.toFixed(2)} EV:${(ev*100).toFixed(1)}%`);
  lockedDecision = {
    wts:currentMarket.wts, decision, reason, bull, bear, conf, quality, edge, ev,
    tokenPrice, winProb, deltaPct, startPrice:sp, lockedAt:Date.now(),
    lockedAtElapsed:elapsed, resolved:false,
    signals:{s1,s2,s3,s4,s5,s6,s7,s8,s9,s10,s11,s12,s13,chop}
  };
  broadcast({ type:'decision', decision:lockedDecision });
  // Paper trade
  if(decision !== 'NO TRADE') {
    const betSize=paperData.betSize;
    if(paperData.balance>=betSize) {
      const isUp=decision==='BUY UP', tPrice=isUp?latestOdds.yes:latestOdds.no;
      if(tPrice&&tPrice>0) {
        const shares=betSize/tPrice, payout=parseFloat((shares*1.0).toFixed(2));
        paperData.balance-=betSize; paperData.totalInvested+=betSize;
        const trade={id:Date.now(),time:new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'America/New_York'}),wts:currentMarket.wts,decision,betSize,tokenPrice:parseFloat(tPrice.toFixed(4)),shares:parseFloat(shares.toFixed(4)),potentialPayout:payout,result:'PENDING',pnl:0};
        paperData.trades.unshift(trade);
        if(paperData.trades.length>50) paperData.trades.pop();
      }
    }
  }
  const time=new Date(currentMarket.wts*1000).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'America/New_York'});
  trackerData.history=trackerData.history.filter(h=>h.window!==currentMarket.wts);
  trackerData.history.push({time,decision,result:'PENDING',window:currentMarket.wts,ev:ev.toFixed(3)});
  if(trackerData.history.length>50) trackerData.history.shift();
  broadcast({ type:'tracker', tracker:trackerData });
}
setInterval(runEngine, 10000);

// ── RESOLVE ───────────────────────────────────────────────────
function resolveLastDecision(newWindowWts) {
  if(!lockedDecision||lockedDecision.resolved||lockedDecision.wts===newWindowWts) return;
  const {decision,startPrice}=lockedDecision;
  // Use the snapshotted close price if available, otherwise fall back to latestBTCPrice
  const finalPrice = (windowCloseWts === lockedDecision.wts && windowClosePrice) 
    ? windowClosePrice 
    : latestBTCPrice;
  console.log(`[RESOLVE] using ${windowCloseWts === lockedDecision.wts ? 'SNAPSHOT' : 'LIVE'} price $${finalPrice} (start $${startPrice})`);
  let result='SKIP';
  if(decision!=='NO TRADE'&&finalPrice&&startPrice) {
    const won=(decision==='BUY UP'&&finalPrice>=startPrice)||(decision==='BUY DOWN'&&finalPrice<startPrice);
    result=won?'WIN':'LOSS';
    if(won) trackerData.wins++; else trackerData.losses++;
    // Resolve paper trade
    const trade=paperData.trades.find(t=>t.wts===lockedDecision.wts&&t.result==='PENDING');
    if(trade) {
      if(won){trade.result='WIN';trade.pnl=parseFloat((trade.potentialPayout-trade.betSize).toFixed(2));paperData.balance+=trade.potentialPayout;paperData.totalReturned+=trade.potentialPayout;}
      else{trade.result='LOSS';trade.pnl=-trade.betSize;}
    }
  } else if(decision==='NO TRADE') { trackerData.skips++; }
  const idx=trackerData.history.findIndex(h=>h.window===lockedDecision.wts);
  if(idx>=0) trackerData.history[idx].result=result;
  lockedDecision.resolved=true;
  console.log(`[TRACKER] ${decision} → ${result} W:${trackerData.wins} L:${trackerData.losses}`);
  broadcast({ type:'tracker', tracker:trackerData });
}

// ── CLOB WS ───────────────────────────────────────────────────
let clobWS=null;
function connectClobWS() {
  if(clobWS){try{clobWS.terminate();}catch(e){}}
  if(!currentMarket?.yesTokenId) return;
  clobWS=new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
  clobWS.on('open',()=>{
    clobWS.send(JSON.stringify({auth:{},markets:[],assets_ids:[currentMarket.yesTokenId,currentMarket.noTokenId]}));
    clobWS._ping=setInterval(()=>{if(clobWS.readyState===WebSocket.OPEN)clobWS.ping();},5000);
  });
  clobWS.on('message',(raw)=>{
    try{
      const arr=[].concat(JSON.parse(raw.toString()));
      for(const ev of arr){
        if(ev.event_type!=='price_change'&&ev.event_type!=='last_trade_price') continue;
        const price=parseFloat(ev.price??ev.last_trade_price);
        if(isNaN(price)||price<=0||price>=1) continue;
        const isYes=ev.asset_id===currentMarket.yesTokenId;
        if(isYes){latestOdds.yes=price;latestOdds.no=parseFloat((1-price).toFixed(4));}
        else{latestOdds.no=price;latestOdds.yes=parseFloat((1-price).toFixed(4));}
        broadcast({type:'odds',yes:latestOdds.yes,no:latestOdds.no});
      }
    }catch(e){}
  });
  clobWS.on('close',()=>{clearInterval(clobWS._ping);setTimeout(connectClobWS,3000);});
  clobWS.on('error',(e)=>console.error('[CLOB]',e.message));
}

// ── RTDS WS ───────────────────────────────────────────────────
let rtdsWS=null;
function connectRTDS() {
  if(rtdsWS){try{rtdsWS.terminate();}catch(e){}}
  rtdsWS=new WebSocket('wss://ws-live-data.polymarket.com');
  rtdsWS.on('open',()=>{
    rtdsWS.send(JSON.stringify({action:'subscribe',subscriptions:[{topic:'crypto_prices_chainlink',type:'*',filters:'{"symbol":"btc/usd"}'}]}));
    rtdsWS._ping=setInterval(()=>{if(rtdsWS.readyState===WebSocket.OPEN)rtdsWS.send(JSON.stringify({action:'PING'}));},5000);
  });
  rtdsWS.on('message',(raw)=>{
    try{
      const msg=JSON.parse(raw.toString());
      if(msg.topic==='crypto_prices_chainlink'&&msg.payload?.value){
        latestBTCPrice=parseFloat(msg.payload.value);
        broadcast({type:'btc_price',price:latestBTCPrice});
      }
    }catch(e){}
  });
  rtdsWS.on('close',()=>{clearInterval(rtdsWS._ping);setTimeout(connectRTDS,3000);});
  rtdsWS.on('error',(e)=>console.error('[RTDS]',e.message));
}

// ── MARKET LOOP ───────────────────────────────────────────────
async function fetchMarketData(slug) {
  const r=await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`,{headers:{'User-Agent':'Mozilla/5.0'}});
  const d=await r.json();
  return Array.isArray(d)&&d.length?d[0]:null;
}
async function fetchInitialOdds(tokenId) {
  try{
    const r=await fetch(`https://clob.polymarket.com/price?token_id=${tokenId}&side=BUY`,{headers:{'User-Agent':'Mozilla/5.0'}});
    const d=await r.json(); const p=parseFloat(d.price);
    return(!isNaN(p)&&p>0&&p<1)?p:0.5;
  }catch(e){return 0.5;}
}
async function updateMarket() {
  const wts=getWindowTs(0), slug=`btc-updown-5m-${wts}`;
  if(currentMarket?.wts===wts) return;
  console.log('[MARKET] loading',slug);
  try{
    const market=await fetchMarketData(slug);
    if(!market){console.log('[MARKET] not found yet');return;}
    const ids=JSON.parse(market.clobTokenIds||'[]');
    const yesTokenId=ids[0], noTokenId=ids[1], endSec=wts+300;
    const startPrice=await fetchPriceToBeat(wts)||latestBTCPrice;
    resolveLastDecision(wts);
    currentMarket={slug,wts,yesTokenId,noTokenId,startPrice,endSec};
    console.log('[MARKET] loaded, startPrice:',startPrice);
    if(yesTokenId){const yp=await fetchInitialOdds(yesTokenId);latestOdds={yes:yp,no:parseFloat((1-yp).toFixed(4))};}
    broadcast({type:'market',market:currentMarket,odds:latestOdds});
    connectClobWS();
  }catch(e){console.error('[MARKET]',e.message);}
}
setInterval(updateMarket,15000);
updateMarket();

// ── BROWSER WS ────────────────────────────────────────────────
wss.on('connection',(ws)=>{
  clients.add(ws);
  console.log('[WS] client connected, total:',clients.size);
  if(currentMarket) ws.send(JSON.stringify({type:'market',market:currentMarket,odds:latestOdds}));
  if(latestBTCPrice) ws.send(JSON.stringify({type:'btc_price',price:latestBTCPrice}));
  if(lockedDecision&&!lockedDecision.resolved) ws.send(JSON.stringify({type:'decision',decision:lockedDecision}));
  ws.send(JSON.stringify({type:'tracker',tracker:trackerData}));
  ws.on('close',()=>clients.delete(ws));
  ws.on('error',()=>clients.delete(ws));
});

// ── REST ──────────────────────────────────────────────────────
app.get('/health',(req,res)=>res.json({ok:true,market:currentMarket?.slug,btc:latestBTCPrice}));
app.get('/tracker',(req,res)=>res.json(trackerData));
app.post('/tracker',(req,res)=>{
  const{wins,losses,skips,history}=req.body;
  if(typeof wins==='number') trackerData.wins=wins;
  if(typeof losses==='number') trackerData.losses=losses;
  if(typeof skips==='number') trackerData.skips=skips;
  if(Array.isArray(history)) trackerData.history=history.slice(-50);
  res.json({ok:true});
});
app.post('/admin/login',(req,res)=>{
  const{password}=req.body;
  if(password===ADMIN_PASSWORD) res.json({ok:true,token:Buffer.from(ADMIN_PASSWORD).toString('base64')});
  else res.status(401).json({ok:false});
});
function adminAuth(req,res,next){
  const token=req.headers['x-admin-token'];
  if(token===Buffer.from(ADMIN_PASSWORD).toString('base64')) return next();
  res.status(401).json({ok:false});
}
app.get('/admin/stats',adminAuth,(req,res)=>{
  const w=trackerData.wins,l=trackerData.losses,t=w+l;
  const roi=((paperData.balance-paperData.startBalance)/paperData.startBalance*100).toFixed(2);
  res.json({liveUsers:clients.size,signal:{wins:w,losses:l,skips:trackerData.skips,winRate:t>0?Math.round(w/t*100):0},market:currentMarket?{slug:currentMarket.slug,startPrice:currentMarket.startPrice,endSec:currentMarket.endSec,wts:currentMarket.wts}:null,btcPrice:latestBTCPrice,odds:latestOdds,decision:lockedDecision,paper:{...paperData,roi:parseFloat(roi)}});
});
app.post('/admin/paper/reset',adminAuth,(req,res)=>{
  const{startBalance,betSize}=req.body;
  paperData={balance:startBalance||100,startBalance:startBalance||100,betSize:betSize||10,trades:[],totalInvested:0,totalReturned:0};
  res.json({ok:true});
});
app.post('/admin/paper/betsize',adminAuth,(req,res)=>{
  paperData.betSize=Math.max(1,Math.min(paperData.balance,req.body.betSize||10));
  res.json({ok:true,betSize:paperData.betSize});
});

connectRTDS();
const PORT=process.env.PORT||3001;
server.listen(PORT,()=>console.log(`[SERVER] port ${PORT}`));
