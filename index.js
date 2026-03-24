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

function getWindowTs(offset = 0) {
  const sec = Math.floor(Date.now() / 1000);
  return (sec - (sec % 300)) + offset * 300;
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}

// ── CANDLES ───────────────────────────────────────────────────────────────────
async function fetchCandles(limit = 30) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`, { signal: AbortSignal.timeout(6000) });
    return (await r.json()).map(c => ({
      ts: c[0]/1000, open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5])
    }));
  } catch(e) {
    console.error('[CANDLES]', e.message);
    return null;
  }
}

// ── PRICE TO BEAT ─────────────────────────────────────────────────────────────
async function fetchPriceToBeat(windowTs) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${windowTs*1000}&endTime=${(windowTs+180)*1000}&limit=3`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
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

// ── MATH ──────────────────────────────────────────────────────────────────────
function ema(v, p) { const k=2/(p+1); let e=v[0]; for(let i=1;i<v.length;i++) e=v[i]*k+e*(1-k); return e; }
function rsi(c, p=14) { if(c.length<p+1) return 50; let g=0,l=0; for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];d>0?g+=d:l-=d;} const ag=g/p,al=l/p; if(!al) return 100; return 100-(100/(1+ag/al)); }
function avg(a) { return a.reduce((x,y)=>x+y,0)/a.length; }
function clamp(v,mn,mx) { return Math.max(mn,Math.min(mx,v)); }

// ── SIGNALS ───────────────────────────────────────────────────────────────────
function sigWindowDelta(cp, sp) {
  if(!cp||!sp) return {bull:0,bear:0,note:'no data'};
  const d=((cp-sp)/sp)*100;
  let bull=0,bear=0;
  if(d>0.10)bull=1;else if(d>0.05)bull=0.8;else if(d>0.02)bull=0.6;else if(d>0.005)bull=0.3;
  else if(d<-0.10)bear=1;else if(d<-0.05)bear=0.8;else if(d<-0.02)bear=0.6;else if(d<-0.005)bear=0.3;
  return {bull,bear,deltaPct:d.toFixed(4),note:d.toFixed(4)+'% vs PTB'};
}
function sigMomentum(c) {
  if(c.length<3) return {bull:0,bear:0,note:'insufficient'};
  const m1=c[c.length-1].close-c[c.length-1].open, m2=c[c.length-2].close-c[c.length-2].open;
  if(m1>0&&m2>0) return {bull:1,bear:0,note:'2 bull candles'};
  if(m1<0&&m2<0) return {bull:0,bear:1,note:'2 bear candles'};
  if(m1>0) return {bull:0.5,bear:0,note:'last bullish'};
  if(m1<0) return {bull:0,bear:0.5,note:'last bearish'};
  return {bull:0,bear:0,note:'flat'};
}
function sigTrend3(c) {
  if(c.length<4) return {bull:0,bear:0,note:'insufficient'};
  const s=c.slice(-3),bc=s.filter(x=>x.close>x.open).length,rc=s.filter(x=>x.close<x.open).length;
  if(bc===3) return {bull:1,bear:0,note:'3/3 bull'};
  if(rc===3) return {bull:0,bear:1,note:'3/3 bear'};
  if(bc===2) return {bull:0.5,bear:0,note:'2/3 bull'};
  if(rc===2) return {bull:0,bear:0.5,note:'2/3 bear'};
  return {bull:0,bear:0,note:'mixed'};
}
function sigTrend5(c) {
  if(c.length<6) return {bull:0,bear:0,note:'insufficient'};
  const m=c[c.length-1].close-c[c.length-5].open, p=(m/c[c.length-5].open)*100;
  if(p>0.08) return {bull:1,bear:0,note:'5m +'+p.toFixed(3)+'%'};
  if(p>0.02) return {bull:0.6,bear:0,note:'5m +'+p.toFixed(3)+'%'};
  if(p<-0.08) return {bull:0,bear:1,note:'5m '+p.toFixed(3)+'%'};
  if(p<-0.02) return {bull:0,bear:0.6,note:'5m '+p.toFixed(3)+'%'};
  return {bull:0,bear:0,note:'5m flat'};
}
function sigEMA(c) {
  if(c.length<22) return {bull:0,bear:0,note:'insufficient'};
  const cl=c.map(x=>x.close), e9=ema(cl.slice(-9),9), e21=ema(cl.slice(-21),21), g=((e9-e21)/e21)*100;
  if(g>0.02) return {bull:1,bear:0,note:'EMA9>EMA21 +'+g.toFixed(3)+'%'};
  if(g<-0.02) return {bull:0,bear:1,note:'EMA9<EMA21 '+g.toFixed(3)+'%'};
  return {bull:0,bear:0,note:'EMA flat'};
}
function sigRSI(c) {
  if(c.length<16) return {bull:0,bear:0,note:'insufficient'};
  const r=rsi(c.map(x=>x.close),14);
  if(r<25) return {bull:1,bear:0,note:'RSI oversold '+r.toFixed(0)};
  if(r<35) return {bull:0.5,bear:0,note:'RSI low '+r.toFixed(0)};
  if(r>75) return {bull:0,bear:1,note:'RSI overbought '+r.toFixed(0)};
  if(r>65) return {bull:0,bear:0.5,note:'RSI high '+r.toFixed(0)};
  return {bull:0,bear:0,note:'RSI '+r.toFixed(0)};
}
function sigVolume(c) {
  if(c.length<7) return {mod:0,note:'insufficient'};
  const ra=avg(c.slice(-3).map(x=>x.volume)), pa=avg(c.slice(-6,-3).map(x=>x.volume)), ratio=ra/pa;
  if(ratio>1.5) return {mod:0.12,note:'vol surge '+ratio.toFixed(2)+'x'};
  if(ratio>1.2) return {mod:0.06,note:'vol elevated'};
  if(ratio<0.6) return {mod:-0.1,note:'vol dry'};
  return {mod:0,note:'vol normal'};
}
function sigMarketOdds(yp, np) {
  if(!yp||!np) return {bull:0,bear:0,note:'no odds'};
  if(yp>0.70) return {bull:1,bear:0,note:'YES bid '+Math.round(yp*100)+'¢'};
  if(yp>0.55) return {bull:0.6,bear:0,note:'YES lean '+Math.round(yp*100)+'¢'};
  if(np>0.70) return {bull:0,bear:1,note:'NO bid '+Math.round(np*100)+'¢'};
  if(np>0.55) return {bull:0,bear:0.6,note:'NO lean '+Math.round(np*100)+'¢'};
  return {bull:0,bear:0,note:'market even'};
}
function sigWick(c) {
  if(c.length<2) return {bull:0,bear:0,note:'insufficient'};
  const l=c[c.length-1], body=Math.abs(l.close-l.open), range=l.high-l.low;
  if(!range) return {bull:0,bear:0,note:'no range'};
  const uw=(l.high-Math.max(l.open,l.close))/range, lw=(Math.min(l.open,l.close)-l.low)/range;
  if(uw>0.5&&body/range<0.3) return {bull:0,bear:1,note:'bear wick '+Math.round(uw*100)+'%'};
  if(lw>0.5&&body/range<0.3) return {bull:1,bear:0,note:'bull wick '+Math.round(lw*100)+'%'};
  return {bull:0,bear:0,note:'normal candle'};
}
function sigMeanRev(c, cp) {
  if(c.length<10||!cp) return {bull:0,bear:0,note:'insufficient'};
  const m=avg(c.slice(-10).map(x=>x.close)), d=((cp-m)/m)*100;
  if(d>0.15) return {bull:0,bear:0.8,note:'+'+d.toFixed(3)+'% above mean'};
  if(d<-0.15) return {bull:0.8,bear:0,note:d.toFixed(3)+'% below mean'};
  return {bull:0,bear:0,note:'near mean'};
}

const W = { windowDelta:8, momentum:2.5, trend3:2, trend5:1.5, ema:1, rsi:1.5, odds:2, wick:1.5, meanRev:1 };

// ── ENGINE ────────────────────────────────────────────────────────────────────
async function runEngine() {
  if(!currentMarket || !latestBTCPrice || !currentMarket.startPrice) {
    console.log('[ENGINE] waiting for data — market:', !!currentMarket, 'btc:', !!latestBTCPrice, 'sp:', currentMarket?.startPrice);
    return;
  }

  const nowSec   = Math.floor(Date.now() / 1000);
  const secsLeft = Math.max(0, currentMarket.endSec - nowSec);
  const elapsed  = 300 - secsLeft;

  // Already have a locked decision for this window — just re-broadcast it
  if(lockedDecision && lockedDecision.wts === currentMarket.wts && !lockedDecision.resolved) {
    broadcast({ type:'decision', decision:lockedDecision });
    return;
  }

  if(secsLeft <= 0) { console.log('[ENGINE] window over'); return; }

  console.log(`[ENGINE] firing at T+${elapsed}s`);

  const candles = await fetchCandles(30);
  if(!candles || candles.length < 5) { console.log('[ENGINE] candle fetch failed'); return; }

  const cp=latestBTCPrice, sp=currentMarket.startPrice, yp=latestOdds.yes, np=latestOdds.no;

  const s1=sigWindowDelta(cp,sp);
  const s2=sigMomentum(candles);
  const s3=sigTrend3(candles);
  const s4=sigTrend5(candles);
  const s5=sigEMA(candles);
  const s6=sigRSI(candles);
  const s7=sigVolume(candles);
  const s8=sigMarketOdds(yp,np);
  const s9=sigWick(candles);
  const s10=sigMeanRev(candles,cp);

  let bull=0, bear=0;
  bull+=s1.bull*W.windowDelta; bear+=s1.bear*W.windowDelta;
  bull+=s2.bull*W.momentum;    bear+=s2.bear*W.momentum;
  bull+=s3.bull*W.trend3;      bear+=s3.bear*W.trend3;
  bull+=s4.bull*W.trend5;      bear+=s4.bear*W.trend5;
  bull+=s5.bull*W.ema;         bear+=s5.bear*W.ema;
  bull+=s6.bull*W.rsi;         bear+=s6.bear*W.rsi;
  bull+=s8.bull*W.odds;        bear+=s8.bear*W.odds;
  bull+=s9.bull*W.wick;        bear+=s9.bear*W.wick;
  bull+=s10.bull*W.meanRev;    bear+=s10.bear*W.meanRev;

  const total=bull+bear, edge=Math.abs(bull-bear);
  const maxS=Object.values(W).reduce((a,b)=>a+b,0);
  let conf=total>0?edge/total:0;
  conf+=(s7.mod||0);

  // choppiness
  let dc=0; const sl5=candles.slice(-5);
  for(let i=1;i<sl5.length;i++){const p=sl5[i-1].close-sl5[i-1].open,q=sl5[i].close-sl5[i].open;if((p>0&&q<0)||(p<0&&q>0))dc++;}
  conf-=(dc/4)*0.15;
  conf=clamp(conf,0,1);

  const strength=total/maxS, quality=clamp((strength+conf)/2,0,1);

  // Timing confidence bonus
  let timingNote='';
  if(elapsed>=90&&elapsed<=180){conf=clamp(conf+0.1,0,1);timingNote='optimal timing';}
  else if(elapsed<60){timingNote='early window';}
  else{timingNote=elapsed+'s elapsed';}

  // Token price estimate based on delta
  const deltaPct=parseFloat(s1.deltaPct||'0');
  const absDelta=Math.abs(deltaPct);
  const correctDir=(bull>bear&&deltaPct>0)||(bear>bull&&deltaPct<0);
  let tokenPrice=0.50;
  if(correctDir){
    if(absDelta<0.005)tokenPrice=0.50;
    else if(absDelta<0.02)tokenPrice=0.55;
    else if(absDelta<0.05)tokenPrice=0.65;
    else if(absDelta<0.10)tokenPrice=0.78;
    else tokenPrice=0.88;
  } else {
    if(absDelta<0.02)tokenPrice=0.50;
    else if(absDelta<0.05)tokenPrice=0.35;
    else tokenPrice=0.20;
  }

  const winProb=total>0?(bull>bear?bull/total:bear/total):0.5;
  const ev=winProb*1.00-tokenPrice*1.02;

  let decision='NO TRADE', reason='';
  if(conf<0.30){decision='NO TRADE';reason='confidence too low ('+Math.round(conf*100)+'%)';}
  else if(edge<1.2){decision='NO TRADE';reason='edge too small ('+edge.toFixed(2)+')';}
  else if(tokenPrice>0.85){decision='NO TRADE';reason='token overpriced ¢'+Math.round(tokenPrice*100)+' — no value';}
  else if(ev<0.01){decision='NO TRADE';reason='negative EV ('+( ev*100).toFixed(1)+'%)';}
  else if(bull>bear){decision='BUY UP';reason='bull '+bull.toFixed(1)+' vs bear '+bear.toFixed(1)+' | EV +'+(ev*100).toFixed(1)+'% | '+timingNote;}
  else{decision='BUY DOWN';reason='bear '+bear.toFixed(1)+' vs bull '+bull.toFixed(1)+' | EV +'+(ev*100).toFixed(1)+'% | '+timingNote;}

  console.log(`[ENGINE] DECISION: ${decision} | conf:${Math.round(conf*100)}% edge:${edge.toFixed(2)} EV:${(ev*100).toFixed(1)}%`);

  lockedDecision = {
    wts: currentMarket.wts, decision, reason,
    bull, bear, conf, quality, edge, ev, tokenPrice, winProb, deltaPct,
    startPrice: sp, lockedAt: Date.now(), lockedAtElapsed: elapsed, resolved: false,
    signals: { s1,s2,s3,s4,s5,s6,s7,s8,s9,s10, timing:{note:timingNote} }
  };

  broadcast({ type:'decision', decision:lockedDecision });

  // Add PENDING to tracker
  const time=new Date(currentMarket.wts*1000).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'America/New_York'});
  trackerData.history=trackerData.history.filter(h=>h.window!==currentMarket.wts);
  trackerData.history.push({time,decision,result:'PENDING',window:currentMarket.wts,ev:ev.toFixed(3)});
  if(trackerData.history.length>50) trackerData.history.shift();
  broadcast({ type:'tracker', tracker:trackerData });
}

// ── RESOLVE ───────────────────────────────────────────────────────────────────
function resolveLastDecision(newWts) {
  if(!lockedDecision||lockedDecision.resolved||lockedDecision.wts===newWts) return;
  const {decision,startPrice}=lockedDecision;
  let result='SKIP';
  if(decision!=='NO TRADE'&&latestBTCPrice&&startPrice){
    const won=(decision==='BUY UP'&&latestBTCPrice>=startPrice)||(decision==='BUY DOWN'&&latestBTCPrice<startPrice);
    result=won?'WIN':'LOSS';
    if(won)trackerData.wins++;else trackerData.losses++;
  } else if(decision==='NO TRADE'){trackerData.skips++;result='SKIP';}
  const idx=trackerData.history.findIndex(h=>h.window===lockedDecision.wts);
  if(idx>=0)trackerData.history[idx].result=result;
  lockedDecision.resolved=true;
  console.log(`[TRACKER] ${decision} → ${result} W:${trackerData.wins} L:${trackerData.losses}`);
  broadcast({type:'tracker',tracker:trackerData});
}

// Run engine every 15s
setInterval(runEngine, 15000);

// ── CLOB WS ───────────────────────────────────────────────────────────────────
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

// ── RTDS WS ───────────────────────────────────────────────────────────────────
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

// ── MARKET ────────────────────────────────────────────────────────────────────
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
    const yesTokenId=ids[0], noTokenId=ids[1];
    const endSec=wts+300;
    resolveLastDecision(wts);
    const startPrice=await fetchPriceToBeat(wts)||latestBTCPrice;
    currentMarket={slug,wts,yesTokenId,noTokenId,startPrice,endSec};
    console.log('[MARKET] loaded startPrice:',startPrice,'endSec:',endSec);
    if(yesTokenId){const yp=await fetchInitialOdds(yesTokenId);latestOdds={yes:yp,no:parseFloat((1-yp).toFixed(4))};}
    broadcast({type:'market',market:currentMarket,odds:latestOdds});
    connectClobWS();
    // Fire engine immediately after new market loads
    setTimeout(runEngine, 3000);
  }catch(e){console.error('[MARKET]',e.message);}
}
setInterval(updateMarket,15000);
updateMarket();

// ── BROWSER WS ────────────────────────────────────────────────────────────────
wss.on('connection',(ws)=>{
  clients.add(ws);
  console.log('[WS] client connected, total:',clients.size);
  if(currentMarket)  ws.send(JSON.stringify({type:'market',market:currentMarket,odds:latestOdds}));
  if(latestBTCPrice) ws.send(JSON.stringify({type:'btc_price',price:latestBTCPrice}));
  if(lockedDecision&&!lockedDecision.resolved) ws.send(JSON.stringify({type:'decision',decision:lockedDecision}));
  ws.send(JSON.stringify({type:'tracker',tracker:trackerData}));
  ws.on('close',()=>clients.delete(ws));
  ws.on('error',()=>clients.delete(ws));
});

// ── REST ──────────────────────────────────────────────────────────────────────
app.get('/candles', async (req,res)=>{
  try{
    const r=await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=30',{signal:AbortSignal.timeout(6000)});
    const d=await r.json();
    res.json(d);
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/health',(req,res)=>res.json({ok:true,market:currentMarket?.slug,btc:latestBTCPrice,locked:lockedDecision?.decision||null}));
app.get('/tracker',(req,res)=>res.json(trackerData));
app.post('/tracker',(req,res)=>{
  const{wins,losses,skips,history}=req.body;
  if(typeof wins==='number')trackerData.wins=wins;
  if(typeof losses==='number')trackerData.losses=losses;
  if(typeof skips==='number')trackerData.skips=skips;
  if(Array.isArray(history))trackerData.history=history.slice(-50);
  res.json({ok:true});
});

connectRTDS();
const PORT=process.env.PORT||3001;
server.listen(PORT,()=>console.log(`[SERVER] port ${PORT}`));
