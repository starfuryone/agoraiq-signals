/**
 * Stripe billing — fully standalone.
 * Uses bot_users.stripe_customer_id and bot_subscriptions.
 */

const { Router } = require("express");
const db = require("../lib/db");
const { requireAuth } = require("../middleware/auth");

let stripe = null;
function getStripe() {
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
    stripe = require("stripe")(key);
  }
  return stripe;
}

const PRICE_MAP = {
  pro:   { monthly: () => process.env.STRIPE_PRICE_PRO,        yearly: () => process.env.STRIPE_PRICE_PRO_YEARLY },
  elite: { monthly: () => process.env.STRIPE_PRICE_ELITE,      yearly: () => process.env.STRIPE_PRICE_ELITE_YEARLY },
};
const APP_URL = () => process.env.APP_URL || "https://bot.agoraiq.net";
const TIER_RANK = { free: 0, trial: 1, pro: 2, elite: 3 };

const router = Router();

// ── POST /billing/checkout ───────────────────────────────────────
router.post("/checkout", requireAuth, async (req, res) => {
  try {
    const { plan, period } = req.body;
    const cycle = period === "yearly" ? "yearly" : "monthly";
    const priceId = PRICE_MAP[plan]?.[cycle]?.();
    if (!priceId) {
      return res.status(400).json({ error: `Invalid plan/period: ${plan}/${cycle}` });
    }

    const customerId = await ensureStripeCustomer(req.userId);

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL()}/pricing.html?session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: `${APP_URL()}/pricing.html?status=cancelled`,
      metadata: { bot_user_id: String(req.userId), plan_tier: plan },
      subscription_data: { metadata: { bot_user_id: String(req.userId), plan_tier: plan } },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("[billing/checkout]", err.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ── POST /billing/portal ─────────────────────────────────────────
router.post("/portal", requireAuth, async (req, res) => {
  try {
    // ensureStripeCustomer creates a Stripe customer if one doesn't exist yet
    const customerId = await ensureStripeCustomer(req.userId);
    if (!customerId) return res.status(404).json({ error: "No billing account found" });

    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${APP_URL()}/pricing.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("[billing/portal]", err.message);
    res.status(500).json({ error: "Failed to create portal session" });
  }
});

// ── GET /billing/status ──────────────────────────────────────────
router.get("/status", requireAuth, async (req, res) => {
  try {
    res.json(await resolveEntitlement(req.userId));
  } catch (err) {
    console.error("[billing/status]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ═════════════════════════════════════════════════════════════════
//  WEBHOOK — mounted separately with express.raw() in index.js
// ═════════════════════════════════════════════════════════════════
async function webhookHandler(req, res) {
  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !secret) return res.status(400).json({ error: "Missing signature" });

  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("[stripe/webhook] sig failed:", err.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  // Idempotency
  try {
    const dup = await db.query("SELECT 1 FROM payment_events WHERE stripe_event_id = $1", [event.id]);
    if (dup.rows.length > 0) return res.json({ received: true, duplicate: true });
  } catch {}

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        const uid = parseInt(s.metadata?.bot_user_id);
        const plan = s.metadata?.plan_tier || "pro";
        if (uid && s.subscription) {
          await activateSub(uid, plan, s.subscription);
          console.log(`[stripe] activated ${plan} for bot_user ${uid}`);
        }
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const uid = parseInt(sub.metadata?.bot_user_id);
        if (!uid) break;
        if (sub.cancel_at_period_end) {
          await db.query(
            `UPDATE bot_subscriptions SET status = 'cancel_at_period_end',
             expires_at = to_timestamp($1), updated_at = NOW()
             WHERE bot_user_id = $2 AND stripe_sub_id = $3`,
            [sub.current_period_end, uid, sub.id]
          );
        } else if (sub.status === "active") {
          await db.query(
            `UPDATE bot_subscriptions SET status = 'active',
             expires_at = to_timestamp($1), updated_at = NOW()
             WHERE bot_user_id = $2 AND stripe_sub_id = $3`,
            [sub.current_period_end, uid, sub.id]
          );
        } else if (sub.status === "past_due") {
          await db.query(
            `UPDATE bot_subscriptions SET status = 'past_due', updated_at = NOW()
             WHERE bot_user_id = $1 AND stripe_sub_id = $2`, [uid, sub.id]
          );
        }
        invalidateCache(uid);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const uid = parseInt(sub.metadata?.bot_user_id);
        if (uid) {
          await db.query(
            `UPDATE bot_subscriptions SET status = 'expired', updated_at = NOW()
             WHERE bot_user_id = $1 AND stripe_sub_id = $2`, [uid, sub.id]
          );
          invalidateCache(uid);
        }
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object;
        if (inv.subscription) {
          await db.query(
            `UPDATE bot_subscriptions SET status = 'past_due', updated_at = NOW()
             WHERE stripe_sub_id = $1`, [inv.subscription]
          );
          const ur = await db.query(
            "SELECT bot_user_id FROM bot_subscriptions WHERE stripe_sub_id = $1", [inv.subscription]
          );
          if (ur.rows[0]) invalidateCache(ur.rows[0].bot_user_id);
        }
        break;
      }
    }

    await db.query(
      `INSERT INTO payment_events (stripe_event_id, event_type, provider, payload, created_at)
       VALUES ($1, $2, 'stripe', $3, NOW()) ON CONFLICT (stripe_event_id) DO NOTHING`,
      [event.id, event.type, JSON.stringify(event.data.object)]
    ).catch(() => {});

    res.json({ received: true });
  } catch (err) {
    console.error("[stripe/webhook]", err.message);
    res.status(500).json({ error: "Webhook processing failed" });
  }
}

// ── Entitlement ──────────────────────────────────────────────────
async function resolveEntitlement(botUserId) {
  const r = await db.query(
    `SELECT plan_tier, status, started_at, expires_at, stripe_sub_id
     FROM bot_subscriptions WHERE bot_user_id = $1
     ORDER BY started_at DESC LIMIT 5`, [botUserId]
  );

  if (r.rows.length === 0) {
    return { plan: "free", status: "none", entitled: false, paidAccess: false, provider: null };
  }

  const prioritized = r.rows.sort((a, b) => {
    const sr = { active: 3, cancel_at_period_end: 2, past_due: 1 };
    const d = (sr[b.status] || 0) - (sr[a.status] || 0);
    return d !== 0 ? d : (TIER_RANK[b.plan_tier] || 0) - (TIER_RANK[a.plan_tier] || 0);
  });

  const best = prioritized[0];
  let entitled = false, effectivePlan = "free";

  if (best.status === "active") { entitled = true; effectivePlan = best.plan_tier; }
  else if (best.plan_tier === "trial" && best.expires_at && new Date() < new Date(best.expires_at)) {
    entitled = true; effectivePlan = "trial";
  }
  else if (best.status === "cancel_at_period_end") {
    if (best.expires_at && new Date(best.expires_at) > new Date()) {
      entitled = true; effectivePlan = best.plan_tier;
    }
  } else if (best.status === "past_due" && best.expires_at) {
    const grace = new Date(best.expires_at);
    grace.setDate(grace.getDate() + 3);
    if (new Date() < grace) { entitled = true; effectivePlan = best.plan_tier; }
  }

  return {
    plan: effectivePlan, status: best.status, entitled,
    paidAccess: entitled && !["free","trial"].includes(effectivePlan),
    startedAt: best.started_at, expiresAt: best.expires_at,
    provider: best.stripe_sub_id ? "stripe" : "manual",
  };
}

// ── Helpers ──────────────────────────────────────────────────────
async function ensureStripeCustomer(botUserId) {
  const r = await db.query("SELECT stripe_customer_id, email FROM bot_users WHERE id = $1", [botUserId]);
  if (!r.rows.length) throw new Error("User not found");
  const user = r.rows[0];
  if (user.stripe_customer_id) return user.stripe_customer_id;

  const customer = await getStripe().customers.create({
    email: user.email, metadata: { bot_user_id: String(botUserId) },
  });
  await db.query("UPDATE bot_users SET stripe_customer_id = $1 WHERE id = $2", [customer.id, botUserId]);
  return customer.id;
}

async function getStripeCustomerId(botUserId) {
  const r = await db.query("SELECT stripe_customer_id FROM bot_users WHERE id = $1", [botUserId]);
  return r.rows[0]?.stripe_customer_id || null;
}

async function activateSub(botUserId, plan, stripeSubId) {
  await db.query(
    `INSERT INTO bot_subscriptions (bot_user_id, plan_tier, status, stripe_sub_id, started_at, updated_at)
     VALUES ($1, $2, 'active', $3, NOW(), NOW())
     ON CONFLICT (bot_user_id) DO UPDATE SET
       plan_tier = EXCLUDED.plan_tier, status = 'active', stripe_sub_id = EXCLUDED.stripe_sub_id,
       started_at = NOW(), expires_at = NULL, updated_at = NOW()`,
    [botUserId, plan, stripeSubId]
  );
  invalidateCache(botUserId);
}

function invalidateCache(botUserId) {
  try {
    const { getRedis } = require("../lib/redis");
    const redis = getRedis();
    if (redis) redis.del(`sub:${botUserId}`).catch(() => {});
  } catch {}
}

module.exports = { router, webhookHandler, resolveEntitlement };
