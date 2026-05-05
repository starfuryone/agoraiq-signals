/**
 * Price fetcher — current prices from Binance public API.
 * Uses in-memory cache with 10s TTL to avoid hammering the API.
 * Routes through SOCKS5 proxy if SOCKS_PROXY is set.
 */

const { SocksProxyAgent } = require("socks-proxy-agent");
const nodeFetch = require("node-fetch");

const BINANCE_API = process.env.BINANCE_API || "https://api.binance.com/api/v3";
const CACHE_TTL = 300_000; // 5 minutes (Binance is proxied — cache aggressively)
const SOCKS_PROXY = process.env.SOCKS_PROXY || process.env.SOCKS_PROXY_URL || null;

const agent = SOCKS_PROXY ? new SocksProxyAgent(SOCKS_PROXY) : null;


// Map Binance symbol to Kraken pair
function toKrakenSymbol(binanceSymbol) {
  const map = {
    BTCUSDT: "XBTUSDT", ETHUSDT: "ETHUSDT", SOLUSDT: "SOLUSDT",
    XRPUSDT: "XRPUSDT", ADAUSDT: "ADAUSDT", DOGEUSDT: "DOGEUSDT",
    DOTUSDT: "DOTUSDT", LINKUSDT: "LINKUSDT", AVAXUSDT: "AVAXUSDT",
    MATICUSDT: "MATICUSDT", BNBUSDT: "BNBUSDT", ARBUSDT: "ARBUSDT",
    OPUSDT: "OPUSDT", APTUSDT: "APTUSDT", SUIUSDT: "SUIUSDT",
    PEPEUSDT: "PEPEUSDT",
  };
  return map[binanceSymbol] || null;
}

const cache = new Map(); // symbol → { price, fetchedAt }

async function fetchPrice(symbol) {
  const upper = symbol.toUpperCase();

  // Check cache
  const cached = cache.get(upper);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.price;
  }

  try {
    const opts = agent ? { agent } : {};
    const res = await nodeFetch(`${BINANCE_API}/ticker/price?symbol=${upper}`, opts);
    if (res.ok) {
      const data = await res.json();
      const price = parseFloat(data.price);
      if (!isNaN(price)) {
        cache.set(upper, { price, fetchedAt: Date.now() });
        return price;
      }
    }
  } catch (err) {
    console.error(`[price] Binance failed for ${upper}:`, err.message);
  }

  // Kraken fallback
  try {
    const krakenPair = toKrakenSymbol(upper);
    if (krakenPair) {
      const res = await nodeFetch(`https://api.kraken.com/0/public/Ticker?pair=${krakenPair}`);
      if (res.ok) {
        const data = await res.json();
        if (data.result) {
          const key = Object.keys(data.result)[0];
          if (key) {
            const price = parseFloat(data.result[key].c[0]);
            if (!isNaN(price)) {
              cache.set(upper, { price, fetchedAt: Date.now() });
              return price;
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`[price] Kraken fallback failed for ${upper}:`, err.message);
  }

  return null;
}

/**
 * Fetch prices for multiple symbols at once.
 * Uses Binance /ticker/price (all symbols) and caches them.
 */
async function fetchAllPrices() {
  try {
    const opts = agent ? { agent } : {};
    const res = await nodeFetch(`${BINANCE_API}/ticker/price`, opts);
    if (!res.ok) return {};
    const data = await res.json();
    const now = Date.now();
    const map = {};
    for (const item of data) {
      const price = parseFloat(item.price);
      if (!isNaN(price)) {
        cache.set(item.symbol, { price, fetchedAt: now });
        map[item.symbol] = price;
      }
    }
    return map;
  } catch (err) {
    console.error("[price] bulk fetch failed:", err.message);
    return {};
  }
}

/**
 * Fetch 24h ticker stats for scanner endpoints.
 * Returns array of { symbol, priceChange, priceChangePercent, volume, quoteVolume }
 */
async function fetch24hTickers() {
  try {
    const opts = agent ? { agent } : {};
    const res = await nodeFetch(`${BINANCE_API}/ticker/24hr`, opts);
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error("[price] 24h ticker fetch failed:", err.message);
    return [];
  }
}

module.exports = { fetchPrice, fetchAllPrices, fetch24hTickers };
