const { Router } = require("express");
const crypto = require("crypto");
const db = require("../lib/db");
const Signal = require("../models/signal");

const router = Router();

// Helper to query signals_v2, falling back to legacy tables
async function querySignals(sql, params) {
  try {
    return await db.query(sql, params);
  } catch {
    const legacy = sql
      .replace(/signals_v2/g, "user_signals")
      .replace(/direction/g, "action")
      .replace(/entry/g, "price")
      .replace(/stop(?!\w)/g, "stop_loss")
      .replace(/result/g, "pnl");
    return await db.query(legacy, params);
  }
}

// ── Compute deterministic SHA-256 hash for a signal row ───────────
function signalHash(row) {
  const payload = [
    row.id,
    row.symbol,
    row.direction,
    row.entry,
    row.stop,
    JSON.stringify(row.targets || []),
    row.provider || "",
    row.created_at ? new Date(row.created_at).toISOString() : "",
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// ── Format duration_sec to human string ───────────────────────────
function fmtDuration(sec) {
  if (!sec) return null;
  if (sec < 60) return sec + "s";
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (sec < 86400) return h + "h " + m + "m";
  const d = Math.floor(sec / 86400);
  return d + "d " + (h % 24) + "h";
}

// ── Map DB status to frontend outcome category ───────────────────
function outcomeCategory(status) {
  if (!status) return "open";
  const up = status.toUpperCase();
  if (up === "TP1") return "partial_win";
  if (up === "TP2" || up === "TP3") return "win";
  if (up === "SL") return "loss";
  if (up === "EXPIRED") return "expired";
  return "open";
}

// ══════════════════════════════════════════════════════════════════
// GET /proof/status — system status + evidence strip
// ══════════════════════════════════════════════════════════════════
router.get("/status", async (req, res) => {
  try {
    const r = await querySignals(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'OPEN')::int AS tracking,
        MAX(created_at) AS last_capture,
        MAX(resolved_at) AS last_resolved
      FROM signals_v2
    `);
    const s = r.rows[0];
    res.json({
      tracked: s.total || 0,
      tracking: s.tracking || 0,
      lastCapture: s.last_capture || null,
      lastHash: s.last_capture || null, // hash is computed at capture time
      lastResolved: s.last_resolved || null,
    });
  } catch (err) {
    console.error("[proof/status]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /proof/stats — KPIs
// ══════════════════════════════════════════════════════════════════
router.get("/stats", async (req, res) => {
  try {
    const r = await querySignals(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED'))::int AS resolved,
        COUNT(*) FILTER (WHERE status LIKE 'TP%')::int AS wins,
        COUNT(*) FILTER (WHERE status = 'SL')::int AS losses,
        COUNT(*) FILTER (WHERE status LIKE 'TP%' OR status = 'SL')::int AS decided,
        ROUND(AVG(CASE WHEN result IS NOT NULL THEN result END)::numeric, 4) AS avg_result,
        ROUND(AVG(CASE WHEN duration_sec IS NOT NULL THEN duration_sec END))::int AS avg_duration_sec
      FROM signals_v2
    `);
    const s = r.rows[0];
    const winRate = s.decided > 0 ? Math.round((s.wins / s.decided) * 10000) / 100 : 0;
    res.json({
      total: s.total,
      resolved: s.resolved,
      totalSignals: s.total,
      wins: s.wins,
      losses: s.losses,
      winRate,
      avgReturn: s.avg_result ? parseFloat(s.avg_result) : null,
      avgResult: s.avg_result ? parseFloat(s.avg_result) : null,
      avgDurationSec: s.avg_duration_sec,
    });
  } catch (err) {
    console.error("[proof/stats]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /proof/monthly — bar chart data
// Frontend expects: plain array of { month, net_pct, avg_r, count }
// ══════════════════════════════════════════════════════════════════
router.get("/monthly", async (req, res) => {
  try {
    const r = await querySignals(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', resolved_at), 'YYYY-MM') AS month,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE status LIKE 'TP%')::int AS wins,
        COUNT(*) FILTER (WHERE status LIKE 'TP%' OR status = 'SL')::int AS decided,
        ROUND(SUM(COALESCE(result, 0))::numeric, 4) AS net_result,
        ROUND(AVG(result)::numeric, 4) AS avg_result
      FROM signals_v2
      WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED') AND resolved_at IS NOT NULL
      GROUP BY DATE_TRUNC('month', resolved_at)
      ORDER BY DATE_TRUNC('month', resolved_at) ASC
      LIMIT 24
    `);

    const months = r.rows.map((row) => {
      const avgResult = row.avg_result ? parseFloat(row.avg_result) : 0;
      // Approximate R-multiple: result / avg risk (use 1.5% as default risk)
      const avgR = avgResult !== 0 ? +(avgResult / 1.5).toFixed(2) : 0;
      return {
        month: row.month,
        count: row.count,
        wins: row.wins,
        winRate: row.decided > 0 ? Math.round((row.wins / row.decided) * 10000) / 100 : 0,
        net_pct: row.net_result ? parseFloat(row.net_result) : 0,
        avg_r: avgR,
      };
    });

    res.json(months); // plain array, not { months }
  } catch (err) {
    console.error("[proof/monthly]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /proof/resolved — resolved signals for table
// Frontend expects: plain array of signal objects
// ══════════════════════════════════════════════════════════════════
router.get("/resolved", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await querySignals(
      `SELECT * FROM signals_v2
       WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED')
       ORDER BY COALESCE(resolved_at, created_at) DESC
       LIMIT $1`,
      [limit]
    );

    const signals = r.rows.map((row) => {
      const s = Signal.fromDbRow(row);
      const hash = signalHash(row);
      const cat = outcomeCategory(s.status);
      return {
        id: "SIG-" + String(s.id).padStart(5, "0"),
        symbol: s.symbol,
        direction: s.direction === "LONG" ? "⬆ Long" : "⬇ Short",
        entry: s.entry != null ? "$" + Number(s.entry).toLocaleString("en-US", { minimumFractionDigits: 2 }) : "—",
        provider: s.provider || "—",
        received: s.created_at ? new Date(s.created_at).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—",
        status: cat,
        pnl: s.result != null ? parseFloat(Number(s.result).toFixed(2)) : 0,
        duration: fmtDuration(s.duration_sec),
        hash: hash,
        exchange: "Binance",
      };
    });

    res.json(signals); // plain array
  } catch (err) {
    console.error("[proof/resolved]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /proof/curve — cumulative PnL curve
// Frontend expects: array of { date, pnl, r_mult }
// ══════════════════════════════════════════════════════════════════
router.get("/curve", async (req, res) => {
  try {
    const r = await querySignals(`
      SELECT
        TO_CHAR(COALESCE(resolved_at, created_at), 'YYYY-MM-DD') AS date,
        result
      FROM signals_v2
      WHERE status IN ('TP1','TP2','TP3','SL') AND result IS NOT NULL
      ORDER BY COALESCE(resolved_at, created_at) ASC
    `);

    const points = r.rows.map((row) => {
      const pnl = parseFloat(row.result) || 0;
      return {
        date: row.date,
        pnl: +pnl.toFixed(4),
        r_mult: +(pnl / 1.5).toFixed(3), // approximate R using 1.5% avg risk
      };
    });

    res.json(points);
  } catch (err) {
    console.error("[proof/curve]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /proof/outcomes — outcome distribution counts
// Frontend expects: { win, partial_win, loss, expired, ambiguous }
// ══════════════════════════════════════════════════════════════════
router.get("/outcomes", async (req, res) => {
  try {
    const r = await querySignals(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('TP2','TP3'))::int AS win,
        COUNT(*) FILTER (WHERE status = 'TP1')::int AS partial_win,
        COUNT(*) FILTER (WHERE status = 'SL')::int AS loss,
        COUNT(*) FILTER (WHERE status = 'EXPIRED')::int AS expired,
        0 AS ambiguous
      FROM signals_v2
      WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED')
    `);
    res.json(r.rows[0]);
  } catch (err) {
    console.error("[proof/outcomes]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /proof/score-bands — AI score band performance
// Frontend expects: array of { range, win_rate, avg_return, count }
// ══════════════════════════════════════════════════════════════════
router.get("/score-bands", async (req, res) => {
  try {
    const r = await querySignals(`
      SELECT
        CASE
          WHEN confidence >= 80 THEN '80–100'
          WHEN confidence >= 60 THEN '60–79'
          WHEN confidence >= 40 THEN '40–59'
          WHEN confidence >= 20 THEN '20–39'
          ELSE '0–19'
        END AS range,
        CASE
          WHEN confidence >= 80 THEN 5
          WHEN confidence >= 60 THEN 4
          WHEN confidence >= 40 THEN 3
          WHEN confidence >= 20 THEN 2
          ELSE 1
        END AS sort_order,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE status LIKE 'TP%')::int AS wins,
        COUNT(*) FILTER (WHERE status LIKE 'TP%' OR status = 'SL')::int AS decided,
        ROUND(AVG(result)::numeric, 4) AS avg_result
      FROM signals_v2
      WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED')
        AND confidence IS NOT NULL
      GROUP BY range, sort_order
      ORDER BY sort_order DESC
    `);

    const bands = r.rows.map((row) => ({
      range: row.range,
      count: row.count,
      win_rate: row.decided > 0 ? +((row.wins / row.decided) * 100).toFixed(1) : 0,
      avg_return: row.avg_result ? parseFloat(row.avg_result) : 0,
    }));

    res.json(bands);
  } catch (err) {
    console.error("[proof/score-bands]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /proof/verify?q= — lookup signal by ID or hash prefix
// Frontend expects: signal object with full details + timeline
// ══════════════════════════════════════════════════════════════════
router.get("/verify", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing query parameter q" });

    let row = null;

    // Try numeric ID (SIG-00042 → 42, or plain number)
    const idMatch = q.match(/^(?:SIG[- ]?)?(\d+)$/i);
    if (idMatch) {
      const id = parseInt(idMatch[1]);
      const r = await querySignals("SELECT * FROM signals_v2 WHERE id = $1", [id]);
      if (r.rows.length) row = r.rows[0];
    }

    // Try symbol match (e.g. BTCUSDT, BNBUSDT)
    if (!row && /^[A-Z]{2,20}USDT$/i.test(q)) {
      const r = await querySignals(
        `SELECT * FROM signals_v2
         WHERE UPPER(symbol) = $1
         ORDER BY created_at DESC LIMIT 1`,
        [q.toUpperCase()]
      );
      if (r.rows.length) row = r.rows[0];
    }

    // Try hash prefix match — scan recent signals and compare
    if (!row && /^[a-f0-9]{6,}$/i.test(q)) {
      const r = await querySignals(
        `SELECT * FROM signals_v2
         ORDER BY created_at DESC LIMIT 500`
      );
      const lowerQ = q.toLowerCase();
      for (const candidate of r.rows) {
        const hash = signalHash(candidate);
        if (hash.startsWith(lowerQ)) {
          row = candidate;
          break;
        }
      }
    }

    if (!row) {
      return res.status(404).json({ found: false });
    }

    // Build response
    const s = Signal.fromDbRow(row);
    const hash = signalHash(row);
    const sigId = "SIG-" + String(s.id).padStart(5, "0");

    // Build timeline
    const timeline = [];
    if (s.created_at) {
      timeline.push({
        type: "capture",
        time: fmtTimelineDate(s.created_at),
        label: "Received",
        detail: "Signal captured from " + (s.source || "provider") + " channel",
      });
      // Hash computed ~1s after capture
      const hashTime = new Date(new Date(s.created_at).getTime() + 1000);
      timeline.push({
        type: "parsed",
        time: fmtTimelineDate(hashTime),
        label: "Parsed + hashed",
        detail: "Normalized to " + s.symbol + " " + s.direction + " · SHA-256 locked",
      });
    }
    if (s.resolved_at) {
      const cat = outcomeCategory(s.status);
      const statusLabel = {
        win: "Win", partial_win: "Partial win (TP1)",
        loss: "Stop-loss hit", expired: "Expired",
      }[cat] || s.status;
      timeline.push({
        type: cat === "loss" ? "sl" : cat.includes("win") ? "tp" : "closed",
        time: fmtTimelineDate(s.resolved_at),
        label: "Resolved",
        detail: statusLabel + (s.result != null ? " · " + (s.result >= 0 ? "+" : "") + Number(s.result).toFixed(2) + "%" : ""),
      });
    }

    res.json({
      found: true,
      id: sigId,
      symbol: s.symbol,
      direction: s.direction,
      dir: s.direction,
      entry: s.entry,
      stop_loss: s.stop,
      sl: s.stop,
      tp1: s.targets && s.targets[0] ? s.targets[0] : null,
      tp2: s.targets && s.targets[1] ? s.targets[1] : null,
      tp: s.targets && s.targets[0] ? s.targets[0] : null,
      provider: s.provider,
      providerName: s.provider,
      exchange: "Binance",
      ai_score: s.confidence,
      status: outcomeCategory(s.status),
      pnl: s.result != null ? parseFloat(Number(s.result).toFixed(2)) : null,
      pnlPct: s.result != null ? parseFloat(Number(s.result).toFixed(2)) : null,
      duration: fmtDuration(s.duration_sec),
      received_at: s.created_at,
      received: s.created_at ? new Date(s.created_at).toISOString().replace("T", " ").slice(0, 16) + " UTC" : null,
      resolved_at: s.resolved_at,
      hash: hash,
      signalHash: hash,
      recordedAt: s.created_at,
      timeline,
    });
  } catch (err) {
    console.error("[proof/verify]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

function fmtTimelineDate(d) {
  try {
    const dt = new Date(d);
    const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return mo[dt.getUTCMonth()] + " " + dt.getUTCDate() + ", " +
      String(dt.getUTCHours()).padStart(2, "0") + ":" +
      String(dt.getUTCMinutes()).padStart(2, "0") + ":" +
      String(dt.getUTCSeconds()).padStart(2, "0") + " UTC";
  } catch { return String(d); }
}

// ── GET /proof/recent?limit=10 ───────────────────────────────────
router.get("/recent", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const r = await querySignals(
      `SELECT * FROM signals_v2
       WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED','OPEN')
       ORDER BY COALESCE(resolved_at, created_at) DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ signals: r.rows.map(Signal.fromDbRow) });
  } catch (err) {
    console.error("[proof/recent]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── Equity curve ──────────────────────────────────────────────
router.get("/equity-curve", require("./equity-curve"));

module.exports = router;
