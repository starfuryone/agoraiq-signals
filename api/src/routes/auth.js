/**
 * Auth routes — standalone, no shared users table.
 *
 * POST /auth/register    — email + password
 * POST /auth/login       — email + password → JWT
 * POST /auth/magic-link  — send magic link to email (placeholder)
 * POST /auth/logout      — no-op (client discards token)
 * GET  /auth/me          — current user + subscription
 */

const { Router } = require("express");
const db = require("../lib/db");
const pw = require("../lib/password");
const { requireAuth, issueToken } = require("../middleware/auth");
const { getUserTier } = require("../middleware/subscription");

const router = Router();

// ─────────────────────────────────────────────────────────────────
// POST /auth/register
// Body: { email, password }
// ─────────────────────────────────────────────────────────────────
router.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password required" });
    }

    const trimEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimEmail)) {
      return res.status(400).json({ error: "Invalid email format" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    // Check existing
    const existing = await db.query(
      "SELECT id FROM bot_users WHERE email = $1", [trimEmail]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const hash = await pw.hash(password);
    const result = await db.query(
      `INSERT INTO bot_users (email, password_hash, auth_provider)
       VALUES ($1, $2, 'local')
       RETURNING id, email, role, created_at`,
      [trimEmail, hash]
    );

    const user = result.rows[0];

    // Grant 1-day free trial — no Stripe subscription, time-limited access
    await db.query(
      `INSERT INTO bot_subscriptions (bot_user_id, plan_tier, status, expires_at)
       VALUES ($1, 'trial', 'active', NOW() + INTERVAL '1 day')
       ON CONFLICT (bot_user_id) DO NOTHING`,
      [user.id]
    );

    const token = issueToken(user.id, user.email);

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        planTier: "trial",
      },
    });
  } catch (err) {
    console.error("[auth/register]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /auth/login
// Body: { email, password }
// ─────────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password required" });
    }

    const trimEmail = email.trim().toLowerCase();
    const result = await db.query(
      "SELECT id, email, password_hash, role FROM bot_users WHERE email = $1",
      [trimEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = result.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ error: "Account uses magic link login" });
    }

    const valid = await pw.verify(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const tier = await getUserTier(user.id);
    const token = issueToken(user.id, user.email);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        planTier: tier,
      },
    });
  } catch (err) {
    console.error("[auth/login]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /auth/magic-link
// Body: { email }
// Placeholder: generates token, logs it, doesn't send email yet.
// Wire up Brevo/SES later.
// ─────────────────────────────────────────────────────────────────
router.post("/magic-link", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "email required" });

    const trimEmail = email.trim().toLowerCase();

    // Find or create user
    let userId;
    const existing = await db.query(
      "SELECT id FROM bot_users WHERE email = $1", [trimEmail]
    );
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
    } else {
      const newUser = await db.query(
        `INSERT INTO bot_users (email, auth_provider)
         VALUES ($1, 'magic_link')
         RETURNING id`,
        [trimEmail]
      );
      userId = newUser.rows[0].id;
      // Grant 1-day free trial — no Stripe subscription
      await db.query(
        `INSERT INTO bot_subscriptions (bot_user_id, plan_tier, status, expires_at)
         VALUES ($1, 'trial', 'active', NOW() + INTERVAL '1 day')
         ON CONFLICT (bot_user_id) DO NOTHING`,
        [userId]
      );
    }

    // Generate one-time token
    const rawToken = pw.randomToken();
    const tokenHash = pw.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    await db.query(
      `INSERT INTO bot_sessions (bot_user_id, token_hash, purpose, expires_at)
       VALUES ($1, $2, 'magic_link', $3)`,
      [userId, tokenHash, expiresAt]
    );

    // TODO: Send email via Brevo/SES with link containing rawToken
    // For now, log it (dev only)
    if (process.env.NODE_ENV !== "production") {
      console.log(`[magic-link] token for ${trimEmail}: ${rawToken}`);
    }

    res.json({ ok: true, message: "If this email exists, a login link has been sent." });
  } catch (err) {
    console.error("[auth/magic-link]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /auth/magic-link/verify
// Body: { token }
// ─────────────────────────────────────────────────────────────────
router.post("/magic-link/verify", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    const tokenHash = pw.hashToken(token);
    const result = await db.query(
      `SELECT s.id, s.bot_user_id, u.email, u.role
       FROM bot_sessions s
       JOIN bot_users u ON u.id = s.bot_user_id
       WHERE s.token_hash = $1
         AND s.purpose = 'magic_link'
         AND s.used_at IS NULL
         AND s.expires_at > NOW()`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid or expired link" });
    }

    const session = result.rows[0];

    // Mark token as used
    await db.query(
      "UPDATE bot_sessions SET used_at = NOW() WHERE id = $1",
      [session.id]
    );

    const tier = await getUserTier(session.bot_user_id);
    const jwt = issueToken(session.bot_user_id, session.email);

    res.json({
      token: jwt,
      user: {
        id: session.bot_user_id,
        email: session.email,
        role: session.role,
        planTier: tier,
      },
    });
  } catch (err) {
    console.error("[auth/magic-link/verify]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /auth/logout — no-op, client discards token
// ─────────────────────────────────────────────────────────────────
router.post("/logout", (req, res) => {
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────
// GET /auth/me — current user + subscription
// ─────────────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT id, email, role, created_at FROM bot_users WHERE id = $1",
      [req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];
    const tier = await getUserTier(user.id);

    // Check telegram link
    const tg = await db.query(
      `SELECT telegram_id, telegram_username FROM bot_telegram_accounts
       WHERE bot_user_id = $1 AND unlinked_at IS NULL`,
      [user.id]
    );

    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        createdAt: user.created_at,
      },
      subscription: { planTier: tier },
      telegram: tg.rows[0] || null,
    });
  } catch (err) {
    console.error("[auth/me]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /auth/telegram-auth — bot-only: issue JWT for a linked telegram user
// Body: { telegram_id }
// Security: localhost + shared internal secret (INTERNAL_API_SECRET)
// ─────────────────────────────────────────────────────────────────
router.post("/telegram-auth", async (req, res) => {
  try {
    // Restrict to localhost
    const ip = req.ip || req.connection?.remoteAddress;
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
      return res.status(403).json({ error: "Localhost only" });
    }

    // Require internal shared secret
    const internalSecret = process.env.INTERNAL_API_SECRET;
    if (internalSecret) {
      const provided = req.headers["x-internal-auth"];
      if (provided !== internalSecret) {
        return res.status(403).json({ error: "Invalid internal auth" });
      }
    }

    const { telegram_id } = req.body;
    if (!telegram_id) return res.status(400).json({ error: "telegram_id required" });

    const result = await db.query(
      `SELECT u.id, u.email, u.role
       FROM bot_users u
       JOIN bot_telegram_accounts t ON t.bot_user_id = u.id
       WHERE t.telegram_id = $1 AND t.unlinked_at IS NULL`,
      [telegram_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No linked account for this telegram_id" });
    }

    const user = result.rows[0];
    const tier = await getUserTier(user.id);
    const token = issueToken(user.id, user.email);

    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role, planTier: tier },
    });
  } catch (err) {
    console.error("[auth/telegram-auth]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /auth/token-login?auth=xxx — one-time push auth token
// ─────────────────────────────────────────────────────────────────
router.get("/token-login", async (req, res) => {
  try {
    const { auth } = req.query;
    if (!auth) return res.status(400).json({ error: "auth token required" });

    const tokenHash = require("../lib/password").hashToken(auth);
    const result = await db.query(
      `SELECT s.id, s.bot_user_id, u.email, u.role
       FROM bot_sessions s
       JOIN bot_users u ON u.id = s.bot_user_id
       WHERE s.token_hash = $1
         AND s.purpose = 'push_auth'
         AND s.used_at IS NULL
         AND s.expires_at > NOW()`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const session = result.rows[0];
    await db.query("UPDATE bot_sessions SET used_at = NOW() WHERE id = $1", [session.id]);

    const { getUserTier } = require("../middleware/subscription");
    const tier = await getUserTier(session.bot_user_id);
    const token = issueToken(session.bot_user_id, session.email);

    res.json({
      token,
      user: { id: session.bot_user_id, email: session.email, role: session.role, planTier: tier },
    });
  } catch (err) {
    console.error("[auth/token-login]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;