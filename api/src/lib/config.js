"use strict";

const REQUIRED = [
  "DATABASE_URL",
  "JWT_SECRET",
];

const RECOMMENDED = {
  STRIPE_SECRET_KEY:      "billing /api/v1/billing/* will fail",
  STRIPE_WEBHOOK_SECRET:  "Stripe webhook signature verification disabled",
  STRIPE_PRICE_PRO:       "checkout for Pro monthly will fail",
  STRIPE_PRICE_PRO_YEARLY:"checkout for Pro yearly will fail",
  STRIPE_PRICE_ELITE:     "checkout for Elite monthly will fail",
  STRIPE_PRICE_ELITE_YEARLY:"checkout for Elite yearly will fail",
  PPLX_API_KEY:           "AI scoring falls back to heuristics only",
  BREVO_API_KEY:          "post-checkout confirmation emails disabled",
  BOT_TOKEN:              "Telegram push worker cannot send messages",
  APP_URL:                "bot links default to production URL",
  REDIS_URL:              "Redis features use default localhost URL",
};

function validate() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[config] FATAL — missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  const warnings = Object.entries(RECOMMENDED).filter(([k]) => !process.env[k]);
  if (warnings.length) {
    console.warn("[config] missing optional env vars (some features will be degraded):");
    for (const [k, impact] of warnings) console.warn(`  - ${k}: ${impact}`);
  } else {
    console.log("[config] all required and recommended env vars present");
  }
}

module.exports = { validate };
