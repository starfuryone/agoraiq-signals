/**
 * Push notification message templates.
 * All messages use HTML parse mode for Telegram.
 * All signals expected in canonical schema format.
 */

const APP = process.env.APP_URL || "https://bot.agoraiq.net";
const LANDING = process.env.LANDING_URL || "https://bot.agoraiq.net";

function usd(v) {
  if (v == null) return "—";
  return typeof v === "number"
    ? "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(v);
}

function pct(v) {
  if (v == null) return "—";
  const n = typeof v === "number" ? (Math.abs(v) < 1 && v !== 0 ? v * 100 : v) : parseFloat(v);
  return isNaN(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function dur(sec) {
  if (!sec) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
}

// ═══════════════════════════════════════════════════════════════════
//  BREAKOUT ALERT — full signal for pro/elite
// ═══════════════════════════════════════════════════════════════════

function breakoutAlert(sig) {
  const arrow = sig.direction === "LONG" ? "🟢" : "🔴";
  const vol = sig.meta?.volume_change;
  const oi = sig.meta?.oi_direction;
  const aligned = sig.meta?.providers_aligned;

  let tps = "";
  if (sig.targets?.length) {
    tps = sig.targets
      .slice(0, 3)
      .map((t, i) => `→ TP${i + 1}: <code>${usd(t)}</code>`)
      .join("\n");
  }

  return (
    `🚨 <b>${sig.symbol} BREAKOUT DETECTED</b>\n\n` +
    `${arrow} Direction: <b>${sig.direction}</b>\n` +
    `💰 Price: <code>${usd(sig.entry)}</code>\n` +
    (vol != null ? `📦 Volume: <b>${pct(vol)}</b>\n` : "") +
    (oi ? `📈 OI: <b>${oi}</b>\n` : "") +
    (sig.confidence != null ? `🧠 Confidence: <b>${sig.confidence}%</b>\n` : "") +
    `\n` +
    `→ Entry: <code>${usd(sig.entry)}</code>\n` +
    (tps ? tps + "\n" : "") +
    (sig.stop ? `→ SL: <code>${usd(sig.stop)}</code>\n` : "") +
    (sig.leverage ? `→ Leverage: <b>${sig.leverage}</b>\n` : "") +
    `\n` +
    (aligned ? `🔥 <b>${aligned} providers aligned</b>\n` : "") +
    (sig.provider ? `👤 Provider: ${sig.provider}\n` : "") +
    `🆔 #${sig.id || "—"}`
  );
}

// ═══════════════════════════════════════════════════════════════════
//  LOCKED SIGNAL — hard paywall for free users
// ═══════════════════════════════════════════════════════════════════

function lockedSignal(sig) {
  const arrow = sig.direction === "LONG" ? "🟢" : "🔴";

  return (
    `🚨 <b>${sig.symbol} BREAKOUT DETECTED</b>\n\n` +
    `${arrow} Direction: <b>${sig.direction}</b>\n` +
    `💰 Price: <code>${usd(sig.entry)}</code>\n` +
    (sig.confidence != null ? `🧠 AI Score: <b>${sig.confidence}%</b>\n` : "") +
    `\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔒 <b>Full Signal Locked</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `This trade has:\n` +
    (sig.confidence != null ? `  ✓ ${sig.confidence}% success probability\n` : `  ✓ AI-scored entry\n`) +
    `  ✓ Verified provider edge\n` +
    `  ✓ Entry, TP, SL targets\n\n` +
    `Upgrade to <b>PRO</b> to unlock:\n` +
    `→ Real-time breakout alerts\n` +
    `→ Full signal details + AI scoring\n` +
    `→ Signal tracking + PnL\n\n` +
    `💎 Plans from $19/mo`
  );
}

function lockedButtons() {
  return [
    [{ text: "🔓 Upgrade Now", url: `${LANDING}/pricing` }],
    [{ text: "📊 View Free Signals", url: `${APP}/signals.html` }],
  ];
}

// ═══════════════════════════════════════════════════════════════════
//  SIGNAL OUTCOME — when a signal resolves
// ═══════════════════════════════════════════════════════════════════

function signalOutcome(sig) {
  const isWin = sig.status?.startsWith("TP");
  const emoji = isWin ? "✅" : "❌";
  const label = isWin ? `${sig.status} HIT` : "STOPPED OUT";

  return (
    `${emoji} <b>${sig.symbol} — ${label}</b>\n\n` +
    `🆔 Signal #${sig.id || "—"}\n` +
    `📊 ${sig.direction} @ <code>${usd(sig.entry)}</code>\n\n` +
    `💰 Return: <b>${sig.result != null ? pct(sig.result) : "—"}</b>\n` +
    `⏱ Duration: <b>${dur(sig.duration_sec)}</b>\n` +
    (sig.confidence != null ? `🧠 AI Score: <b>${sig.confidence}%</b>\n` : "") +
    (sig.provider ? `👤 Provider: ${sig.provider}\n` : "") +
    `\n📈 <a href="${APP}/proof.html">View all results →</a>`
  );
}

// ═══════════════════════════════════════════════════════════════════
//  SIGNAL UPDATE — partial TP, trailing stop, etc
// ═══════════════════════════════════════════════════════════════════

function signalUpdate(sig, event) {
  const labels = {
    TP1: "🎯 TP1 Hit", TP2: "🎯🎯 TP2 Hit", TP3: "🎯🎯🎯 TP3 Hit",
    SL_MOVED: "🛑 SL Adjusted", TRAILING: "📈 Trailing Active",
  };
  const nextTp = sig.meta?.next_target;

  return (
    `${labels[event] || event} — <b>${sig.symbol}</b>\n\n` +
    `🆔 Signal #${sig.id || "—"}\n` +
    `📊 ${sig.direction} @ <code>${usd(sig.entry)}</code>\n` +
    (sig.current_price ? `📈 Current: <code>${usd(sig.current_price)}</code>\n` : "") +
    (sig.result != null ? `💰 Return: <b>${pct(sig.result)}</b>\n` : "") +
    (sig.duration_sec ? `⏱ Duration: <b>${dur(sig.duration_sec)}</b>\n` : "") +
    (nextTp ? `\n🎯 Next target: <code>${usd(nextTp)}</code>\n` : "") +
    `\n<a href="${APP}/signals.html">Track live →</a>`
  );
}

// ═══════════════════════════════════════════════════════════════════
//  DAILY SUMMARY
// ═══════════════════════════════════════════════════════════════════

function dailySummary(stats) {
  let totalReturnLine = "";
  if (stats.totalReturn != null) {
    const r = stats.totalReturn;
    totalReturnLine = `💰 Total return: <b>${r >= 0 ? "+" : ""}${(r * 100).toFixed(1)}%</b>\n`;
  }

  return (
    `📊 <b>Daily Edge — AgoraIQ</b>\n\n` +
    (stats.newSignals ? `• ${stats.newSignals} signals triggered\n` : "") +
    (stats.resolved && stats.wins ? `• ${stats.wins} winners` + (stats.resolved > stats.wins ? ` / ${stats.resolved - stats.wins} stopped` : "") + `\n` : "") +
    totalReturnLine +
    (stats.topMover ? `• Top mover: <b>${stats.topMover}</b>\n` : "") +
    `• Win rate: <b>${stats.winRate != null ? pct(stats.winRate) : "—"}</b>\n` +
    `\n<a href="${APP}/dashboard.html">Open dashboard →</a>`
  );
}

function dailySummaryFree(stats) {
  return (
    `📊 <b>Daily Edge — AgoraIQ</b>\n\n` +
    (stats.newSignals ? `• ${stats.newSignals} signals triggered today\n` : "") +
    (stats.wins ? `• ${stats.wins} winners 🏆\n` : "") +
    `• Win rate: <b>${stats.winRate != null ? pct(stats.winRate) : "—"}</b>\n` +
    `\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔒 <b>PRO members also got:</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `→ ${stats.newSignals || "?"} real-time breakout alerts\n` +
    `→ Full entry, TP, SL for each\n` +
    `→ AI confidence scoring\n` +
    `→ Signal PnL tracking\n\n` +
    `💎 <a href="${LANDING}/pricing">Unlock PRO →</a>`
  );
}

module.exports = {
  breakoutAlert, lockedSignal, lockedButtons,
  signalOutcome, signalUpdate,
  dailySummary, dailySummaryFree,
};
