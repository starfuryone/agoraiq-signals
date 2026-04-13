/**
 * Telegram link routes — standalone.
 * Uses bot_telegram_accounts, never touches shared users table.
 *
 * POST /telegram/link/start    — generate one-time link code
 * POST /telegram/link/confirm  — claim code, bind telegram_id to bot_user
 * DELETE /telegram/link        — unlink telegram
 * GET  /telegram/status        — check link status
 */

const { Router } = require("express");
const crypto = require("crypto");
const db = require("../lib/db");
const { requireAuth } = require("../middleware/auth");

const router = Router();

// In-memory code store (short-lived, single-instance safe)
// For multi-instance: move to Redis
const _codes = new Map();
const CODE_TTL = 5 * 60 * 1000; // 5 minutes

function generateCode() {
  return crypto.randomBytes(16).toString("hex");
}

// ── POST /telegram/link/start ────────────────────────────────────
// Called by the bot when user types /connect.
// Body: { telegram_id, telegram_username }
// Returns: { code, link }
router.post("/link/start", async (req, res) => {
  try {
    const { telegram_id, telegram_username } = req.body;
    if (!telegram_id) {
      return res.status(400).json({ error: "telegram_id required" });
    }

    // Check if already linked
    const existing = await db.query(
      `SELECT bot_user_id FROM bot_telegram_accounts
       WHERE telegram_id = $1 AND unlinked_at IS NULL`,
      [telegram_id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Telegram already linked to an account" });
    }

    const code = generateCode();
    _codes.set(code, {
      telegram_id: parseInt(telegram_id),
      telegram_username: telegram_username || null,
      created: Date.now(),
    });

    // Clean expired codes
    for (const [k, v] of _codes) {
      if (Date.now() - v.created > CODE_TTL) _codes.delete(k);
    }

    const appUrl = process.env.APP_URL || "https://bot.agoraiq.net";
    res.json({
      code,
      link: `${appUrl}/link.html?code=${code}`,
      expires_in: CODE_TTL / 1000,
    });
  } catch (err) {
    console.error("[telegram/link/start]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── POST /telegram/link/confirm ──────────────────────────────────
// Called by the web UI after user clicks the link while logged in.
// Body: { code }
// Requires auth (binds to the logged-in bot_user).
router.post("/link/confirm", requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "code required" });

    const entry = _codes.get(code);
    if (!entry) {
      return res.status(404).json({ error: "Invalid or expired code" });
    }
    if (Date.now() - entry.created > CODE_TTL) {
      _codes.delete(code);
      return res.status(410).json({ error: "Code expired" });
    }

    // Consume code
    _codes.delete(code);

    // Check if telegram_id is already linked to someone else
    const existing = await db.query(
      `SELECT bot_user_id FROM bot_telegram_accounts
       WHERE telegram_id = $1 AND unlinked_at IS NULL`,
      [entry.telegram_id]
    );
    if (existing.rows.length > 0 && existing.rows[0].bot_user_id !== req.userId) {
      return res.status(409).json({ error: "This Telegram account is linked to another user" });
    }

    // Unlink any previous telegram for this user
    await db.query(
      `UPDATE bot_telegram_accounts SET unlinked_at = NOW()
       WHERE bot_user_id = $1 AND unlinked_at IS NULL`,
      [req.userId]
    );

    // Create link
    await db.query(
      `INSERT INTO bot_telegram_accounts (bot_user_id, telegram_id, telegram_username)
       VALUES ($1, $2, $3)`,
      [req.userId, entry.telegram_id, entry.telegram_username]
    );

    res.json({
      ok: true,
      telegram_id: entry.telegram_id,
      telegram_username: entry.telegram_username,
    });
  } catch (err) {
    console.error("[telegram/link/confirm]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── DELETE /telegram/link ────────────────────────────────────────
router.delete("/link", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE bot_telegram_accounts SET unlinked_at = NOW()
       WHERE bot_user_id = $1 AND unlinked_at IS NULL
       RETURNING telegram_id`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No linked Telegram account" });
    }

    res.json({ ok: true, unlinked_telegram_id: result.rows[0].telegram_id });
  } catch (err) {
    console.error("[telegram/link/delete]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── GET /telegram/status ─────────────────────────────────────────
router.get("/status", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT telegram_id, telegram_username, linked_at
       FROM bot_telegram_accounts
       WHERE bot_user_id = $1 AND unlinked_at IS NULL`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.json({ linked: false });
    }

    const row = result.rows[0];
    res.json({
      linked: true,
      telegram_id: row.telegram_id,
      telegram_username: row.telegram_username,
      linked_at: row.linked_at,
    });
  } catch (err) {
    console.error("[telegram/status]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
