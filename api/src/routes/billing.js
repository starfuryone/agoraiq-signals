/**
 * Stripe billing — fully standalone.
 * Uses bot_users.stripe_customer_id and bot_subscriptions.
 */

const { Router } = require("express");
const crypto = require("crypto");
const db = require("../lib/db");
const { requireAuth } = require("../middleware/auth");
const { invalidateCache: invalidatePlanCache } = require("../middleware/subscription");
const txlog = require("../lib/transaction-log");
const telegram = require("../lib/telegram");

// ── Confirmation helpers ────────────────────────────────────────
function generateConfirmationId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `AQ-${ts}-${rand}`;
}

async function getTelegramChatId(botUserId) {
  const r = await db.query(
    `SELECT telegram_id FROM bot_telegram_accounts
     WHERE bot_user_id = $1 AND unlinked_at IS NULL LIMIT 1`,
    [botUserId]
  );
  return r.rows[0]?.telegram_id || null;
}

async function sendBillingConfirmation(botUserId, details) {
  try {
    const chatId = await getTelegramChatId(botUserId);
    if (!chatId) {
      console.warn(`[billing/tg] no telegram linked for bot_user ${botUserId} — skipping confirmation`);
      return;
    }

    const lines = [
      `✅ <b>AgoraIQ Billing Confirmation</b>`,
      ``,
      `<b>Confirmation #:</b> <code>${details.confirmationId}</code>`,
      `<b>Date:</b> ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`,
      ``,
    ];

    const planLabel = `<b>${(details.plan || "").toUpperCase()}</b> (${details.period || "monthly"})`;

    if (details.direction === "upgrade") {
      lines.push(`🚀 <b>Upgrade Confirmed</b>`);
      lines.push(`You've been upgraded to ${planLabel}.`);
      lines.push(`Your new plan is active immediately.`);
      if (details.from) {
        lines.push(`Previous plan: ${details.from.plan.toUpperCase()} (${details.from.period})`);
      }
      lines.push(`Prorated charges apply for the remainder of this billing period.`);

    } else if (details.direction === "downgrade") {
      lines.push(`📋 <b>Downgrade Scheduled</b>`);
      lines.push(`You've requested a switch to ${planLabel}.`);
      if (details.from) {
        lines.push(`Your current <b>${details.from.plan.toUpperCase()}</b> plan remains active until it expires.`);
      }
      if (details.effectiveAt) {
        lines.push(`The new plan takes effect on <b>${details.effectiveAt}</b>.`);
      }
      lines.push(`You'll continue to have full access to your current features until then.`);

    } else if (details.direction === "switch_interval" && details.period === "yearly") {
      lines.push(`🔄 <b>Billing Switch Confirmed</b>`);
      lines.push(`You've switched to ${planLabel}.`);
      lines.push(`The change is effective immediately with prorated billing.`);

    } else if (details.direction === "switch_interval" && details.period === "monthly") {
      lines.push(`🔄 <b>Billing Switch Scheduled</b>`);
      lines.push(`You've requested a switch to ${planLabel}.`);
      if (details.effectiveAt) {
        lines.push(`Your current yearly billing continues until <b>${details.effectiveAt}</b>.`);
        lines.push(`Monthly billing begins after that date.`);
      }

    } else {
      // New subscription (from webhook)
      lines.push(`🎉 <b>Subscription Active</b>`);
      lines.push(`Welcome to ${planLabel}!`);
      lines.push(`Your subscription is now active.`);
    }

    lines.push(``);
    lines.push(`Manage your subscription anytime at:`);
    lines.push(`https://bot.agoraiq.net/pricing.html`);
    lines.push(``);
    lines.push(`<i>AgoraIQ — ChatLogic Insights LTD</i>`);

    const result = await telegram.send(chatId, lines.join("\n"));
    if (result.ok) {
      console.log(`[billing/tg] confirmation ${details.confirmationId} sent to chat ${chatId}`);
    } else {
      console.warn(`[billing/tg] send failed for chat ${chatId}:`, result);
    }
  } catch (err) {
    console.error(`[billing/tg] sendBillingConfirmation error for user ${botUserId}:`, err.message);
  }
}

async function sendEmailConfirmation(email, details) {
  // Uses Brevo transactional API if configured
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn("[billing/email] BREVO_API_KEY not set — email confirmation skipped");
    return { sent: false, reason: "email not configured" };
  }

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#00d4ff;margin-bottom:4px">AgoraIQ Billing Confirmation</h2>
      <p style="color:#666;font-size:14px;margin-bottom:20px">Confirmation ID: <strong>${details.confirmationId}</strong></p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:8px 0;color:#888">Action</td><td style="padding:8px 0">${details.action}</td></tr>
        <tr><td style="padding:8px 0;color:#888">Plan</td><td style="padding:8px 0">${details.plan.toUpperCase()} (${details.period})</td></tr>
        <tr><td style="padding:8px 0;color:#888">Effective</td><td style="padding:8px 0">${details.effectiveAt || "Immediately"}</td></tr>
        ${details.from ? `<tr><td style="padding:8px 0;color:#888">Previous</td><td style="padding:8px 0">${details.from.plan.toUpperCase()} (${details.from.period})</td></tr>` : ""}
      </table>
      <p style="color:#999;font-size:12px;margin-top:24px">&copy; ${new Date().getFullYear()} ChatLogic Insights LTD. All rights reserved.</p>
    </div>`;

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { name: "AgoraIQ", email: process.env.BREVO_SENDER_EMAIL || "noreply@agoraiq.net" },
        to: [{ email }],
        subject: `AgoraIQ Billing Confirmation — ${details.confirmationId}`,
        htmlContent: html,
      }),
    });
    if (res.ok) return { sent: true };
    const err = await res.json().catch(() => ({}));
    console.error("[billing/email]", err.message || res.status);
    return { sent: false, reason: err.message || "send failed" };
  } catch (err) {
    console.error("[billing/email]", err.message);
    return { sent: false, reason: err.message };
  }
}

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
const TRIAL_DAYS = (() => {
  const n = parseInt(process.env.STRIPE_TRIAL_DAYS ?? "1", 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
})();

// ── Startup validation: confirm every configured price exists in Stripe ──
let _pricesValidated = null;
async function validatePriceIds() {
  if (_pricesValidated) return _pricesValidated;
  const plans = ["pro", "elite"];
  const cycles = ["monthly", "yearly"];
  const missing = [];
  const invalid = [];
  for (const plan of plans) {
    for (const cycle of cycles) {
      const id = PRICE_MAP[plan][cycle]();
      if (!id) { missing.push(`${plan}/${cycle}`); continue; }
      try {
        await getStripe().prices.retrieve(id);
      } catch (err) {
        invalid.push(`${plan}/${cycle} (${id}): ${err.message}`);
      }
    }
  }
  _pricesValidated = { missing, invalid, checkedAt: new Date().toISOString() };
  if (missing.length || invalid.length) {
    console.error("[billing/startup] PRICE VALIDATION FAILED:",
      { missing, invalid });
  } else {
    console.log("[billing/startup] all Stripe price IDs validated");
  }
  return _pricesValidated;
}

// ── Price catalog (cached from Stripe, single source of truth for UI) ──
let _priceCatalog = null;
let _priceCatalogAt = 0;
const PRICE_CATALOG_TTL_MS = 60 * 60 * 1000; // 1h

async function getPriceCatalog() {
  if (_priceCatalog && (Date.now() - _priceCatalogAt) < PRICE_CATALOG_TTL_MS) {
    return _priceCatalog;
  }
  const plans = ["pro", "elite"];
  const cycles = ["monthly", "yearly"];
  const out = { currency: "usd", trialDays: TRIAL_DAYS, plans: {} };
  for (const plan of plans) {
    out.plans[plan] = {};
    for (const cycle of cycles) {
      const id = PRICE_MAP[plan][cycle]();
      if (!id) { out.plans[plan][cycle] = null; continue; }
      try {
        const price = await getStripe().prices.retrieve(id);
        out.currency = price.currency || out.currency;
        out.plans[plan][cycle] = {
          priceId: price.id,
          unitAmount: price.unit_amount,
          currency: price.currency,
          interval: price.recurring?.interval || null,
          intervalCount: price.recurring?.interval_count || 1,
        };
      } catch (err) {
        console.warn(`[billing/prices] retrieve failed for ${plan}/${cycle}:`, err.message);
        out.plans[plan][cycle] = null;
      }
    }
  }
  _priceCatalog = out;
  _priceCatalogAt = Date.now();
  return out;
}

// ── Audit log ──────────────────────────────────────────────────
async function writeAudit(entry) {
  try {
    await db.query(
      `INSERT INTO subscription_audit_log
         (bot_user_id, stripe_sub_id, action, from_plan, from_period,
          to_plan, to_period, actor, source, stripe_event_id, reason, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        entry.botUserId || null,
        entry.stripeSubId || null,
        entry.action,
        entry.fromPlan || null,
        entry.fromPeriod || null,
        entry.toPlan || null,
        entry.toPeriod || null,
        entry.actor || null,
        entry.source || null,
        entry.stripeEventId || null,
        entry.reason || null,
        JSON.stringify(entry.meta || {}),
      ]
    );
  } catch (err) {
    console.error("[billing/audit] write failed:", err.message);
  }
}

// ── Idempotency on checkout submissions ────────────────────────
function hashRequest(body) {
  const canon = JSON.stringify({
    plan: body.plan,
    period: body.period,
    source: body.source || null,
  });
  return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

async function checkIdempotency(botUserId, key, body) {
  if (!key) return { hit: false };
  const r = await db.query(
    `SELECT response, request_hash FROM billing_checkout_idempotency
     WHERE bot_user_id = $1 AND idempotency_key = $2`,
    [botUserId, key]
  );
  if (r.rows.length === 0) return { hit: false };
  const prevHash = r.rows[0].request_hash;
  const curHash = hashRequest(body);
  if (prevHash && prevHash !== curHash) {
    return { hit: true, conflict: true };
  }
  return { hit: true, response: r.rows[0].response };
}

async function storeIdempotency(botUserId, key, body, response) {
  if (!key) return;
  try {
    await db.query(
      `INSERT INTO billing_checkout_idempotency (bot_user_id, idempotency_key, request_hash, response)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (bot_user_id, idempotency_key) DO NOTHING`,
      [botUserId, key, hashRequest(body), JSON.stringify(response)]
    );
  } catch (err) {
    console.warn("[billing/idem] store failed:", err.message);
  }
}

// ── Schedule tracking ──────────────────────────────────────────
async function recordSchedule(entry) {
  try {
    await db.query(
      `INSERT INTO subscription_schedules
         (bot_user_id, stripe_sub_id, stripe_schedule_id,
          from_plan, from_period, to_plan, to_period, effective_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
       ON CONFLICT (stripe_schedule_id) DO UPDATE SET
         from_plan = EXCLUDED.from_plan, from_period = EXCLUDED.from_period,
         to_plan = EXCLUDED.to_plan, to_period = EXCLUDED.to_period,
         effective_at = EXCLUDED.effective_at,
         status = 'pending', released_at = NULL, applied_at = NULL,
         updated_at = NOW()`,
      [
        entry.botUserId, entry.stripeSubId, entry.stripeScheduleId,
        entry.fromPlan, entry.fromPeriod, entry.toPlan, entry.toPeriod,
        entry.effectiveAt,
      ]
    );
  } catch (err) {
    console.error("[billing/schedule] recordSchedule failed:", err.message);
  }
}

async function markScheduleApplied(stripeScheduleId) {
  try {
    await db.query(
      `UPDATE subscription_schedules
       SET status = 'applied', applied_at = NOW(), updated_at = NOW()
       WHERE stripe_schedule_id = $1 AND status = 'pending'`,
      [stripeScheduleId]
    );
  } catch (err) {
    console.warn("[billing/schedule] markApplied failed:", err.message);
  }
}

async function markSchedulesReleased(stripeSubId) {
  try {
    await db.query(
      `UPDATE subscription_schedules
       SET status = 'released', released_at = NOW(), updated_at = NOW()
       WHERE stripe_sub_id = $1 AND status = 'pending'`,
      [stripeSubId]
    );
  } catch (err) {
    console.warn("[billing/schedule] markReleased failed:", err.message);
  }
}

async function findPendingScheduleForSub(stripeSubId) {
  try {
    const r = await db.query(
      `SELECT stripe_schedule_id, to_plan, to_period
       FROM subscription_schedules
       WHERE stripe_sub_id = $1 AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
      [stripeSubId]
    );
    return r.rows[0] || null;
  } catch {
    return null;
  }
}

// ── Consent — single source of truth ────────────────────────────
const CONSENT_VERSION = "1.0";
const CONSENT_DOCUMENTS = [
  { id: "subscription-agreement", label: "Subscription Agreement", url: "/subscription-agreement.html" },
  { id: "terms",                  label: "Terms",                  url: "/terms.html" },
  { id: "privacy",                label: "Privacy",                url: "/privacy.html" },
  { id: "cookies",                label: "Cookies",                url: "/cookies.html" },
  { id: "no-financial-advice",    label: "No Financial Advice",    url: "/no-financial-advice.html" },
];
const REQUIRED_CONSENT_DOCS = CONSENT_DOCUMENTS.map(d => d.id);

function validateConsent(consent) {
  if (!consent || typeof consent !== "object") {
    return { valid: false, reason: "consent object required" };
  }
  if (consent.accepted !== true) {
    return { valid: false, reason: "consent must be accepted" };
  }
  if (!consent.timestamp || isNaN(Date.parse(consent.timestamp))) {
    return { valid: false, reason: "valid consent timestamp required" };
  }
  if (consent.version !== CONSENT_VERSION) {
    return { valid: false, reason: `consent version mismatch: expected "${CONSENT_VERSION}", got "${consent.version}"` };
  }
  if (!Array.isArray(consent.documents)) {
    return { valid: false, reason: "consent documents array required" };
  }
  const sorted = [...consent.documents].sort();
  const expected = [...REQUIRED_CONSENT_DOCS].sort();
  if (sorted.length !== expected.length || !sorted.every((id, i) => id === expected[i])) {
    return { valid: false, reason: `consent documents mismatch` };
  }
  return { valid: true };
}

async function persistConsent(botUserId, consent, plan, cycle, ip, email) {
  try {
    await db.query(
      `INSERT INTO consent_log (bot_user_id, version, documents, accepted_at, plan, period, ip_address, email, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT DO NOTHING`,
      [botUserId, consent.version, JSON.stringify(consent.documents), consent.timestamp, plan, cycle, ip || null, email || null]
    );
  } catch (err) {
    // Log but don't block checkout
    console.error("[billing/consent] persist error:", err.message);
  }
}

const router = Router();

// ── GET /billing/consent-config — public, no auth ──────────────
router.get("/consent-config", (req, res) => {
  res.json({ version: CONSENT_VERSION, documents: CONSENT_DOCUMENTS });
});

// ── GET /billing/prices — public, cached Stripe price catalog ──
// Single source of truth for displayed prices. Pricing page and bot
// MUST render from this — no hardcoded amounts.
router.get("/prices", async (req, res) => {
  try {
    const cat = await getPriceCatalog();
    res.json(cat);
  } catch (err) {
    console.error("[billing/prices]", err.message);
    res.status(503).json({ error: "Price catalog unavailable" });
  }
});

// ── POST /billing/preview-upgrade — proration preview (upgrade or downgrade) ──
router.post("/preview-upgrade", requireAuth, async (req, res) => {
  try {
    const { plan, period } = req.body;
    const cycle = period === "yearly" ? "yearly" : "monthly";
    const priceId = PRICE_MAP[plan]?.[cycle]?.();
    if (!priceId) {
      return res.status(400).json({ error: `Invalid plan/period: ${plan}/${cycle}` });
    }

    const customerId = await ensureStripeCustomer(req.userId);

    const existingSub = await db.query(
      `SELECT stripe_sub_id, plan_tier, billing_period FROM bot_subscriptions
       WHERE bot_user_id = $1 AND status = 'active' LIMIT 1`,
      [req.userId]
    );

    if (existingSub.rows.length === 0) {
      return res.json({ isNewSubscription: true, plan, period: cycle });
    }

    const currentTier = existingSub.rows[0].plan_tier;
    const currentPeriod = await resolveStripePeriod(
      existingSub.rows[0].stripe_sub_id, existingSub.rows[0].billing_period
    );

    if (plan === currentTier && cycle === currentPeriod) {
      return res.status(400).json({ error: `Already on ${plan} ${cycle}` });
    }

    let direction;
    if (plan === currentTier)                          direction = "switch_interval";
    else if (TIER_RANK[plan] > TIER_RANK[currentTier]) direction = "upgrade";
    else                                                direction = "downgrade";

    const subId = existingSub.rows[0].stripe_sub_id;
    const sub = await getStripe().subscriptions.retrieve(subId);

    const preview = await getStripe().invoices.retrieveUpcoming({
      customer: customerId,
      subscription: subId,
      subscription_items: [{ id: sub.items.data[0].id, price: priceId }],
      subscription_proration_behavior: "create_prorations",
    });

    // Extract meaningful line items
    const lines = preview.lines.data.map(line => ({
      description: line.description,
      amount: line.amount,          // in cents (negative = credit)
      currency: line.currency,
      proration: line.proration || false,
    }));

    const periodEnd = sub.current_period_end;

    // Split line items into credits vs charges so the UI can render
    // downgrade refunds (credits) explicitly instead of burying them.
    let creditTotal = 0, chargeTotal = 0;
    for (const ln of lines) {
      if (ln.amount < 0) creditTotal += ln.amount;
      else chargeTotal += ln.amount;
    }

    // For scheduled downgrades the upcoming invoice can include a
    // next-period charge that isn't due today. Surface the at-renewal
    // amount separately so users understand when the credit lands.
    const renewalTotal = direction === "downgrade"
      ? lines
          .filter(ln => !ln.proration)
          .reduce((sum, ln) => sum + ln.amount, 0)
      : null;

    res.json({
      isNewSubscription: false,
      direction: direction,
      currentPlan: currentTier,
      currentPeriod: currentPeriod,
      newPlan: plan,
      period: cycle,
      lines: lines,
      amountDue: preview.amount_due,           // cents
      subtotal: preview.subtotal,               // cents
      currency: preview.currency,
      immediateCharge: preview.amount_due > 0,
      creditTotal,                              // cents (<= 0)
      chargeTotal,                              // cents (>= 0)
      renewalTotal,                             // cents — downgrade only
      currentPeriodEnd: periodEnd,
    });
  } catch (err) {
    console.error("[billing/preview-change]", err.message);
    res.status(500).json({ error: "Failed to generate plan change preview" });
  }
});

// ── POST /billing/checkout ───────────────────────────────────────
router.post("/checkout", requireAuth, async (req, res) => {
  try {
    const { plan, period, consent } = req.body;
    const cycle = period === "yearly" ? "yearly" : "monthly";
    const priceId = PRICE_MAP[plan]?.[cycle]?.();
    if (!priceId) {
      // Misconfigured env — distinguish from a malformed request so
      // misconfiguration doesn't masquerade as user error.
      if (!PRICE_MAP[plan]) {
        return res.status(400).json({ error: `Invalid plan: ${plan}` });
      }
      console.error(`[billing/checkout] missing price env for ${plan}/${cycle}`);
      return res.status(503).json({ error: "Billing temporarily unavailable" });
    }

    // Validate consent
    const cc = validateConsent(consent);
    if (!cc.valid) {
      console.warn(`[billing/checkout] consent rejected for user ${req.userId}: ${cc.reason}`);
      return res.status(400).json({ error: cc.reason });
    }

    // Idempotency — client-supplied key dedupes retries so a double-click
    // can't produce two Stripe subscriptions or double-apply an upgrade.
    const idemKey =
      req.headers["idempotency-key"] || req.headers["x-idempotency-key"] || req.body.idempotencyKey;
    if (idemKey) {
      const prev = await checkIdempotency(req.userId, idemKey, req.body);
      if (prev.hit) {
        if (prev.conflict) {
          return res.status(409).json({ error: "Idempotency key reused with different payload" });
        }
        return res.json(prev.response);
      }
    }

    const customerId = await ensureStripeCustomer(req.userId);

    // ── Check for existing subscription to handle plan changes ──
    const existingSub = await db.query(
      `SELECT stripe_sub_id, plan_tier, billing_period FROM bot_subscriptions
       WHERE bot_user_id = $1 AND status = 'active' LIMIT 1`,
      [req.userId]
    );

    if (existingSub.rows.length > 0) {
      const currentTier = existingSub.rows[0].plan_tier;
      const currentPeriod = await resolveStripePeriod(
        existingSub.rows[0].stripe_sub_id, existingSub.rows[0].billing_period
      );

      // Same plan + same period = no change needed
      if (plan === currentTier && cycle === currentPeriod) {
        return res.status(400).json({ error: "You are already on this plan" });
      }

      const subId = existingSub.rows[0].stripe_sub_id;
      let direction;
      if (plan === currentTier)                          direction = "switch_interval";
      else if (TIER_RANK[plan] > TIER_RANK[currentTier]) direction = "upgrade";
      else                                                direction = "downgrade";

      const sub = await getStripe().subscriptions.retrieve(subId);

      // ── Immediate changes: upgrades + monthly→yearly same tier ──
      // These benefit the customer now, so apply with proration.
      const isImmediateSwitch = direction === "switch_interval" && cycle === "yearly";
      if (direction === "upgrade" || isImmediateSwitch) {
        // Release any existing schedule (e.g. user had pending downgrade, now upgrading)
        await releaseExistingSchedule(subId);
        await markSchedulesReleased(subId);

        await getStripe().subscriptions.update(subId, {
          items: [{ id: sub.items.data[0].id, price: priceId }],
          proration_behavior: "create_prorations",
          metadata: { bot_user_id: String(req.userId), plan_tier: plan, consent_version: consent.version },
        });
        await db.query(
          `UPDATE bot_subscriptions SET plan_tier = $1, billing_period = $2,
           pending_plan_tier = NULL, pending_billing_period = NULL, updated_at = NOW()
           WHERE stripe_sub_id = $3`,
          [plan, cycle, subId]
        );
        await db.query(`UPDATE bot_users SET role = $1 WHERE id = $2`, [plan, req.userId]);
        await persistConsent(req.userId, consent, plan, cycle, req.ip, req.userEmail || null);
        invalidatePlanCache(req.userId);
        console.log(`[billing/checkout] ${direction} ${currentTier}/${currentPeriod} → ${plan}/${cycle} for user ${req.userId} (immediate)`);
        const confirmId = generateConfirmationId();
        sendBillingConfirmation(req.userId, {
          confirmationId: confirmId, direction,
          plan, period: cycle,
          from: { plan: currentTier, period: currentPeriod },
        });
        txlog.record(direction === "upgrade" ? "upgrade_immediate" : "switch_yearly_immediate", {
          botUserId: req.userId, stripeCustomerId: customerId, stripeSubId: subId,
          confirmationId: confirmId,
          from: { plan: currentTier, period: currentPeriod },
          to: { plan, period: cycle },
          consentVersion: consent.version,
        });
        await writeAudit({
          botUserId: req.userId, stripeSubId: subId,
          action: direction === "upgrade" ? "upgrade_immediate" : "switch_yearly_immediate",
          fromPlan: currentTier, fromPeriod: currentPeriod,
          toPlan: plan, toPeriod: cycle,
          actor: `bot_user:${req.userId}`,
          source: req.body.source || "web",
          meta: { confirmationId: confirmId, consentVersion: consent.version },
        });
        const payload = { changed: true, direction, plan, period: cycle, subscriptionId: subId, confirmationId: confirmId };
        await storeIdempotency(req.userId, idemKey, req.body, payload);
        return res.json(payload);
      }

      // ── Scheduled changes: downgrades + yearly→monthly ──
      // Keep current entitlement until period end, then change.
      const currentPriceId = sub.items.data[0].price.id;
      const effectiveAt = sub.current_period_end; // unix timestamp

      // Release any existing schedule first (user changing their mind).
      await releaseExistingSchedule(subId);
      await markSchedulesReleased(subId);

      // Create subscription schedule: current plan now, new plan at renewal
      const schedule = await getStripe().subscriptionSchedules.create({
        from_subscription: subId,
      });
      await getStripe().subscriptionSchedules.update(schedule.id, {
        end_behavior: "release",
        phases: [
          {
            items: [{ price: currentPriceId, quantity: 1 }],
            start_date: sub.current_period_start,
            end_date: sub.current_period_end,
          },
          {
            items: [{ price: priceId, quantity: 1 }],
          },
        ],
      });

      // Durable schedule record — authoritative source for "did this
      // scheduled change take effect?" queries, not bot_subscriptions.pending_*.
      await recordSchedule({
        botUserId: req.userId,
        stripeSubId: subId,
        stripeScheduleId: schedule.id,
        fromPlan: currentTier, fromPeriod: currentPeriod,
        toPlan: plan, toPeriod: cycle,
        effectiveAt: new Date(effectiveAt * 1000).toISOString(),
      });

      // Mirror to bot_subscriptions.pending_* for existing UI display.
      await db.query(
        `UPDATE bot_subscriptions
         SET pending_plan_tier = $1, pending_billing_period = $2, updated_at = NOW()
         WHERE stripe_sub_id = $3`,
        [plan, cycle, subId]
      );
      await persistConsent(req.userId, consent, plan, cycle, req.ip, req.userEmail || null);
      invalidatePlanCache(req.userId);
      console.log(`[billing/checkout] ${direction} ${currentTier}/${currentPeriod} → ${plan}/${cycle} for user ${req.userId} (scheduled at ${new Date(effectiveAt * 1000).toISOString()})`);
      const confirmId = generateConfirmationId();
      sendBillingConfirmation(req.userId, {
        confirmationId: confirmId, direction,
        plan, period: cycle,
        from: { plan: currentTier, period: currentPeriod },
        effectiveAt: new Date(effectiveAt * 1000).toISOString().slice(0, 10),
      });
      txlog.record(direction === "downgrade" ? "downgrade_scheduled" : "switch_monthly_scheduled", {
        botUserId: req.userId, stripeCustomerId: customerId, stripeSubId: subId,
        confirmationId: confirmId,
        scheduleId: schedule.id,
        from: { plan: currentTier, period: currentPeriod },
        to: { plan, period: cycle },
        effectiveAt: new Date(effectiveAt * 1000).toISOString(),
        consentVersion: consent.version,
      });
      await writeAudit({
        botUserId: req.userId, stripeSubId: subId,
        action: direction === "downgrade" ? "downgrade_scheduled" : "switch_monthly_scheduled",
        fromPlan: currentTier, fromPeriod: currentPeriod,
        toPlan: plan, toPeriod: cycle,
        actor: `bot_user:${req.userId}`,
        source: req.body.source || "web",
        meta: {
          confirmationId: confirmId,
          stripeScheduleId: schedule.id,
          effectiveAt: new Date(effectiveAt * 1000).toISOString(),
          consentVersion: consent.version,
        },
      });
      const payload = {
        scheduled: true, direction, plan, period: cycle,
        effectiveAt: new Date(effectiveAt * 1000).toISOString(),
        subscriptionId: subId,
        confirmationId: confirmId,
      };
      await storeIdempotency(req.userId, idemKey, req.body, payload);
      return res.json(payload);
    }

    // ── New subscription (no existing active subscription) ──
    const subData = {
      metadata: { bot_user_id: String(req.userId), plan_tier: plan, billing_period: cycle },
    };
    if (TRIAL_DAYS > 0) subData.trial_period_days = TRIAL_DAYS;

    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL()}/${req.body.source==="telegram"?"success":"welcome"}.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL()}/pricing.html?status=cancelled`,
      metadata: { bot_user_id: String(req.userId), plan_tier: plan, billing_period: cycle, consent_version: consent.version },
      subscription_data: subData,
    });

    await persistConsent(req.userId, consent, plan, cycle, req.ip, req.userEmail || null);
    txlog.record("checkout_new", {
      botUserId: req.userId, stripeCustomerId: customerId,
      stripeSessionId: session.id,
      plan, period: cycle,
      consentVersion: consent.version,
    });
    await writeAudit({
      botUserId: req.userId,
      action: "checkout_new",
      toPlan: plan, toPeriod: cycle,
      actor: `bot_user:${req.userId}`,
      source: req.body.source || "web",
      meta: { stripeSessionId: session.id, consentVersion: consent.version, trialDays: TRIAL_DAYS },
    });
    const payload = { url: session.url, sessionId: session.id, trialDays: TRIAL_DAYS };
    await storeIdempotency(req.userId, idemKey, req.body, payload);
    res.json(payload);
  } catch (err) {
    console.error("[billing/checkout]", err.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ── POST /billing/portal ─────────────────────────────────────────
router.post("/portal", requireAuth, async (req, res) => {
  try {
    const customerId = await getStripeCustomerId(req.userId);
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

// ── POST /billing/email-confirmation — send confirmation to email ──
router.post("/email-confirmation", requireAuth, async (req, res) => {
  try {
    const { email, confirmationId, plan, period, direction, effectiveAt } = req.body;
    if (!email || !confirmationId) {
      return res.status(400).json({ error: "email and confirmationId required" });
    }

    const actionLabels = {
      upgrade: "Upgrade", downgrade: "Downgrade (scheduled)",
      switch_interval: period === "yearly" ? "Switch to Yearly" : "Switch to Monthly (scheduled)",
      new: "New Subscription",
    };

    const result = await sendEmailConfirmation(email, {
      confirmationId,
      action: actionLabels[direction] || "Plan Change",
      plan: plan || "pro",
      period: period || "monthly",
      effectiveAt: effectiveAt || null,
    });

    if (result.sent) {
      console.log(`[billing/email] confirmation ${confirmationId} sent to ${email}`);
      res.json({ sent: true });
    } else {
      res.status(500).json({ error: "Could not send email", reason: result.reason });
    }
  } catch (err) {
    console.error("[billing/email-confirmation]", err.message);
    res.status(500).json({ error: "Failed to send email confirmation" });
  }
});

// ── GET /billing/status ──────────────────────────────────────────
router.get("/status", requireAuth, async (req, res) => {
  try {
    const ent = await resolveEntitlement(req.userId);
    // Resolve billing period from Stripe if not stored in DB yet
    if (!ent.period && ent.stripeSubId) {
      ent.period = await resolveStripePeriod(ent.stripeSubId, null);
    }
    res.json(ent);
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

  // Idempotency — record the event row first so a parallel delivery
  // of the same event can't double-process while we're working.
  try {
    const claim = await db.query(
      `INSERT INTO payment_events (stripe_event_id, event_type, provider, payload, created_at)
       VALUES ($1, $2, 'stripe', $3, NOW())
       ON CONFLICT (stripe_event_id) DO NOTHING
       RETURNING id`,
      [event.id, event.type, JSON.stringify(event.data.object)]
    );
    if (claim.rows.length === 0) {
      return res.json({ received: true, duplicate: true });
    }
  } catch (err) {
    console.error("[stripe/webhook] claim failed:", err.message);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        const uid = parseInt(s.metadata?.bot_user_id);
        const plan = s.metadata?.plan_tier || "pro";
        if (uid && s.subscription) {
          const period = await resolveStripePeriod(s.subscription, null);
          // Dedupe customer: if this uid already has a different stripe_customer_id,
          // keep the stored one and flag the duplicate so ops can reconcile.
          await reconcileStripeCustomer(uid, s.customer, event.id);
          await activateSub(uid, plan, s.subscription, period);
          console.log(`[stripe] activated ${plan}/${period || "?"} for bot_user ${uid}`);
          const confirmId = generateConfirmationId();
          sendBillingConfirmation(uid, {
            confirmationId: confirmId, action: "New Subscription",
            plan, period: period || "monthly",
          });
          txlog.record("webhook_activated", {
            botUserId: uid, stripeSubId: s.subscription,
            stripeCustomerId: s.customer,
            confirmationId: confirmId,
            plan, period,
            stripeEventId: event.id,
          });
          await writeAudit({
            botUserId: uid, stripeSubId: s.subscription,
            action: "webhook_activated",
            toPlan: plan, toPeriod: period,
            actor: "stripe", source: "webhook",
            stripeEventId: event.id,
            meta: { stripeCustomerId: s.customer, confirmationId: confirmId },
          });
        } else if (!uid && s.subscription && s.customer) {
          // ── Cold-visitor path: match email to an already-verified
          // bot_users row. Do NOT mint a new account on an unverified email —
          // a spoofed webhook (if signing secret ever leaks or rotates) must
          // not yield an entitlement-bearing account.
          try {
            const customer = await getStripe().customers.retrieve(s.customer);
            const email = customer.email || s.customer_details?.email;
            if (!email) {
              console.warn("[stripe/webhook] cold visitor: no email in Stripe payload");
              await writeAudit({
                action: "webhook_cold_visitor_no_email",
                actor: "stripe", source: "webhook",
                stripeEventId: event.id,
                meta: { stripeCustomerId: s.customer, stripeSubId: s.subscription },
              });
              break;
            }

            const userRow = await db.query(
              "SELECT id, email_verified FROM bot_users WHERE email = $1",
              [email]
            );
            if (userRow.rows.length === 0) {
              // Defer activation — no verified account exists yet. The
              // subscription stays parked on the Stripe customer; when
              // the user completes magic-link verification we attach the
              // sub via /auth/magic-link/verify → reconcileStripeCustomer.
              console.warn(`[stripe/webhook] cold visitor: no verified bot_users for ${email}; deferring activation`);
              await writeAudit({
                action: "webhook_cold_visitor_deferred",
                actor: "stripe", source: "webhook",
                stripeEventId: event.id,
                meta: {
                  email, stripeCustomerId: s.customer,
                  stripeSubId: s.subscription, plan,
                  reason: "no verified account",
                },
              });
              break;
            }

            const existing = userRow.rows[0];
            if (!existing.email_verified) {
              console.warn(`[stripe/webhook] cold visitor: ${email} exists but is not verified; deferring activation`);
              await writeAudit({
                botUserId: existing.id,
                action: "webhook_cold_visitor_deferred",
                actor: "stripe", source: "webhook",
                stripeEventId: event.id,
                meta: {
                  email, stripeCustomerId: s.customer,
                  stripeSubId: s.subscription, plan,
                  reason: "email not verified",
                },
              });
              break;
            }

            const newUserId = existing.id;
            await reconcileStripeCustomer(newUserId, s.customer, event.id);
            const period = await resolveStripePeriod(s.subscription, null);
            await activateSub(newUserId, plan, s.subscription, period);
            console.log(`[stripe/webhook] cold visitor: activated ${plan}/${period || "?"} for bot_user ${newUserId} (${email})`);

            const confirmId = generateConfirmationId();
            await sendEmailConfirmation(email, {
              confirmationId: confirmId, action: "New Subscription",
              plan, period: period || "monthly",
            });
            txlog.record("webhook_cold_visitor_activated", {
              botUserId: newUserId, email,
              stripeSubId: s.subscription, stripeCustomerId: s.customer,
              confirmationId: confirmId, plan, period,
              stripeEventId: event.id,
            });
            await writeAudit({
              botUserId: newUserId, stripeSubId: s.subscription,
              action: "webhook_cold_visitor_activated",
              toPlan: plan, toPeriod: period,
              actor: "stripe", source: "webhook",
              stripeEventId: event.id,
              meta: { email, stripeCustomerId: s.customer, confirmationId: confirmId },
            });
          } catch (coldErr) {
            console.error("[stripe/webhook] cold visitor error:", coldErr.message);
          }
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
          txlog.record("webhook_cancel_scheduled", {
            botUserId: uid, stripeSubId: sub.id,
            expiresAt: new Date(sub.current_period_end * 1000).toISOString(),
            stripeEventId: event.id,
          });
          await writeAudit({
            botUserId: uid, stripeSubId: sub.id,
            action: "webhook_cancel_scheduled",
            actor: "stripe", source: "webhook",
            stripeEventId: event.id,
            meta: { expiresAt: new Date(sub.current_period_end * 1000).toISOString() },
          });
        } else if (sub.status === "active") {
          // Authoritative "did the scheduled change take effect?" lookup:
          // subscription_schedules, not price-ID equality (prices rotate).
          const pending = await findPendingScheduleForSub(sub.id);
          const currentPriceId = sub.items.data[0]?.price?.id;
          const pendingPriceId = pending
            ? PRICE_MAP[pending.to_plan]?.[pending.to_period === "yearly" ? "yearly" : "monthly"]?.()
            : null;

          if (pending && pendingPriceId && currentPriceId === pendingPriceId) {
            // Scheduled change has taken effect.
            await db.query(
              `UPDATE bot_subscriptions SET plan_tier = $1, billing_period = $2,
               pending_plan_tier = NULL, pending_billing_period = NULL,
               status = 'active', expires_at = to_timestamp($3), updated_at = NOW()
               WHERE bot_user_id = $4 AND stripe_sub_id = $5`,
              [pending.to_plan, pending.to_period, sub.current_period_end, uid, sub.id]
            );
            await db.query(`UPDATE bot_users SET role = $1 WHERE id = $2`, [pending.to_plan, uid]);
            await markScheduleApplied(pending.stripe_schedule_id);
            console.log(`[stripe/webhook] scheduled change applied: ${pending.to_plan} for bot_user ${uid}`);
            txlog.record("webhook_scheduled_applied", {
              botUserId: uid, stripeSubId: sub.id,
              plan: pending.to_plan, period: pending.to_period,
              stripeEventId: event.id,
            });
            await writeAudit({
              botUserId: uid, stripeSubId: sub.id,
              action: "webhook_scheduled_applied",
              toPlan: pending.to_plan, toPeriod: pending.to_period,
              actor: "stripe", source: "webhook",
              stripeEventId: event.id,
              meta: { stripeScheduleId: pending.stripe_schedule_id },
            });
          } else {
            await db.query(
              `UPDATE bot_subscriptions SET status = 'active',
               expires_at = to_timestamp($1), updated_at = NOW()
               WHERE bot_user_id = $2 AND stripe_sub_id = $3`,
              [sub.current_period_end, uid, sub.id]
            );
          }
        } else if (sub.status === "past_due") {
          await db.query(
            `UPDATE bot_subscriptions SET status = 'past_due', updated_at = NOW()
             WHERE bot_user_id = $1 AND stripe_sub_id = $2`, [uid, sub.id]
          );
          await writeAudit({
            botUserId: uid, stripeSubId: sub.id,
            action: "webhook_sub_past_due",
            actor: "stripe", source: "webhook",
            stripeEventId: event.id,
          });
        }
        invalidatePlanCache(uid);
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
          await markSchedulesReleased(sub.id);
          txlog.record("webhook_deleted", {
            botUserId: uid, stripeSubId: sub.id, stripeEventId: event.id,
          });
          await writeAudit({
            botUserId: uid, stripeSubId: sub.id,
            action: "webhook_sub_deleted",
            actor: "stripe", source: "webhook",
            stripeEventId: event.id,
          });
          invalidatePlanCache(uid);
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
          const failedUid = ur.rows[0]?.bot_user_id;
          const attempt = inv.attempt_count || null;
          const nextAttempt = inv.next_payment_attempt
            ? new Date(inv.next_payment_attempt * 1000).toISOString()
            : null;
          txlog.record("webhook_payment_failed", {
            botUserId: failedUid || null,
            stripeSubId: inv.subscription,
            amountDue: inv.amount_due,
            currency: inv.currency,
            attempt, nextAttempt,
            stripeEventId: event.id,
          });
          await writeAudit({
            botUserId: failedUid || null, stripeSubId: inv.subscription,
            action: "webhook_payment_failed",
            actor: "stripe", source: "webhook",
            stripeEventId: event.id,
            meta: {
              amountDue: inv.amount_due, currency: inv.currency,
              attempt, nextAttempt, hostedInvoiceUrl: inv.hosted_invoice_url || null,
            },
          });
          if (failedUid) {
            invalidatePlanCache(failedUid);
            // Dunning notification — tell the user their payment failed
            // and give them a direct link to retry via Stripe's hosted invoice.
            sendPaymentFailedNotice(failedUid, inv).catch((e) =>
              console.error("[billing/dunning]", e.message)
            );
          }
        }
        break;
      }
      case "invoice.payment_succeeded": {
        const inv = event.data.object;
        if (inv.subscription) {
          const ur = await db.query(
            "SELECT bot_user_id FROM bot_subscriptions WHERE stripe_sub_id = $1",
            [inv.subscription]
          );
          const uid = ur.rows[0]?.bot_user_id;
          if (uid) {
            await db.query(
              `UPDATE bot_subscriptions SET status = 'active', updated_at = NOW()
               WHERE stripe_sub_id = $1`, [inv.subscription]
            );
            invalidatePlanCache(uid);
            await writeAudit({
              botUserId: uid, stripeSubId: inv.subscription,
              action: "webhook_payment_succeeded",
              actor: "stripe", source: "webhook",
              stripeEventId: event.id,
              meta: { amountPaid: inv.amount_paid, currency: inv.currency },
            });
          }
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("[stripe/webhook]", err.message);
    res.status(500).json({ error: "Webhook processing failed" });
  }
}

// ── Dunning: Telegram notification on payment failure ──
async function sendPaymentFailedNotice(botUserId, inv) {
  try {
    const chatId = await getTelegramChatId(botUserId);
    if (!chatId) return;
    const amount = typeof inv.amount_due === "number"
      ? `${(inv.amount_due / 100).toFixed(2)} ${(inv.currency || "usd").toUpperCase()}`
      : "your subscription amount";
    const nextAttempt = inv.next_payment_attempt
      ? new Date(inv.next_payment_attempt * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric" })
      : null;
    const lines = [
      `⚠️ <b>Payment Failed</b>`,
      ``,
      `We couldn't charge ${amount} for your AgoraIQ subscription.`,
    ];
    if (nextAttempt) lines.push(`We'll retry automatically on <b>${nextAttempt}</b>.`);
    if (inv.hosted_invoice_url) {
      lines.push(``);
      lines.push(`To pay now or update your card: <a href="${inv.hosted_invoice_url}">retry payment</a>`);
    } else {
      lines.push(``);
      lines.push(`Update your card at ${APP_URL()}/pricing.html`);
    }
    lines.push(``);
    lines.push(`Your access continues during our grace period. After that, premium features will pause until payment succeeds.`);
    await telegram.send(chatId, lines.join("\n"));
  } catch (err) {
    console.warn("[billing/dunning] send failed:", err.message);
  }
}

// ── Stripe customer reconciliation — detect duplicates across
// accidental re-creates and audit mismatches for ops review. ──
async function reconcileStripeCustomer(botUserId, stripeCustomerId, stripeEventId) {
  if (!botUserId || !stripeCustomerId) return;
  try {
    const r = await db.query(
      "SELECT stripe_customer_id FROM bot_users WHERE id = $1",
      [botUserId]
    );
    const stored = r.rows[0]?.stripe_customer_id;
    if (!stored) {
      await db.query(
        "UPDATE bot_users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL",
        [stripeCustomerId, botUserId]
      );
      return;
    }
    if (stored !== stripeCustomerId) {
      console.warn(
        `[billing/dedupe] stripe_customer mismatch for bot_user ${botUserId}: stored=${stored}, incoming=${stripeCustomerId}`
      );
      await writeAudit({
        botUserId,
        action: "stripe_customer_mismatch",
        actor: "stripe", source: "webhook",
        stripeEventId,
        meta: { stored, incoming: stripeCustomerId },
      });
    }
  } catch (err) {
    console.warn("[billing/dedupe] reconcile failed:", err.message);
  }
}

// ── Entitlement ──────────────────────────────────────────────────
async function resolveEntitlement(botUserId) {
  const r = await db.query(
    `SELECT plan_tier, billing_period, status, started_at, expires_at, stripe_sub_id,
            pending_plan_tier, pending_billing_period
     FROM bot_subscriptions WHERE bot_user_id = $1
     ORDER BY started_at DESC LIMIT 5`, [botUserId]
  );

  if (r.rows.length === 0) {
    return { plan: "free", period: null, status: "none", entitled: false, paidAccess: false, provider: null };
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

  const pendingChange = (best.pending_plan_tier)
    ? { plan: best.pending_plan_tier, period: best.pending_billing_period || null }
    : null;

  return {
    plan: effectivePlan, status: best.status, entitled,
    paidAccess: entitled && !["free","trial"].includes(effectivePlan),
    period: best.billing_period || null,
    stripeSubId: best.stripe_sub_id || null,
    startedAt: best.started_at, expiresAt: best.expires_at,
    provider: best.stripe_sub_id ? "stripe" : "manual",
    pendingChange,
  };
}

// ── Helpers ──────────────────────────────────────────────────────

// Resolve billing period from Stripe when not stored in DB
async function resolveStripePeriod(stripeSubId, dbPeriod) {
  if (dbPeriod) return dbPeriod;
  if (!stripeSubId) return null;
  try {
    const sub = await getStripe().subscriptions.retrieve(stripeSubId);
    const interval = sub.items.data[0]?.price?.recurring?.interval;
    return interval === "year" ? "yearly" : "monthly";
  } catch { return null; }
}

async function releaseExistingSchedule(stripeSubId) {
  try {
    const sub = await getStripe().subscriptions.retrieve(stripeSubId);
    if (!sub.schedule) return; // No schedule attached
    const sched = await getStripe().subscriptionSchedules.retrieve(sub.schedule);
    if (sched.status === "active" || sched.status === "not_started") {
      await getStripe().subscriptionSchedules.release(sched.id);
      console.log(`[billing] released schedule ${sched.id} for sub ${stripeSubId}`);
    }
  } catch (err) {
    console.warn("[billing] releaseExistingSchedule:", err.message);
  }
}

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

async function activateSub(botUserId, plan, stripeSubId, billingPeriod) {
  await db.query(
    `INSERT INTO bot_subscriptions (bot_user_id, plan_tier, billing_period, status, stripe_sub_id, started_at, updated_at)
     VALUES ($1, $2, $3, 'active', $4, NOW(), NOW())
     ON CONFLICT (bot_user_id) DO UPDATE SET
       plan_tier = EXCLUDED.plan_tier, billing_period = EXCLUDED.billing_period,
       status = 'active', stripe_sub_id = EXCLUDED.stripe_sub_id,
       started_at = NOW(), expires_at = NULL, updated_at = NOW()`,
    [botUserId, plan, billingPeriod, stripeSubId]
  );
  invalidatePlanCache(botUserId);
}

// ── Plan inference from Stripe price ID ────────────────────────
// Used when the subscription's metadata doesn't carry plan_tier (the
// common case for cold-visitor Stripe Checkout where our metadata is
// attached at session level but not on the subscription itself).
function inferPlanFromPriceId(priceId) {
  if (!priceId) return null;
  for (const plan of Object.keys(PRICE_MAP)) {
    for (const cycle of Object.keys(PRICE_MAP[plan])) {
      if (PRICE_MAP[plan][cycle]() === priceId) {
        return { plan, period: cycle };
      }
    }
  }
  return null;
}

// ── Attach deferred subscriptions for a just-verified email ───
// Called when a user completes email-ownership proof (magic-link). The
// webhook previously refused to activate these subs because the email
// was unverified; now we find them in Stripe and activate.
//
// Scan strategy: first look up the user's stored stripe_customer_id;
// then ask Stripe for every customer with this email (covers the
// "Stripe auto-created a duplicate customer during public checkout"
// case). We never mint a user here — the auth caller already owns one.
async function attachSubscriptionByEmail(botUserId, email, opts = {}) {
  if (!botUserId || !email) return { attached: 0 };
  const source = opts.source || "email_verify";
  let attached = 0;
  try {
    const seen = new Set();
    const candidates = [];

    const row = await db.query(
      "SELECT stripe_customer_id FROM bot_users WHERE id = $1",
      [botUserId]
    );
    if (row.rows[0]?.stripe_customer_id) {
      candidates.push({ id: row.rows[0].stripe_customer_id });
      seen.add(row.rows[0].stripe_customer_id);
    }

    try {
      const byEmail = await getStripe().customers.list({ email, limit: 10 });
      for (const c of byEmail.data) {
        if (!seen.has(c.id)) { candidates.push(c); seen.add(c.id); }
      }
    } catch (err) {
      console.warn("[billing/attach] customers.list failed:", err.message);
    }

    for (const customer of candidates) {
      let subs;
      try {
        subs = await getStripe().subscriptions.list({
          customer: customer.id, status: "all", limit: 20,
        });
      } catch (err) {
        console.warn("[billing/attach] subscriptions.list failed:", err.message);
        continue;
      }
      for (const sub of subs.data) {
        if (!["active", "trialing", "past_due"].includes(sub.status)) continue;

        // Skip if this sub is already bound to some other bot_user.
        const already = await db.query(
          "SELECT bot_user_id FROM bot_subscriptions WHERE stripe_sub_id = $1",
          [sub.id]
        );
        if (already.rows[0] && already.rows[0].bot_user_id !== botUserId) {
          console.warn(
            `[billing/attach] sub ${sub.id} already bound to bot_user ${already.rows[0].bot_user_id}; skipping for bot_user ${botUserId}`
          );
          await writeAudit({
            botUserId, stripeSubId: sub.id,
            action: "attach_conflict",
            actor: "system", source,
            meta: { email, otherBotUserId: already.rows[0].bot_user_id, stripeCustomerId: customer.id },
          });
          continue;
        }

        const priceId = sub.items.data[0]?.price?.id;
        const inferred = inferPlanFromPriceId(priceId);
        const plan = sub.metadata?.plan_tier || inferred?.plan || "pro";
        const period =
          sub.metadata?.billing_period ||
          (sub.items.data[0]?.price?.recurring?.interval === "year" ? "yearly" : "monthly");

        await reconcileStripeCustomer(botUserId, customer.id);
        await activateSub(botUserId, plan, sub.id, period);

        // Rewrite the subscription metadata so future webhooks carry
        // bot_user_id and we don't take the cold-visitor path again.
        try {
          await getStripe().subscriptions.update(sub.id, {
            metadata: {
              ...(sub.metadata || {}),
              bot_user_id: String(botUserId),
              plan_tier: plan,
              billing_period: period,
            },
          });
        } catch (err) {
          console.warn("[billing/attach] subscription metadata update failed:", err.message);
        }

        await writeAudit({
          botUserId, stripeSubId: sub.id,
          action: "attach_on_email_verify",
          toPlan: plan, toPeriod: period,
          actor: "system", source,
          meta: { email, stripeCustomerId: customer.id, priceId, stripeSubStatus: sub.status },
        });
        attached++;
      }
    }
  } catch (err) {
    console.error("[billing/attach]", err.message);
    return { attached, error: err.message };
  }
  return { attached };
}



// ── Public checkout for cold visitors (no auth required) ──
// The returned Checkout session is useless for entitlement until the
// resulting email is verified via magic-link — the webhook refuses to
// mint or activate accounts for unverified emails.
router.post("/public-checkout", async (req, res) => {
  try {
    const { plan, period, consent } = req.body;
    const cycle = period === "yearly" ? "yearly" : "monthly";
    const priceId = PRICE_MAP[plan]?.[cycle]?.();
    if (!priceId) {
      if (!PRICE_MAP[plan]) {
        return res.status(400).json({ error: `Invalid plan: ${plan}` });
      }
      return res.status(503).json({ error: "Billing temporarily unavailable" });
    }

    const cc = validateConsent(consent);
    if (!cc.valid) return res.status(400).json({ error: cc.reason });

    const subData = {
      metadata: { plan_tier: plan, billing_period: cycle },
    };
    if (TRIAL_DAYS > 0) subData.trial_period_days = TRIAL_DAYS;

    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL()}/welcome.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL()}/pricing.html?status=cancelled`,
      metadata: { plan_tier: plan, billing_period: cycle, consent_version: consent.version, source: "web_cold" },
      subscription_data: subData,
    });

    await writeAudit({
      action: "public_checkout_new",
      toPlan: plan, toPeriod: cycle,
      actor: "anonymous", source: "web_cold",
      meta: { stripeSessionId: session.id, consentVersion: consent.version, trialDays: TRIAL_DAYS },
    });

    res.json({ url: session.url, sessionId: session.id, trialDays: TRIAL_DAYS });
  } catch (err) {
    console.error("[billing/public-checkout]", err.message);
    res.status(500).json({ error: "Checkout failed" });
  }
});

module.exports = {
  router,
  webhookHandler,
  resolveEntitlement,
  validatePriceIds,
  getPriceCatalog,
  attachSubscriptionByEmail,
};
