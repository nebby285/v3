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
let trackerData    = { wins: 0, losses: 0, skips: 0, history: [] };

// Rolling 90s buffer of Chainlink prices — lets us look up exact price at any past timestamp
const chainlinkBuffer=[];
function getChainlinkAtTime(targetMs){
  if(!chainlinkBuffer.length) return latestBTCPrice;
  let best=chainlinkBuffer[0];
  for(const e of chainlinkBuffer) if(Math.abs(e.ts-targetMs)<Math.abs(best.ts-targetMs)) best=e;
  console.log('[BUFFER] looked up',new Date(targetMs).toISOString(),'→ found',best.price,'at',new Date(best.ts).toISOString(),'(diff',Math.abs(best.ts-targetMs),'ms)');
  return best.price;
}

// Snapshot Chainlink price at exact window boundary
let windowPriceSnapshot = null;
let lastSnapWts = 0;
setInterval(()=>{
  const sec = Math.floor(Date.now()/1000);
  const wts = sec - (sec % 300);
  if(wts !== lastSnapWts && latestBTCPrice){
    windowPriceSnapshot = latestBTCPrice;
    lastSnapWts = wts;
    console.log('[SNAPSHOT] wts:',wts,'ptb:',windowPriceSnapshot);
  }
},500);

function getWindowTs(){ const s=Math.floor(Date.now()/1000); return s-(s%300); }
function broadcast(msg){ const s=JSON.stringify(msg); for(const c of clients) if(c.readyState===WebSocket.OPEN) c.send(s); }

async function fetchPriceToBeat(wts){
  try{
    const r=await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${wts*1000}&limit=1`,{signal:AbortSignal.timeout(5000)});
    const d=await r.json();
    if(Array.isArray(d)&&d.length) return parseFloat(d[0][1]);
  }catch(e){}
  return null;
}

// CLOB WebSocket
let clobWS=null;
function connectClobWS(){
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

// Rolling buffer of last 60 seconds of Chainlink prices with timestamps
// So we can look back and find the exact price at any window boundary
const chainlinkBuffer = []; // [{ts, price}]

// RTDS WebSocket (Chainlink BTC price)
let rtdsWS=null;
function connectRTDS(){
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
        // Store in buffer with timestamp for exact historical lookup
        const now=Date.now();
        chainlinkBuffer.push({ts:now,price:latestBTCPrice});
        if(chainlinkBuffer.length>180) chainlinkBuffer.shift(); // keep ~90s at 2/sec
        // Add to buffer with current timestamp
        const now=Date.now();
        chainlinkBuffer.push({ts:now, price:latestBTCPrice});
        // Keep only last 90 seconds
        const cutoff=now-90000;
        while(chainlinkBuffer.length&&chainlinkBuffer[0].ts<cutoff) chainlinkBuffer.shift();
        broadcast({type:'btc_price',price:latestBTCPrice});
      }
    }catch(e){}
  });
  rtdsWS.on('close',()=>{clearInterval(rtdsWS._ping);setTimeout(connectRTDS,3000);});
  rtdsWS.on('error',(e)=>console.error('[RTDS]',e.message));
}

// Get the Chainlink price closest to a given unix timestamp
function getChainlinkAtTime(targetMs) {
  if(!chainlinkBuffer.length) return latestBTCPrice;
  let best = chainlinkBuffer[0];
  for(const entry of chainlinkBuffer) {
    if(Math.abs(entry.ts - targetMs) < Math.abs(best.ts - targetMs)) best = entry;
  }
  return best.price;
}

// Market loop
async function fetchMarketData(slug){
  const r=await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`,{headers:{'User-Agent':'Mozilla/5.0'}});
  const d=await r.json();
  return Array.isArray(d)&&d.length?d[0]:null;
}
async function fetchInitialOdds(tokenId){
  try{
    const r=await fetch(`https://clob.polymarket.com/price?token_id=${tokenId}&side=BUY`,{headers:{'User-Agent':'Mozilla/5.0'}});
    const d=await r.json(); const p=parseFloat(d.price);
    return(!isNaN(p)&&p>0&&p<1)?p:0.5;
  }catch(e){return 0.5;}
}
async function updateMarket(){
  const wts=getWindowTs(), slug=`btc-updown-5m-${wts}`;
  if(currentMarket?.wts===wts) return;
  console.log('[MARKET] loading',slug);
  try{
    const market=await fetchMarketData(slug);
    if(!market){console.log('[MARKET] not found yet');return;}
    const ids=JSON.parse(market.clobTokenIds||'[]');
    const yesTokenId=ids[0],noTokenId=ids[1],endSec=wts+300;
    // Resolve previous window decision
    if(lockedDecision&&!lockedDecision.resolved&&lockedDecision.wts!==wts){
      const won=lockedDecision.decision==='BUY UP'?latestBTCPrice>=lockedDecision.startPrice:lockedDecision.decision==='BUY DOWN'?latestBTCPrice<lockedDecision.startPrice:null;
      if(won===null){trackerData.skips++;}else if(won){trackerData.wins++;}else{trackerData.losses++;}
      const result=won===null?'SKIP':won?'WIN':'LOSS';
      const idx=trackerData.history.findIndex(h=>h.window===lockedDecision.wts);
      if(idx>=0)trackerData.history[idx].result=result;
      lockedDecision.resolved=true;
      console.log('[TRACKER]',lockedDecision.decision,'→',result,'W:'+trackerData.wins,'L:'+trackerData.losses);
      broadcast({type:'tracker',tracker:trackerData});
    }
    lockedDecision=null; // clear for new window
    // Use snapshot taken at window boundary, fall back to current price
    const startPrice=getChainlinkAtTime(wts*1000)||windowPriceSnapshot||latestBTCPrice||await fetchPriceToBeat(wts);
    currentMarket={slug,wts,yesTokenId,noTokenId,startPrice,endSec};
    console.log('[MARKET] startPrice:',startPrice);
    if(yesTokenId){const yp=await fetchInitialOdds(yesTokenId);latestOdds={yes:yp,no:parseFloat((1-yp).toFixed(4))};}
    broadcast({type:'market',market:currentMarket,odds:latestOdds});
    connectClobWS();
    // Run engine after market loads
    setTimeout(runEngine, 2000);
  }catch(e){console.error('[MARKET]',e.message);}
}
setInterval(updateMarket,15000);
updateMarket();

// ── ENGINE (server-side, one decision per window, same for all devices) ────────
let lockedDecision = null;

function runEngine(){
  if(!currentMarket||!latestBTCPrice||!currentMarket.startPrice) return;
  const secsLeft=Math.max(0,currentMarket.endSec-Math.floor(Date.now()/1000));
  if(secsLeft<=0) return;
  // Already locked for this window — re-broadcast to any new clients
  if(lockedDecision&&lockedDecision.wts===currentMarket.wts&&!lockedDecision.resolved){
    broadcast({type:'decision',decision:lockedDecision});
    return;
  }
  const cp=latestBTCPrice,sp=currentMarket.startPrice,yp=latestOdds.yes,np=latestOdds.no;
  const elapsed=300-secsLeft,delta=((cp-sp)/sp)*100;
  let bull=0,bear=0;
  if(delta>0.10)bull+=8;else if(delta>0.05)bull+=6.4;else if(delta>0.02)bull+=4.8;else if(delta>0.005)bull+=2.4;
  else if(delta<-0.10)bear+=8;else if(delta<-0.05)bear+=6.4;else if(delta<-0.02)bear+=4.8;else if(delta<-0.005)bear+=2.4;
  if(yp>0.70)bull+=2;else if(yp>0.55)bull+=1.2;else if(np>0.70)bear+=2;else if(np>0.55)bear+=1.2;
  if(elapsed>=90&&elapsed<=180){if(bull>bear)bull+=0.5;else bear+=0.5;}
  const total=bull+bear,edge=Math.abs(bull-bear);
  const conf=Math.max(0,Math.min(1,total>0?edge/total:0));
  const quality=Math.max(0,Math.min(1,conf*0.8+(Math.min(elapsed,180)/180)*0.2));
  let decision='NO TRADE',reason='';
  if(conf<0.25){decision='NO TRADE';reason='confidence too low ('+Math.round(conf*100)+'%)';}
  else if(edge<0.8){decision='NO TRADE';reason='edge too small ('+edge.toFixed(1)+')';}
  else if(bull>bear){decision='BUY UP';reason='delta +'+delta.toFixed(3)+'% | bull '+bull.toFixed(1)+' vs bear '+bear.toFixed(1);}
  else{decision='BUY DOWN';reason='delta '+delta.toFixed(3)+'% | bear '+bear.toFixed(1)+' vs bull '+bull.toFixed(1);}
  console.log('[ENGINE]',decision,'| conf:'+Math.round(conf*100)+'% edge:'+edge.toFixed(1)+'delta:'+delta.toFixed(3)+'%');
  lockedDecision={wts:currentMarket.wts,decision,reason,bull,bear,conf,quality,edge,startPrice:sp,lockedAt:Date.now(),lockedAtElapsed:elapsed,resolved:false};
  broadcast({type:'decision',decision:lockedDecision});
  // Add PENDING to tracker
  const time=new Date(currentMarket.wts*1000).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true,timeZone:'America/New_York'});
  trackerData.history=trackerData.history.filter(h=>h.window!==currentMarket.wts);
  trackerData.history.push({time,decision,result:'PENDING',window:currentMarket.wts});
  if(trackerData.history.length>50)trackerData.history.shift();
  broadcast({type:'tracker',tracker:trackerData});
}

// Re-run engine every 30s in case odds shifted enough to flip (but decision stays locked)
setInterval(()=>{
  if(!lockedDecision||lockedDecision.wts!==getWindowTs()) runEngine();
  else broadcast({type:'decision',decision:lockedDecision}); // keep re-broadcasting to late joiners
},30000);

// Browser WebSocket
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

// REST
// Resolve endpoint — browser tells server when window closes, server does math ONCE
// Uses a set to track which windows have already been resolved (prevents double counting)
const resolvedWindows = new Set();
app.post('/resolve',(req,res)=>{
  const{wts,decision,startPrice,btcPrice}=req.body;
  if(!wts||!decision) return res.json({ok:false});
  // Already resolved this window — ignore
  if(resolvedWindows.has(wts)) return res.json({ok:true,ignored:true});
  resolvedWindows.add(wts);
  let result='SKIP';
  if(decision!=='NO TRADE'&&btcPrice&&startPrice){
    const won=(decision==='BUY UP'&&btcPrice>=startPrice)||(decision==='BUY DOWN'&&btcPrice<startPrice);
    result=won?'WIN':'LOSS';
    if(won)trackerData.wins++;else trackerData.losses++;
  } else if(decision==='NO TRADE'){
    trackerData.skips++;result='SKIP';
  }
  const idx=trackerData.history.findIndex(h=>h.window===wts);
  if(idx>=0)trackerData.history[idx].result=result;
  console.log(`[RESOLVE] wts:${wts} ${decision} → ${result} | W:${trackerData.wins} L:${trackerData.losses}`);
  // Broadcast updated tracker to all clients
  broadcast({type:'tracker',tracker:trackerData});
  res.json({ok:true,result});
});
app.get('/candles',async(req,res)=>{
  try{
    const r=await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=30',{signal:AbortSignal.timeout(6000)});
    res.json(await r.json());
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/health',(req,res)=>res.json({ok:true,market:currentMarket?.slug,btc:latestBTCPrice}));
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
