"use strict";

/**
 * Plan limits. Pro and Elite are the only paid tiers — no free tier.
 * Values align with the product spec for Smart Alerts.
 */

const PLANS = {
  pro: {
    tier: "pro",
    maxAlerts: 10,
    maxConditionsPerRule: 5,
    minCooldownSeconds: 300,
    dailyTriggers: 50,
    priority: 5,
    backtesting: false,
    performanceTracking: false,
  },
  elite: {
    tier: "elite",
    maxAlerts: 50,
    maxConditionsPerRule: 10,
    minCooldownSeconds: 60,
    dailyTriggers: 200,
    priority: 1,
    backtesting: true,
    performanceTracking: true,
  },
};

function limitsFor(tier) {
  return PLANS[tier] || null;
}

module.exports = { PLANS, limitsFor };
