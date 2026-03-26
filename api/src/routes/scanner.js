const { Router } = require("express");
const db = require("../lib/db");
const { fetchPrice, fetch24hTickers } = require("../lib/price");

const router = Router();

// In-memory cache for scanner data (refreshed every 5 min)
let _scannerCache = { data: null, fetchedAt: 0 };
const CACHE_TTL = 300_000; // 5 minutes

async function getTickerData() {
  if (_scannerCache.data && Date.now() - _scannerCache.fetchedAt < CACHE_TTL) {
    return _scannerCache.data;
  }

  const raw = await fetch24hTickers();

  // Filter to USDT pairs with meaningful volume
  const usdt = raw
    .filter((t) => t.symbol.endsWith("USDT") && parseFloat(t.quoteVolume) > 100_000)
    .map((t) => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice),
      priceChange: parseFloat(t.priceChange),
      priceChangePercent: parseFloat(t.priceChangePercent),
      volume: parseFloat(t.quoteVolume),
      highPrice: parseFloat(t.highPrice),
      lowPrice: parseFloat(t.lowPrice),
      count: parseInt(t.count), // number of trades
    }));

  _scannerCache = { data: usdt, fetchedAt: Date.now() };
  return usdt;
}

// ─────────────────────────────────────────────────────────────────
// GET /scanner/overview — market overview
// ─────────────────────────────────────────────────────────────────
router.get("/overview", async (req, res) => {
  try {
    const tickers = await getTickerData();

    const btc = tickers.find((t) => t.symbol === "BTCUSDT");
    const eth = tickers.find((t) => t.symbol === "ETHUSDT");

    // Simple fear/greed proxy: BTC 24h change
    const sentiment =
      btc && btc.priceChangePercent > 3
        ? "Extreme Greed"
        : btc && btc.priceChangePercent > 1
          ? "Greed"
          : btc && btc.priceChangePercent < -3
            ? "Extreme Fear"
            : btc && btc.priceChangePercent < -1
              ? "Fear"
              : "Neutral";

    // Top movers for watchlist
    const topMovers = [...tickers]
      .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
      .slice(0, 10)
      .map((t) => t.symbol);

    res.json({
      btcPrice: btc ? btc.price : null,
      ethPrice: eth ? eth.price : null,
      btcChange24h: btc ? btc.priceChangePercent : null,
      ethChange24h: eth ? eth.priceChangePercent : null,
      totalPairs: tickers.length,
      sentiment,
      watchlist: topMovers,
    });
  } catch (err) {
    console.error("[scanner/overview]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /scanner/breakouts — pairs with large price move + high volume
// ─────────────────────────────────────────────────────────────────
router.get("/breakouts", async (req, res) => {
  try {
    const tickers = await getTickerData();

    // Breakout heuristic: >3% move AND high volume relative to typical
    const avgVolume =
      tickers.reduce((s, t) => s + t.volume, 0) / (tickers.length || 1);

    const breakouts = tickers
      .filter(
        (t) =>
          Math.abs(t.priceChangePercent) > 3 && t.volume > avgVolume * 1.5
      )
      .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
      .slice(0, 15)
      .map((t) => ({
        symbol: t.symbol,
        direction: t.priceChangePercent > 0 ? "LONG" : "SHORT",
        change: t.priceChangePercent,
        price: t.price,
        volume: t.volume,
        score: Math.round(
          Math.min(Math.abs(t.priceChangePercent) * 10 + (t.volume / avgVolume) * 5, 100)
        ),
      }));

    res.json({ breakouts });
  } catch (err) {
    console.error("[scanner/breakouts]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /scanner/top — top breakout candidates (composite score)
// ─────────────────────────────────────────────────────────────────
router.get("/top", async (req, res) => {
  try {
    const tickers = await getTickerData();
    const avgVolume =
      tickers.reduce((s, t) => s + t.volume, 0) / (tickers.length || 1);

    const scored = tickers
      .map((t) => {
        // Breakout score: change magnitude + volume ratio + proximity to high
        const changeMag = Math.abs(t.priceChangePercent);
        const volRatio = t.volume / (avgVolume || 1);
        const nearHigh =
          t.highPrice > 0 ? (t.price / t.highPrice) * 100 : 50;
        const score = Math.round(changeMag * 8 + volRatio * 5 + nearHigh * 0.2);
        return { ...t, score: Math.min(score, 100) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    res.json({
      data: scored.map((t) => ({
        symbol: t.symbol,
        price: t.price,
        change: t.priceChangePercent,
        volume: t.volume,
        score: t.score,
      })),
    });
  } catch (err) {
    console.error("[scanner/top]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /scanner/momentum — strongest directional momentum
// ─────────────────────────────────────────────────────────────────
router.get("/momentum", async (req, res) => {
  try {
    const tickers = await getTickerData();

    const momentum = [...tickers]
      .sort((a, b) => b.priceChangePercent - a.priceChangePercent)
      .slice(0, 10);

    res.json({
      data: momentum.map((t) => ({
        symbol: t.symbol,
        value: t.priceChangePercent,
        price: t.price,
        volume: t.volume,
      })),
    });
  } catch (err) {
    console.error("[scanner/momentum]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /scanner/volume — unusual volume movers
// ─────────────────────────────────────────────────────────────────
router.get("/volume", async (req, res) => {
  try {
    const tickers = await getTickerData();

    const sorted = [...tickers]
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 10);

    res.json({
      data: sorted.map((t) => ({
        symbol: t.symbol,
        value: t.volume,
        change: t.priceChangePercent,
        price: t.price,
      })),
    });
  } catch (err) {
    console.error("[scanner/volume]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /scanner/oi — open interest movers
// Uses scanner_cache table if populated, otherwise Binance proxy
// ─────────────────────────────────────────────────────────────────
router.get("/oi", async (req, res) => {
  try {
    // Try scanner_cache first (populated by market-scanner process)
    try {
      const r = await db.query(
        `SELECT symbol, value, extra FROM scanner_cache
         WHERE category = 'oi'
         ORDER BY value DESC LIMIT 10`
      );
      if (r.rows.length > 0) {
        return res.json({
          data: r.rows.map((row) => ({
            symbol: row.symbol,
            value: parseFloat(row.value),
            ...(row.extra || {}),
          })),
        });
      }
    } catch {
      // Table might not exist or be empty
    }

    // Fallback: use volume as OI proxy
    const tickers = await getTickerData();
    const sorted = [...tickers]
      .filter((t) => t.count > 10000)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    res.json({
      data: sorted.map((t) => ({
        symbol: t.symbol,
        value: t.count,
        change: t.priceChangePercent,
        price: t.price,
      })),
    });
  } catch (err) {
    console.error("[scanner/oi]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /scanner/funding — funding rate extremes
// Uses scanner_cache table if populated
// ─────────────────────────────────────────────────────────────────
router.get("/funding", async (req, res) => {
  try {
    // Try scanner_cache
    try {
      const r = await db.query(
        `SELECT symbol, value, extra FROM scanner_cache
         WHERE category = 'funding'
         ORDER BY ABS(value) DESC LIMIT 10`
      );
      if (r.rows.length > 0) {
        return res.json({
          data: r.rows.map((row) => ({
            symbol: row.symbol,
            value: parseFloat(row.value),
            ...(row.extra || {}),
          })),
        });
      }
    } catch {
      // Not available
    }

    // Fallback: try fetching from Binance Futures API
    try {
      const resp = await fetch(
        "https://fapi.binance.com/fapi/v1/premiumIndex"
      );
      if (resp.ok) {
        const data = await resp.json();
        const sorted = data
          .filter((d) => d.symbol.endsWith("USDT"))
          .map((d) => ({
            symbol: d.symbol,
            value: parseFloat(d.lastFundingRate) * 100,
            price: parseFloat(d.markPrice),
          }))
          .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
          .slice(0, 10);

        return res.json({ data: sorted });
      }
    } catch {
      // Futures API might not be accessible
    }

    res.json({ data: [], note: "Funding data not available" });
  } catch (err) {
    console.error("[scanner/funding]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /scanner/pair/:symbol — single pair detail
// ─────────────────────────────────────────────────────────────────
router.get("/pair/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const tickers = await getTickerData();
    const ticker = tickers.find((t) => t.symbol === symbol);

    if (!ticker) {
      // Try direct Binance lookup
      const price = await fetchPrice(symbol);
      if (price === null) {
        return res.status(404).json({ error: `Pair ${symbol} not found` });
      }
      return res.json({
        symbol,
        price,
        change24h: null,
        volume24h: null,
        breakoutScore: null,
      });
    }

    const avgVolume =
      tickers.reduce((s, t) => s + t.volume, 0) / (tickers.length || 1);
    const changeMag = Math.abs(ticker.priceChangePercent);
    const volRatio = ticker.volume / (avgVolume || 1);
    const score = Math.round(Math.min(changeMag * 8 + volRatio * 5, 100));

    res.json({
      symbol: ticker.symbol,
      price: ticker.price,
      change24h: ticker.priceChangePercent,
      volume24h: ticker.volume,
      highPrice: ticker.highPrice,
      lowPrice: ticker.lowPrice,
      breakoutScore: score,
      direction: ticker.priceChangePercent > 0 ? "LONG" : "SHORT",
    });
  } catch (err) {
    console.error("[scanner/pair]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
