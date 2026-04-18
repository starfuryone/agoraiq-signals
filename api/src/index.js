require("dotenv").config({ override: true });

require("./lib/config").validate();

const express = require("express");
const cors = require("cors");
const db = require("./lib/db");
const { rateLimit } = require("./middleware/rateLimit");

const app = express();
const PORT = parseInt(process.env.PORT) || 4300;

// Trust the reverse proxy so req.ip / X-Forwarded-For work correctly
app.set("trust proxy", 1);

// ── middleware ─────────────────────────────────────────────────────
app.use(cors());

// Global rate limit: protect against runaway clients / basic DoS.
// Skip /health so monitors don't count.
const globalLimiter = rateLimit({ windowMs: 60_000, max: 300 });
app.use((req, res, next) => (req.path === "/health" ? next() : globalLimiter(req, res, next)));

// Stricter limit on auth endpoints (brute-force protection).
const authLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: "Too many authentication attempts",
});

// Stripe webhook — raw body BEFORE json parser
app.post(
  "/api/v1/billing/webhook",
  express.raw({ type: "application/json" }),
  require("./routes/billing").webhookHandler
);

app.use(express.json({ limit: "100kb" }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    if (req.path !== "/health") {
      console.log(`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
    }
  });
  next();
});

// ── routes ────────────────────────────────────────────────────────
app.use("/api/v1/auth", authLimiter, require("./routes/auth"));
app.use("/api/v1/signals", require("./routes/signals"));
app.use("/api/v1/signals", require("./routes/signals-ext"));
app.use("/api/v1/providers", require("./routes/providers"));
app.use("/api/v1/scanner", require("./routes/scanner"));
app.use("/api/v1/scanner", require("./routes/scanner-live"));
app.use("/api/v1/proof", require("./routes/proof"));
app.use("/api/proof", require("./routes/proof"));
app.use("/api/v1/billing", require("./routes/billing").router);
app.use("/api/v1/telegram", require("./routes/telegram"));
app.use("/api/v1/ai", require("./routes/ai"));

app.get("/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ service: "agoraiq-signals-api", version: "3.0.0", status: "ok", port: PORT, uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: "error", error: err.message });
  }
});

app.use((req, res) => res.status(404).json({ error: "Not found", path: req.path }));
app.use((err, req, res, _next) => {
  console.error("[error]", err.stack || err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ── start ─────────────────────────────────────────────────────────
async function start() {
  try {
    const r = await db.query("SELECT NOW() AS now");
    console.log(`[db] connected — ${r.rows[0].now}`);
  } catch (err) {
    console.error("[db] connection failed:", err.message);
    process.exit(1);
  }


// Watchlist (SQLite)
const watchlistRouter = require('./watchlist');
app.use('/api/v1/watchlist', watchlistRouter);
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`[api] agoraiq-signals-api v3.0.0 on 127.0.0.1:${PORT}`);
    console.log("[api] routes: /auth, /signals, /providers, /scanner, /proof, /billing, /telegram, /ai");
  });
}

start().catch((err) => { console.error("[fatal]", err); process.exit(1); });
process.on("SIGTERM", async () => { await db.end(); process.exit(0); });
process.on("SIGINT", async () => { await db.end(); process.exit(0); });
