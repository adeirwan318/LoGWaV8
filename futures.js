const axios = require("axios");
const crypto = require("crypto");

const FAPI_BASE = process.env.FAPI_BASE || "https://demo.binance.com";
const API_KEY = process.env.BINANCE_API_KEY || "";
const API_SECRET = process.env.BINANCE_API_SECRET || "";

if(!API_KEY || !API_SECRET){
  console.warn("[futures.js] WARNING: BINANCE_API_KEY or BINANCE_API_SECRET not set in .env. PlaceOrder and getPositionRisk will fail until keys are provided.");
}

function buildQuery(params){
  return Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null)
    .map(k => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
}

function signParams(params){
  const qs = buildQuery(params);
  const sig = crypto.createHmac("sha256", API_SECRET).update(qs).digest("hex");
  return { qs, signature: sig, signedQS: qs + "&signature=" + sig };
}

/**
 * placeOrder(options) - POST /fapi/v1/order
 */
async function placeOrder(options = {}){
  if(!API_KEY || !API_SECRET) throw new Error("API key/secret not set in environment (.env).");
  const ts = Date.now();
  const params = {
    symbol: options.symbol || "BTCUSDT",
    side: (options.side || "BUY"),
    type: (options.type || "MARKET"),
    timestamp: ts,
    recvWindow: options.recvWindow || 5000
  };
  if(options.quantity !== undefined) params.quantity = options.quantity;
  if(options.price !== undefined) params.price = options.price;
  if(options.reduceOnly) params.reduceOnly = true;
  if(options.positionSide) params.positionSide = options.positionSide;

  const { signedQS } = signParams(params);
  const url = `${FAPI_BASE}/fapi/v1/order?${signedQS}`;
  const headers = { "X-MBX-APIKEY": API_KEY };

  const resp = await axios.post(url, null, { headers, timeout: 15000 });
  return resp.data;
}

/**
 * getPositionRisk(symbol?) - GET /fapi/v2/positionRisk
 * returns array of positionRisk objects (or filtered by symbol if provided)
 */
async function getPositionRisk(symbol){
  if(!API_KEY || !API_SECRET) throw new Error("API key/secret not set in environment (.env).");
  const ts = Date.now();
  const params = { timestamp: ts, recvWindow: 5000 };
  if(symbol) params.symbol = symbol;
  const { signedQS } = signParams(params);
  const url = `${FAPI_BASE}/fapi/v2/positionRisk?${signedQS}`;
  const headers = { "X-MBX-APIKEY": API_KEY };
  const resp = await axios.get(url, { headers, timeout: 15000 });
  return resp.data;
}

module.exports = { placeOrder, signParams, getPositionRisk };

/* Optional test runner (use RUN_FTEST=1 to execute) */
if(require.main === module && process.env.RUN_FTEST === "1"){
  (async ()=>{
    try{
      const res = await getPositionRisk(process.env.TEST_POSITION_SYMBOL || undefined);
      console.log("positionRisk:", res);
    }catch(e){
      console.error("getPositionRisk error:", e.response && e.response.data ? e.response.data : e.message);
    }
    process.exit(0);
  })();
}
