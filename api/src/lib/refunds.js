/**
 * 7-day money-back guarantee for first-time customers.
 *
 * Eligibility:
 *   - The Stripe customer has no other subscription besides the one being cancelled.
 *   - The first paid invoice for that subscription was paid within the last 7 days.
 *
 * When eligible, refunds every paid charge on the subscription and cancels the
 * subscription immediately. Idempotent: a second call for the same subscription
 * short-circuits on the billing_refunds row.
 */

const db = require("./db");
const txlog = require("./transaction-log");

const REFUND_WINDOW_DAYS = 7;
const WINDOW_SECONDS = REFUND_WINDOW_DAYS * 86400;

let _stripe = null;
function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
    _stripe = require("stripe")(key);
  }
  return _stripe;
}

async function isFirstTimeCustomer(stripeCustomerId, currentSubId) {
  const list = await getStripe().subscriptions.list({
    customer: stripeCustomerId,
    status: "all",
    limit: 20,
  });
  const others = list.data.filter((s) => s.id !== currentSubId);
  return others.length === 0;
}

async function firstPaidInvoiceTimestamp(stripeSubId) {
  const invoices = await getStripe().invoices.list({
    subscription: stripeSubId,
    status: "paid",
    limit: 100,
  });
  if (invoices.data.length === 0) return null;
  const sorted = [...invoices.data].sort((a, b) => a.created - b.created);
  const first = sorted[0];
  return first.status_transitions?.paid_at || first.created;
}

async function hasExistingSucceededRefund(stripeSubId) {
  const r = await db.query(
    `SELECT 1 FROM billing_refunds
     WHERE stripe_sub_id = $1 AND status = 'succeeded' LIMIT 1`,
    [stripeSubId]
  );
  return r.rows.length > 0;
}

async function recordRefund(row) {
  await db.query(
    `INSERT INTO billing_refunds
       (bot_user_id, stripe_sub_id, stripe_customer_id, stripe_charge_id,
        stripe_refund_id, amount_cents, currency, reason, trigger_source, status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (stripe_refund_id) DO NOTHING`,
    [
      row.botUserId || null,
      row.stripeSubId,
      row.stripeCustomerId || null,
      row.stripeChargeId || null,
      row.stripeRefundId || null,
      row.amountCents || null,
      row.currency || null,
      row.reason || "first_time_7day_guarantee",
      row.triggerSource || null,
      row.status,
      row.error || null,
    ]
  );
}

/**
 * Check eligibility and — if eligible — refund all paid charges and cancel
 * the subscription immediately.
 *
 * @param {object} opts
 * @param {number} [opts.botUserId]       — local user id (may be null for cold visitor edge cases)
 * @param {string} opts.stripeSubId       — Stripe subscription id
 * @param {string} [opts.triggerSource]   — "webhook" | "user_request" | "manual"
 * @returns {Promise<object>} result      — { refunded, reason?, amountCents?, refundIds? }
 */
async function processCancelRefund({ botUserId, stripeSubId, triggerSource }) {
  if (!stripeSubId) return { refunded: false, reason: "missing_subscription" };

  if (await hasExistingSucceededRefund(stripeSubId)) {
    return { refunded: false, reason: "already_refunded" };
  }

  const stripe = getStripe();
  let sub;
  try {
    sub = await stripe.subscriptions.retrieve(stripeSubId);
  } catch (err) {
    return { refunded: false, reason: "subscription_not_found", error: err.message };
  }

  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (!customerId) return { refunded: false, reason: "no_customer" };

  if (!(await isFirstTimeCustomer(customerId, stripeSubId))) {
    return { refunded: false, reason: "not_first_time_customer" };
  }

  const firstPaidAt = await firstPaidInvoiceTimestamp(stripeSubId);
  if (!firstPaidAt) return { refunded: false, reason: "no_paid_invoices" };

  const now = Math.floor(Date.now() / 1000);
  if (now - firstPaidAt > WINDOW_SECONDS) {
    return {
      refunded: false,
      reason: "outside_refund_window",
      firstPaidAt,
      windowDays: REFUND_WINDOW_DAYS,
    };
  }

  const paid = await stripe.invoices.list({
    subscription: stripeSubId,
    status: "paid",
    limit: 100,
  });

  const refundIds = [];
  let totalRefunded = 0;
  let currency = null;

  for (const inv of paid.data) {
    if (!inv.charge) continue;
    try {
      const refund = await stripe.refunds.create(
        {
          charge: inv.charge,
          reason: "requested_by_customer",
          metadata: {
            bot_user_id: String(botUserId || ""),
            stripe_sub_id: stripeSubId,
            policy: "first_time_7day_guarantee",
          },
        },
        { idempotencyKey: `refund:${stripeSubId}:${inv.charge}` }
      );
      refundIds.push(refund.id);
      totalRefunded += refund.amount || 0;
      currency = currency || refund.currency;
      await recordRefund({
        botUserId,
        stripeSubId,
        stripeCustomerId: customerId,
        stripeChargeId: inv.charge,
        stripeRefundId: refund.id,
        amountCents: refund.amount,
        currency: refund.currency,
        triggerSource,
        status: "succeeded",
      });
    } catch (err) {
      console.error(`[refunds] Stripe refund failed for charge ${inv.charge}:`, err.message);
      await recordRefund({
        botUserId,
        stripeSubId,
        stripeCustomerId: customerId,
        stripeChargeId: inv.charge,
        triggerSource,
        status: "failed",
        error: err.message,
      });
      return {
        refunded: refundIds.length > 0,
        partial: refundIds.length > 0,
        reason: "stripe_refund_error",
        error: err.message,
        refundIds,
      };
    }
  }

  if (refundIds.length === 0) {
    return { refunded: false, reason: "no_charges_to_refund" };
  }

  // Cancel subscription immediately so entitlement ends when refund issues.
  try {
    if (sub.status !== "canceled") {
      await stripe.subscriptions.cancel(stripeSubId, { invoice_now: false, prorate: false });
    }
  } catch (err) {
    console.error(`[refunds] cancel after refund failed for ${stripeSubId}:`, err.message);
  }

  try {
    await db.query(
      `UPDATE bot_subscriptions
       SET status = 'expired', expires_at = NOW(), updated_at = NOW()
       WHERE stripe_sub_id = $1`,
      [stripeSubId]
    );
  } catch (err) {
    console.error("[refunds] local subscription update failed:", err.message);
  }

  txlog.record("auto_refund_issued", {
    botUserId: botUserId || null,
    stripeCustomerId: customerId,
    stripeSubId,
    refundIds,
    amountCents: totalRefunded,
    currency,
    triggerSource: triggerSource || null,
    policy: "first_time_7day_guarantee",
    windowDays: REFUND_WINDOW_DAYS,
  });

  return {
    refunded: true,
    refundIds,
    amountCents: totalRefunded,
    currency,
  };
}

module.exports = {
  processCancelRefund,
  REFUND_WINDOW_DAYS,
  // exported for tests
  _internal: { isFirstTimeCustomer, firstPaidInvoiceTimestamp },
};
