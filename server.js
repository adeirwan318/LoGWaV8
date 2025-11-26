// Source file path: C:\Dev\LoGWaV8\server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');
let futures;
try{ futures = require("./futures"); }catch(e){ console.warn("[server] futures module not found yet."); futures = null; }

const PORT = process.env.PORT || 3001;
const PUBLIC_DIR = process.env.PUBLIC_DIR || 'public';
const BINANCE_WS_BASE = process.env.BINANCE_WS_BASE || 'wss://stream.binance.com:9443/ws';
const SYMBOL_STREAM = process.env.SYMBOL || 'btcusdt@trade';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, PUBLIC_DIR)));
app.use(express.json());

// In-memory state (simple)
let state = {
  equity: Number(process.env.INITIAL_EQUITY || 10000),
  price: 0,
  position: null,
  pnl: 0,
  leverage: 1,
  initialMarginPct: 10
};

// Binance trade stream connection
let binanceWs;
function startBinanceWS(){
  const url = `${BINANCE_WS_BASE}/${SYMBOL_STREAM}`;
  binanceWs = new WebSocket(url);
  binanceWs.on('open', ()=> console.log('Connected to Binance stream', url));
  binanceWs.on('message', (msg)=>{
    try{
      const data = JSON.parse(msg);
      if(data && data.p){
        const price = Number(data.p);
        state.price = price;
        if(state.position){
          const pos = state.position;
          const change = (state.price - pos.entryPrice) / pos.entryPrice;
          state.pnl = pos.side === 'long' ? change * pos.notional * state.leverage : -change * pos.notional * state.leverage;
        }
        broadcast({type: 'price', price: state.price, equity: state.equity, pnl: state.pnl});
      }
    }catch(e){/* ignore parse errors */}
  });
  binanceWs.on('close', ()=>{ console.log('Binance WS closed, reconnecting in 3s'); setTimeout(startBinanceWS,3000); });
  binanceWs.on('error', (err)=> { console.warn('Binance WS error', err && err.message); });
}
startBinanceWS();

function broadcast(obj){
  const msg = JSON.stringify(obj);
  wss.clients.forEach(client=>{
    if(client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', (ws)=>{
  ws.send(JSON.stringify({type:'init', state: {price: state.price, equity: state.equity, pnl: state.pnl, leverage: state.leverage, initialMarginPct: state.initialMarginPct}}));
  ws.on('message', (msg)=>{
    try{
      const data = JSON.parse(msg);
      if(data.type === 'setMargin'){
        state.initialMarginPct = Number(data.pct);
      }
      if(data.type === 'setLeverage'){
        const lev = Number(data.leverage) || 1;
        state.leverage = Math.max(1, lev);
      }
      if(data.type === 'startAuto'){
        if(!state.position){
          const marginPct = Math.max(0, Math.min(100, Number(state.initialMarginPct || 10)));
          const marginAmount = state.equity * (marginPct/100);
          const notional = marginAmount * state.leverage;
          state.position = { side: 'long', entryPrice: state.price || 0, notional, marginUsed: marginAmount };
          state.pnl = 0;
          broadcast({type:'position', position: state.position});
        }
      }
      if(data.type === 'closePosition'){
        if(state.position){
          state.equity += state.pnl;
          state.position = null;
          state.pnl = 0;
          broadcast({type:'positionClosed', equity: state.equity});
        }
      }
    }catch(e){ console.warn('WS client message parse error', e && e.message); }
  });
});

// Express endpoint to place real/testnet futures orders via futures.js (if available)
app.post("/api/placeOrder", async (req, res) => {
  try {
    if(!futures) throw new Error("Futures module not available. Create futures.js first.");
    const order = req.body || {};
    const result = await futures.placeOrder(order);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.response && e.response.data ? e.response.data : e.message });
  }
});

// NEW: endpoint to fetch position risk (real position info)
app.get("/api/position", async (req, res) => {
  try {
    if(!futures) throw new Error("Futures module not loaded.");
    const symbol = req.query.symbol || "BTCUSDT";
    const result = await futures.getPositionRisk(symbol);
    res.json({ ok: true, data: result });

// --- Added endpoints: /api/price and /api/computeQtyTest ---
// Helper to compute order quantity safely (ensures notional >= minNotional)
function computeOrderQty(equity, marginPct, leverage, price, minNotional = 17) {
  const useUSDT = (Number(equity) || 0) * (Number(marginPct) / 100) * (Number(leverage) || 1);
  if (!price || price <= 0) return { qty: 0, notional: 0 };
  let qty = useUSDT / price;
  let notional = qty * price;
  if (notional < minNotional) {
    qty = minNotional / price;
    notional = qty * price;
  }
  // Round to 6 decimals for BTC and keep numeric return
  const q = Number(qty.toFixed(6));
  return { qty: q, notional: Number(notional.toFixed(4)) };
}

// Simple price endpoint: prefer WS-derived price (state.price), fallback to Binance premiumIndex
app.get('/api/price', async (req, res) => {
  try {
    if (state.price && Number(state.price) > 0) {
      return res.json({ ok: true, price: Number(state.price), source: 'ws' });
    }
    // fallback to Binance futures premiumIndex / markPrice
    const r = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', { params: { symbol: 'BTCUSDT' } });
    const price = Number(r.data.markPrice || r.data.lastPrice || r.data.indexPrice || 0);
    return res.json({ ok: true, price, source: 'fapi' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

// Test endpoint to compute qty given parameters (useful for debugging)
app.get('/api/computeQtyTest', (req, res) => {
  try {
    const price = Number(req.query.price) || Number(state.price) || 0;
    const eq = Number(req.query.eq) || Number(state.equity) || 0;
    const marginPct = Number(req.query.marginPct) || Number(state.initialMarginPct) || 10;
    const lev = Number(req.query.leverage) || Number(state.leverage) || 1;
    const minNotional = Number(req.query.minNotional) || 17;
    const result = computeOrderQty(eq, marginPct, lev, price, minNotional);
    return res.json({ ok: true, price, equity: eq, marginPct, leverage: lev, minNotional, qty: result.qty, notional: result.notional });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
});

// --- end added endpoints ---

  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e && e.response && e.response.data ? e.response.data : e.message
    });
  }
});

server.listen(PORT, ()=> console.log('Server listening on', PORT));
/* REAL order handlers: listen for startAutoReal and closeReal via WS */
wss.on('connection', (ws)=> {
  ws.on('message', (msg)=>{
    try{
      const data = JSON.parse(msg);
      if(data.type === 'startAutoReal'){
        if(!futures){ ws.send(JSON.stringify({type:'orderError', error:'futures module not available'})); return; }
        const marginPct = Math.max(0, Math.min(100, Number(state.initialMarginPct || 10)));
        const marginAmount = state.equity * (marginPct/100);
        const notional = marginAmount * state.leverage;
        const qty = state.price && state.price > 0 ? (notional / state.price) : 0;
        const quantity = Number(qty.toFixed(6));
        (async ()=>{
          try{
            const resp = await futures.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity });
            ws.send(JSON.stringify({ type: 'orderResult', result: resp }));
            // set local state from response (best-effort)
            const entryPrice = resp.avgPrice ? Number(resp.avgPrice) : state.price;
            state.position = { side: 'long', entryPrice, notional, marginUsed: marginAmount, quantity };
            state.pnl = 0;
            broadcast({ type: 'position', position: state.position });
          }catch(e){
            ws.send(JSON.stringify({ type:'orderError', error: e.response && e.response.data ? e.response.data : e.message }));
          }
        })();
        return;
      }
      if(data.type === 'closeReal'){
        if(!futures || !state.position){ ws.send(JSON.stringify({type:'orderError', error:'no real position available'})); return; }
        const side = state.position.side === 'long' ? 'SELL' : 'BUY';
        const quantity = Math.abs(state.position.quantity || 0);
        (async ()=>{
          try{
            const resp = await futures.placeOrder({ symbol: 'BTCUSDT', side, type: 'MARKET', quantity, reduceOnly: true });
            ws.send(JSON.stringify({ type:'orderResult', result: resp }));
            state.equity += state.pnl;
            state.position = null;
            state.pnl = 0;
            broadcast({ type:'positionClosed', equity: state.equity });
          }catch(e){
            ws.send(JSON.stringify({ type:'orderError', error: e.response && e.response.data ? e.response.data : e.message }));
          }
        })();
        return;
      }
    }catch(e){
      // ignore non-json or other messages
    }
  });
});
wss.on('connection', (ws) => {
  ws.on('message', async (rawMsg) => {
    let data;
    try { data = JSON.parse(rawMsg); } catch { return; }

    // REAL AUTO START
    if (data.type === 'startAutoReal') {
      try {
        if (!futures) {
          ws.send(JSON.stringify({ type: 'orderError', error: 'Futures module not loaded' }));
          return;
        }

        const direction = data.direction || "long";
        const side = direction === "short" ? "SELL" : "BUY";

        // Calculate quantity
        const marginPct = state.initialMarginPct / 100;
        const marginAmount = state.equity * marginPct;
        const notional = marginAmount * state.leverage;
        const qty = notional / (state.price || 1);
        const quantity = Number(qty.toFixed(3));

        const resp = await futures.placeOrder({
          symbol: "BTCUSDT",
          side,
          type: "MARKET",
          quantity
        });

        ws.send(JSON.stringify({ type: "orderResult", result: resp }));
      } catch (e) {
        ws.send(JSON.stringify({
          type: "orderError",
          error: e.response?.data || e.message
        }));
      }
      return;
    }

    // REAL CLOSE
    if (data.type === 'closeReal') {
      try {
        let pos = await futures.getPositionRisk("BTCUSDT");
        pos = pos[0];
        const amt = Number(pos.positionAmt);
        if (!amt) {
          ws.send(JSON.stringify({ type: "orderError", error: "No real position" }));
          return;
        }
        const side = amt > 0 ? "SELL" : "BUY";
        const resp = await futures.placeOrder({
          symbol: "BTCUSDT",
          side,
          type: "MARKET",
          reduceOnly: true,
          quantity: Math.abs(amt)
        });

        ws.send(JSON.stringify({ type: "orderResult", result: resp }));
      } catch (e) {
        ws.send(JSON.stringify({ type: "orderError", error: e.response?.data || e.message }));
      }
    }
  });
});
/* PATCH: Minimum qty enforcement for real orders */
wss.on("connection", (ws) => {
  ws.on("message", async (rawMsg) => {
    let data;
    try { data = JSON.parse(rawMsg); } catch { return; }

    if (data.type === "startAutoReal") {
      try {
        const direction = data.direction || "long";
        const side = direction === "short" ? "SELL" : "BUY";

        const marginPct = state.initialMarginPct / 100;
        const marginAmount = state.equity * marginPct;
        const notional = marginAmount * state.leverage;
        const qtyRaw = notional / (state.price || 1);
        const quantity = Math.max(Number(qtyRaw.toFixed(3)), 0.01);

        const resp = await futures.placeOrder({
          symbol: "BTCUSDT",
          side,
          type: "MARKET",
          quantity
        });

        ws.send(JSON.stringify({ type: "orderResult", result: resp }));
      } catch (e) {
        ws.send(JSON.stringify({ type: "orderError", error: e.response?.data || e.message }));
      }
    }
  });
});
wss.on('connection', ws => {
  ws.on('message', m => {
    try {
      console.log("[WS MSG IN]", m.toString());
    } catch(err) {
      console.log("[WS MSG IN ERROR]", err && err.message ? err.message : err);
    }
  });
});
/* DEBUG / robust startAutoReal handler */
wss.on('connection', ws => {
  ws.on('message', async raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (data && data.type === 'startAutoReal') {
      console.log('[HANDLER] startAutoReal received ->', data);
      try {
        if (!futures) {
          console.log('[HANDLER] futures module missing');
          ws.send(JSON.stringify({ type: 'orderError', error: 'futures module not loaded' }));
          return;
        }
        if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
          console.log('[HANDLER] ENV KEYS MISSING');
          ws.send(JSON.stringify({ type: 'orderError', error: 'API key/secret not set in environment (.env)' }));
          return;
        }

        const direction = (data.direction || 'long').toLowerCase();
        const side = direction === 'short' ? 'SELL' : 'BUY';

        const marginPct = (state.initialMarginPct || 10) / 100;
        const marginAmount = (state.equity || 0) * marginPct;
        const notional = marginAmount * (state.leverage || 1);
        const qtyRaw = notional / (state.price || 1);
        const quantity = Math.max(Number(qtyRaw.toFixed(3)), 0.01);

        console.log('[HANDLER] placing order', { side, quantity, price: state.price, marginPct, notional });
        const resp = await futures.placeOrder({ symbol: 'BTCUSDT', side, type: 'MARKET', quantity });
        console.log('[HANDLER] orderResult ->', resp);
        ws.send(JSON.stringify({ type: 'orderResult', result: resp }));
        return;
      } catch (err) {
        const errObj = err && err.response && err.response.data ? err.response.data : (err && err.message ? err.message : err);
        console.error('[HANDLER] orderError ->', errObj);
        ws.send(JSON.stringify({ type: 'orderError', error: errObj }));
        return;
      }
    }
  });
});
/* AUTO: poll futures wallet balance and update state.equity (USDT) */
const axios = require("axios");
async function updateRealEquity(){
  if(!futures) return;
  try{
    const ts = Date.now();
    const params = { timestamp: ts, recvWindow: 5000 };
    const { signedQS } = futures.signParams(params);
    const base = process.env.FAPI_BASE || "https://fapi.binance.com";
    const url = base + "/fapi/v2/balance?" + signedQS;
    const headers = { "X-MBX-APIKEY": process.env.BINANCE_API_KEY || "" };
    const resp = await axios.get(url, { headers, timeout: 10000 });
    if(Array.isArray(resp.data)){
      // find USDT balance (futures wallet)
      const usdt = resp.data.find(x => x.asset === "USDT" || x.asset === "BUSD");
      if(usdt){
        const bal = Number(usdt.balance || usdt.withdrawAvailable || 0);
        if(!isNaN(bal) && bal > 0){
          state.equity = bal;
          // broadcast updated equity only
          broadcast({ type: "equity", equity: state.equity });
        }
      }
    }
  }catch(e){
    // silent fail — keep simulated equity if any issue
    // console.warn('[updateRealEquity] err', e && (e.response && e.response.data ? e.response.data : e.message));
  }
}
// start polling (only when futures module available)
setInterval(updateRealEquity, 5000);
updateRealEquity();
app.get('/api/signal', async (req, res) => {
  try {
    res.json({
      ok: true,
      signal: 'none',
      reason: 'not_enough_data',
      candles: { count: 0 }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.get('/api/signal', async (req, res) => {
  try {
    res.json({
      ok: true,
      signal: 'none',
      reason: 'not_enough_data',
      candles: { count: 0 }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// AUTO ROUTES PATCH
try { require('./api_auto_routes')(app, state); } catch(e) { console.warn('auto routes load failed:', e.message); }


// AUTO ROUTES PATCH
try { require('./api_auto_routes')(app, state); } catch(e) { console.warn('auto routes load failed:', e.message); }

