/**
 * Stripe billing — fully standalone.
 * Uses bot_users.stripe_customer_id and bot_subscriptions.
 */

const { Router } = require("express");
const db = require("../lib/db");
const { requireAuth } = require("../middleware/auth");
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

async function persistConsent(botUserId, consent, plan, cycle) {
  try {
    await db.query(
      `INSERT INTO consent_log (bot_user_id, version, documents, consented_at, plan, period, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT DO NOTHING`,
      [botUserId, consent.version, JSON.stringify(consent.documents), consent.timestamp, plan, cycle]
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
      amount: line.amount,          // in cents
      currency: line.currency,
      proration: line.proration || false,
    }));

    const periodEnd = sub.current_period_end;

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
      return res.status(400).json({ error: `Invalid plan/period: ${plan}/${cycle}` });
    }

    // Validate consent
    const cc = validateConsent(consent);
    if (!cc.valid) {
      console.warn(`[billing/checkout] consent rejected for user ${req.userId}: ${cc.reason}`);
      return res.status(400).json({ error: cc.reason });
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
        await persistConsent(req.userId, consent, plan, cycle);
        invalidateCache(req.userId);
        console.log(`[billing/checkout] ${direction} ${currentTier}/${currentPeriod} → ${plan}/${cycle} for user ${req.userId} (immediate)`);
        const confirmId = generateConfirmationId();
        const actionLabel = direction === "upgrade" ? "Upgrade" : "Switch to Yearly";
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
        return res.json({ changed: true, direction, plan, period: cycle, subscriptionId: subId, confirmationId: confirmId });
      }

      // ── Scheduled changes: downgrades + yearly→monthly ──
      // Keep current entitlement until period end, then change.
      const currentPriceId = sub.items.data[0].price.id;
      const effectiveAt = sub.current_period_end; // unix timestamp

      // Release any existing schedule first (e.g. user changing their mind)
      await releaseExistingSchedule(subId);

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

      // Store pending state in DB for display
      await db.query(
        `UPDATE bot_subscriptions
         SET pending_plan_tier = $1, pending_billing_period = $2, updated_at = NOW()
         WHERE stripe_sub_id = $3`,
        [plan, cycle, subId]
      );
      await persistConsent(req.userId, consent, plan, cycle);
      invalidateCache(req.userId);
      console.log(`[billing/checkout] ${direction} ${currentTier}/${currentPeriod} → ${plan}/${cycle} for user ${req.userId} (scheduled at ${new Date(effectiveAt * 1000).toISOString()})`);
      const confirmId = generateConfirmationId();
      const actionLabel = direction === "downgrade" ? "Downgrade (scheduled)" : "Switch to Monthly (scheduled)";
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
      return res.json({
        scheduled: true, direction, plan, period: cycle,
        effectiveAt: new Date(effectiveAt * 1000).toISOString(),
        subscriptionId: subId,
        confirmationId: confirmId,
      });
    }

    // ── New subscription (no existing active subscription) ──
    const session = await getStripe().checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL()}/pricing.html?session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: `${APP_URL()}/pricing.html?status=cancelled`,
      metadata: { bot_user_id: String(req.userId), plan_tier: plan, billing_period: cycle, consent_version: consent.version },
      subscription_data: { metadata: { bot_user_id: String(req.userId), plan_tier: plan, billing_period: cycle } },
    });

    await persistConsent(req.userId, consent, plan, cycle);
    txlog.record("checkout_new", {
      botUserId: req.userId, stripeCustomerId: customerId,
      stripeSessionId: session.id,
      plan, period: cycle,
      consentVersion: consent.version,
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
          // Resolve billing period from the subscription's price interval
          const period = await resolveStripePeriod(s.subscription, null);
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
        } else if (sub.status === "active") {
          // Detect if a scheduled change has taken effect by comparing Stripe price to pending
          const currentPrice = sub.items.data[0]?.price?.id;
          const pending = await db.query(
            `SELECT pending_plan_tier, pending_billing_period FROM bot_subscriptions
             WHERE bot_user_id = $1 AND stripe_sub_id = $2`,
            [uid, sub.id]
          );
          const hasPending = pending.rows[0]?.pending_plan_tier;
          const pendingPriceId = hasPending
            ? PRICE_MAP[pending.rows[0].pending_plan_tier]?.[pending.rows[0].pending_billing_period === "yearly" ? "yearly" : "monthly"]?.()
            : null;

          if (hasPending && pendingPriceId && currentPrice === pendingPriceId) {
            // Scheduled change has taken effect — update tier and clear pending
            await db.query(
              `UPDATE bot_subscriptions SET plan_tier = $1, billing_period = $2,
               pending_plan_tier = NULL, pending_billing_period = NULL,
               status = 'active', expires_at = to_timestamp($3), updated_at = NOW()
               WHERE bot_user_id = $4 AND stripe_sub_id = $5`,
              [pending.rows[0].pending_plan_tier, pending.rows[0].pending_billing_period,
               sub.current_period_end, uid, sub.id]
            );
            await db.query(`UPDATE bot_users SET role = $1 WHERE id = $2`, [pending.rows[0].pending_plan_tier, uid]);
            console.log(`[stripe/webhook] scheduled change applied: ${pending.rows[0].pending_plan_tier} for bot_user ${uid}`);
            txlog.record("webhook_scheduled_applied", {
              botUserId: uid, stripeSubId: sub.id,
              plan: pending.rows[0].pending_plan_tier,
              period: pending.rows[0].pending_billing_period,
              stripeEventId: event.id,
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
          txlog.record("webhook_deleted", {
            botUserId: uid, stripeSubId: sub.id, stripeEventId: event.id,
          });
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
          const failedUid = ur.rows[0]?.bot_user_id;
          txlog.record("webhook_payment_failed", {
            botUserId: failedUid || null,
            stripeSubId: inv.subscription,
            amountDue: inv.amount_due,
            currency: inv.currency,
            stripeEventId: event.id,
          });
          if (failedUid) invalidateCache(failedUid);
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
