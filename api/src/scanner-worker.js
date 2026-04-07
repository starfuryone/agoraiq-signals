/**
 * scanner-worker.js — AgoraIQ Scanner Engine
 * 
 * Standalone PM2 process that:
 * 1. Fetches tickers from Binance (via SOCKS5), Kraken, Coinbase every 10s
 * 2. Normalizes + scores them
 * 3. Caches to scanner_cache table (TTL 15s)
 * 4. Inserts new high-score detections into scanner_signals for lifecycle tracking
 * 
 * Run: pm2 start ecosystem.scanner.config.js
 * Or:  node scanner-worker.js
 */

require("dotenv").config({ path: "/opt/agoraiq-signals/api/.env", override: true });
const { Pool } = require("pg");
const nodeFetch = require("node-fetch");
const { SocksProxyAgent } = require("socks-proxy-agent");

// ── CONFIG ──
const DB_URL = process.env.DATABASE_URL || "postgresql://agoraiq_signals:desf19848@127.0.0.1:5432/agoraiq_signals";
const SOCKS_PROXY = process.env.SOCKS_PROXY || process.env.SOCKS_PROXY_URL || null;
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL_MS) || 10000;
const SIGNAL_MIN_SCORE = parseInt(process.env.SIGNAL_MIN_SCORE) || 55;
const BINANCE_FAPI = "https://fapi.binance.com/fapi/v1";
const KRAKEN_API = "https://api.kraken.com/0/public";
const COINBASE_API = "https://api.exchange.coinbase.com";

const pool = new Pool({ connectionString: DB_URL, max: 3 });
const agent = SOCKS_PROXY ? new SocksProxyAgent(SOCKS_PROXY) : null;

// ── TRACKED SYMBOLS ──
const BN_SYMS = new Set([
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","DOGEUSDT","XRPUSDT",
  "ARBUSDT","AVAXUSDT","LINKUSDT","WIFUSDT","PEPEUSDT","SUIUSDT",
  "ADAUSDT","DOTUSDT","MATICUSDT","OPUSDT","APTUSDT","NEARUSDT",
  "FTMUSDT","INJUSDT","TIAUSDT","SEIUSDT","RUNEUSDT","JUPUSDT"
]);
const KR_PAIRS = "XBTUSD,ETHUSD,SOLUSD,DOTUSD,LINKUSD,ADAUSD,AVAXUSD,XRPUSD";
const KR_MAP = {
  XXBTZUSD:"XBT/USD",XETHZUSD:"ETH/USD",SOLUSD:"SOL/USD",
  DOTUSD:"DOT/USD",LINKUSD:"LINK/USD",ADAUSD:"ADA/USD",
  AVAXUSD:"AVAX/USD",XXRPZUSD:"XRP/USD",XRPUSD:"XRP/USD"
};
const CB_PAIRS = ["BTC-USD","ETH-USD","SOL-USD","DOGE-USD","AVAX-USD","LINK-USD","XRP-USD","ADA-USD"];

// ── SCORING ENGINE ──
function computeScore(change, volM, funding) {
  let s = 35;
  s += Math.min(25, Math.abs(change) * 3);
  s += Math.min(20, Math.abs(volM) * 0.04);
  s += Math.min(15, Math.abs(funding || 0) * 300);
  return Math.min(99, Math.round(s));
}

function deriveBias(change, funding) {
  if (change > 2 && (funding === null || funding > -0.01)) return "long";
  if (change < -2 && (funding === null || funding < 0.01)) return "short";
  if (Math.abs(change) > 2) return change > 0 ? "long" : "short";
  return "neutral";
}

function deriveReasons(change, volSpike, funding, oi) {
  const reasons = [];
  if (Math.abs(change) > 5) reasons.push({ tag: "breakout", text: "Breakout" });
  else if (Math.abs(change) > 2.5) reasons.push({ tag: "momentum", text: "Momentum" });
  if (volSpike > 100) reasons.push({ tag: "volume", text: "Vol Spike" });
  if (funding !== null && Math.abs(funding) > 0.02) reasons.push({ tag: "funding", text: funding > 0 ? "Fund ↑" : "Fund ↓" });
  if (oi !== null && oi > 5) reasons.push({ tag: "oi", text: "OI Expansion" });
  if (!reasons.length) reasons.push({ tag: "momentum", text: "Mild Move" });
  return reasons;
}

function deriveInsight(reasons) {
  const tags = reasons.map(r => r.tag);
  if (tags.includes("breakout") && tags.includes("volume") && tags.includes("funding")) return "Strong continuation setup — aggressive move likely";
  if (tags.includes("breakout") && tags.includes("volume")) return "Breakout with volume confirmation";
  if (tags.includes("momentum") && tags.includes("volume")) return "Momentum building with liquidity";
  if (tags.includes("funding") && tags.includes("momentum")) return "Funding imbalance may force squeeze";
  if (tags.includes("breakout")) return "Price breaking key level";
  if (tags.includes("volume")) return "Unusual volume activity detected";
  if (tags.includes("funding")) return "Funding rate at extreme — reversion potential";
  return "Monitoring for follow-through";
}

function deriveTP(price, change, bias) {
  const move = Math.abs(change) * 0.6;
  const pct = Math.max(1, move * 1.5) / 100;
  return bias === "short" ? price * (1 - pct) : price * (1 + pct);
}

function deriveSL(price, change, bias) {
  const move = Math.abs(change) * 0.6;
  const pct = Math.max(0.5, move * 0.8) / 100;
  return bias === "short" ? price * (1 + pct) : price * (1 - pct);
}

// ── EXCHANGE FETCHERS ──
async function fetchBinance() {
  const t0 = Date.now();
  try {
    const [tickerRes, fundingRes] = await Promise.all([
      nodeFetch(`${BINANCE_FAPI}/ticker/24hr`, { agent, timeout: 8000 }),
      nodeFetch(`${BINANCE_FAPI}/premiumIndex`, { agent, timeout: 8000 })
    ]);
    if (!tickerRes.ok || !fundingRes.ok) throw new Error(`Binance ${tickerRes.status}/${fundingRes.status}`);
    const tickers = await tickerRes.json();
    const funding = await fundingRes.json();
    const fmap = {};
    funding.forEach(f => { fmap[f.symbol] = parseFloat(f.lastFundingRate) || 0; });

    const items = tickers
      .filter(t => BN_SYMS.has(t.symbol))
      .map(t => {
        const vol = parseFloat(t.quoteVolume) || 0;
        const chg = parseFloat(t.priceChangePercent) || 0;
        const price = parseFloat(t.lastPrice) || 0;
        const fund = fmap[t.symbol] || 0;
        const volM = vol / 1e6;
        const score = computeScore(chg, volM, fund);
        const bias = deriveBias(chg, fund);
        const reasons = deriveReasons(chg, volM, fund, null);
        return {
          symbol: t.symbol, exchange: "binance", price, change: chg,
          volSpike: Math.round(volM * 100) / 100, oiChange: null,
          funding: fund, volatility: Math.round(Math.abs(chg) * 1.2 * 100) / 100,
          score, bias, reasons, insight: deriveInsight(reasons),
          expectedMove: Math.round(Math.abs(chg) * 0.6 * 100) / 100,
          tp: deriveTP(price, chg, bias), sl: deriveSL(price, chg, bias),
          volume24h: vol, status: score >= 80 ? "fresh" : score >= 55 ? "active" : "fading",
          ts: Date.now()
        };
      });
    console.log(`[scanner] binance: ${items.length} symbols, ${Date.now() - t0}ms`);
    return { ok: true, ms: Date.now() - t0, items };
  } catch (e) {
    console.error(`[scanner] binance error: ${e.message}`);
    return { ok: false, ms: Date.now() - t0, items: [] };
  }
}

async function fetchKraken() {
  const t0 = Date.now();
  try {
    const res = await nodeFetch(`${KRAKEN_API}/Ticker?pair=${KR_PAIRS}`, { timeout: 8000 });
    if (!res.ok) throw new Error(`Kraken ${res.status}`);
    const d = await res.json();
    if (d.error && d.error.length) throw new Error(d.error[0]);
    const result = d.result || {};
    const items = Object.entries(result).map(([key, t]) => {
      const open = parseFloat(t.o) || 0;
      const last = parseFloat(t.c[0]) || 0;
      const vol = parseFloat(t.v[1]) || 0;
      const chg = open > 0 ? ((last - open) / open) * 100 : 0;
      const sym = KR_MAP[key] || key;
      const volM = vol / 100;
      const score = computeScore(chg, volM, 0);
      const bias = deriveBias(chg, null);
      const reasons = deriveReasons(chg, volM, null, null);
      return {
        symbol: sym, exchange: "kraken", price: last,
        change: Math.round(chg * 100) / 100, volSpike: Math.round(volM * 100) / 100,
        oiChange: null, funding: null,
        volatility: Math.round(Math.abs(chg) * 1.1 * 100) / 100,
        score, bias, reasons, insight: deriveInsight(reasons),
        expectedMove: Math.round(Math.abs(chg) * 0.6 * 100) / 100,
        tp: deriveTP(last, chg, bias), sl: deriveSL(last, chg, bias),
        volume24h: vol * last, status: score >= 80 ? "fresh" : score >= 55 ? "active" : "fading",
        ts: Date.now()
      };
    });
    console.log(`[scanner] kraken: ${items.length} symbols, ${Date.now() - t0}ms`);
    return { ok: true, ms: Date.now() - t0, items };
  } catch (e) {
    console.error(`[scanner] kraken error: ${e.message}`);
    return { ok: false, ms: Date.now() - t0, items: [] };
  }
}

async function fetchCoinbase() {
  const t0 = Date.now();
  try {
    const items = [];
    // Fetch in parallel, 2 calls per pair (ticker + stats)
    const results = await Promise.all(CB_PAIRS.map(async pair => {
      try {
        const [tickRes, statRes] = await Promise.all([
          nodeFetch(`${COINBASE_API}/products/${pair}/ticker`, { timeout: 5000 }),
          nodeFetch(`${COINBASE_API}/products/${pair}/stats`, { timeout: 5000 })
        ]);
        const tick = tickRes.ok ? await tickRes.json() : null;
        const stat = statRes.ok ? await statRes.json() : null;
        if (!tick || !tick.price) return null;
        const price = parseFloat(tick.price) || 0;
        const vol = parseFloat(tick.volume) || 0;
        const open = stat ? parseFloat(stat.open) || 0 : 0;
        const chg = open > 0 ? ((price - open) / open) * 100 : 0;
        const volM = (vol * price) / 1e6;
        const score = computeScore(chg, volM, 0);
        const bias = deriveBias(chg, null);
        const reasons = deriveReasons(chg, volM, null, null);
        return {
          symbol: pair, exchange: "coinbase", price,
          change: Math.round(chg * 100) / 100, volSpike: Math.round(volM * 100) / 100,
          oiChange: null, funding: null,
          volatility: Math.round(Math.abs(chg) * 1.1 * 100) / 100,
          score, bias, reasons, insight: deriveInsight(reasons),
          expectedMove: Math.round(Math.abs(chg) * 0.6 * 100) / 100,
          tp: deriveTP(price, chg, bias), sl: deriveSL(price, chg, bias),
          volume24h: vol * price, status: score >= 80 ? "fresh" : score >= 55 ? "active" : "fading",
          ts: Date.now()
        };
      } catch { return null; }
    }));
    const valid = results.filter(Boolean);
    console.log(`[scanner] coinbase: ${valid.length} symbols, ${Date.now() - t0}ms`);
    return { ok: valid.length > 0, ms: Date.now() - t0, items: valid };
  } catch (e) {
    console.error(`[scanner] coinbase error: ${e.message}`);
    return { ok: false, ms: Date.now() - t0, items: [] };
  }
}

// ── CACHE TO DB ──
async function cacheResults(category, data) {
  const payload = JSON.stringify(data);
  await pool.query(`
    INSERT INTO scanner_cache (category, data, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (category) DO UPDATE SET data = $2, updated_at = NOW()
  `, [category, payload]);
}

// ── INSERT NEW SIGNAL DETECTIONS ──
async function insertDetections(items) {
  let inserted = 0;
  for (const r of items) {
    if (r.score < SIGNAL_MIN_SCORE) continue;
    try {
      await pool.query(`
        INSERT INTO scanner_signals 
          (symbol, exchange, entry_price, score, bias, reasons, insight, 
           expected_move, tp_price, sl_price, window_minutes, category,
           volume_24h, funding_rate)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT DO NOTHING
      `, [
        r.symbol, r.exchange, r.price, r.score, r.bias,
        JSON.stringify(r.reasons), r.insight,
        r.expectedMove, r.tp, r.sl,
        r.score >= 85 ? 15 : r.score >= 65 ? 60 : 240,
        r.reasons[0]?.tag || "breakout",
        r.volume24h || null, r.funding || null
      ]);
      inserted++;
    } catch (e) {
      // Dedup index prevents re-insert within 10 min — expected
      if (!e.message.includes("duplicate")) console.error(`[scanner] insert error: ${e.message}`);
    }
  }
  if (inserted > 0) console.log(`[scanner] ${inserted} new signals tracked`);
}

// ── MAIN SCAN LOOP ──
async function scan() {
  const t0 = Date.now();
  const [bn, kr, cb] = await Promise.all([fetchBinance(), fetchKraken(), fetchCoinbase()]);

  const all = [...bn.items, ...kr.items, ...cb.items];
  all.sort((a, b) => (b.score || 0) - (a.score || 0));

  // Cache full results for /scanner/live
  const meta = {
    exchanges: {
      binance: { ok: bn.ok, ms: bn.ms, count: bn.items.length },
      kraken: { ok: kr.ok, ms: kr.ms, count: kr.items.length },
      coinbase: { ok: cb.ok, ms: cb.ms, count: cb.items.length }
    },
    total: all.length,
    latency: Date.now() - t0,
    scannedAt: new Date().toISOString()
  };

  await cacheResults("live", { meta, items: all });

  // Also cache by category
  const breakouts = all.filter(r => Math.abs(r.change) > 3);
  const momentum = all.filter(r => r.reasons.some(x => x.tag === "momentum"));
  const volume = all.filter(r => r.volSpike > 50);
  const funding = all.filter(r => r.funding !== null && Math.abs(r.funding) > 0.01);

  await Promise.all([
    cacheResults("top", { meta, items: breakouts.length ? breakouts : all.slice(0, 15) }),
    cacheResults("momentum", { meta, items: momentum }),
    cacheResults("volume", { meta, items: volume }),
    cacheResults("funding", { meta, items: funding })
  ]);

  // Track high-score signals for lifecycle
  await insertDetections(all);

  console.log(`[scanner] cycle done: ${all.length} markets, ${Date.now() - t0}ms total`);
}

// ── STARTUP ──
async function init() {
  // Verify DB connection
  const r = await pool.query("SELECT NOW() AS now");
  console.log(`[scanner-worker] connected — ${r.rows[0].now}`);

  // Ensure scanner_cache has category column as unique
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scanner_cache (
      category TEXT PRIMARY KEY,
      data JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log(`[scanner-worker] starting scan loop (every ${SCAN_INTERVAL}ms)`);
  
  // Initial scan
  await scan().catch(e => console.error("[scanner] initial scan error:", e.message));
  
  // Loop
  setInterval(() => {
    scan().catch(e => console.error("[scanner] scan error:", e.message));
  }, SCAN_INTERVAL);
}

init().catch(e => { console.error("[scanner-worker] fatal:", e); process.exit(1); });

process.on("SIGTERM", async () => { await pool.end(); process.exit(0); });
process.on("SIGINT", async () => { await pool.end(); process.exit(0); });
