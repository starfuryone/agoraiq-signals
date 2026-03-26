/**
 * Signal parser — extracts structured trade data from raw text.
 * JS port of the Python SignalParser used in the Telegram scraper.
 */

const PAIR_RE = /\b(BTCUSDT|BTC\/USD|BTC-USDT|BTCUSD|XBTUSD|ETHUSDT|ETH\/USD|ETH-USDT|ETHUSD|SOLUSDT|BNBUSDT|DOGEUSDT|XRPUSDT|ADAUSDT|AVAXUSDT|DOTUSDT|MATICUSDT|LINKUSDT|ARBUSDT|OPUSDT|APTUSDT|SUIUSDT|WIFUSDT|PEPEUSDT|[A-Z]{2,10}[/\\-]USDT|[A-Z]{2,10}USDT)\b/i;
const LONG_RE = /\b(LONG|BUY)\b/i;
const SHORT_RE = /\b(SHORT|SELL)\b/i;
const LEVERAGE_RE = /\b(\d{1,3}x)\b/i;

const ENTRY_PATTERNS = [
  /(?:ENTRY|ENTRY ZONE|ENTER|BUY ZONE|SELL ZONE)\s*[:\-]?\s*([0-9.,k\s\-toTO]+)/i,
  /(?:AT|AROUND)\s*[:\-]?\s*([0-9.,k\s\-toTO]+)/i,
  /(?:LONG|SHORT|BUY|SELL)\s+([0-9.,k]+)/i,
];
const STOP_PATTERNS = [
  /(?:SL|STOP LOSS|STOPLOSS|STOP)\s*[:\-]?\s*([0-9.,k]+)/i,
];
const TARGET_PATTERNS = [
  /(?:TP\d*|TARGET\d*|TAKE PROFIT\d*)\s*[:\-]?\s*([0-9.,k]+)/gi,
];
const NUMBER_RE = /\d+(?:[.,]\d+)?k?/gi;

function parseNumbers(blob) {
  if (!blob) return [];
  const matches = blob.match(NUMBER_RE) || [];
  return matches
    .map((m) => {
      const hasK = m.toLowerCase().endsWith("k");
      const num = parseFloat(m.replace(/k/i, "").replace(",", ""));
      if (isNaN(num)) return NaN;
      return hasK ? num * 1000 : num;
    })
    .filter((n) => !isNaN(n));
}

function extractPair(text) {
  const m = text.match(PAIR_RE);
  if (!m) return null;
  let raw = m[1].toUpperCase().replace(/[\/\-]/g, "");
  if (raw === "BTCUSD" || raw === "XBTUSD") return "BTCUSDT";
  if (raw === "ETHUSD") return "ETHUSDT";
  // Normalize anything without USDT suffix that we recognize
  if (!raw.endsWith("USDT") && raw.length <= 6) return raw + "USDT";
  return raw;
}

function extractSide(text) {
  const hasLong = LONG_RE.test(text);
  const hasShort = SHORT_RE.test(text);
  if (hasLong && !hasShort) return "LONG";
  if (hasShort && !hasLong) return "SHORT";
  return null;
}

function extractLeverage(text) {
  const m = text.match(LEVERAGE_RE);
  return m ? m[1].toUpperCase() : null;
}

function extractEntry(text) {
  for (const pat of ENTRY_PATTERNS) {
    const m = text.match(pat);
    if (m) {
      const nums = parseNumbers(m[1]);
      if (nums.length > 0) return nums.slice(0, 2);
    }
  }
  return [];
}

function extractStop(text) {
  for (const pat of STOP_PATTERNS) {
    const m = text.match(pat);
    if (m) {
      const nums = parseNumbers(m[1]);
      if (nums.length > 0) return nums[0];
    }
  }
  return null;
}

function extractTargets(text) {
  const out = [];
  // Reset lastIndex for global regex
  for (const pat of TARGET_PATTERNS) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(text)) !== null) {
      const nums = parseNumbers(m[1]);
      if (nums.length > 0) out.push(nums[0]);
    }
  }
  // Fallback: "Targets: 69000 / 69500 / 70000"
  if (out.length === 0) {
    const fb = text.match(/(?:TARGETS?|TPS?)\s*[:\-]?\s*([0-9.,k\/\s]+)/i);
    if (fb) return parseNumbers(fb[1]).slice(0, 5);
  }
  return out.slice(0, 5);
}

function looksLikeSignal(text) {
  const upper = text.toUpperCase();
  const hasPair = /[A-Z]{2,10}USDT|BTC|ETH/.test(upper);
  const hasSide = /LONG|SHORT|BUY|SELL/.test(upper);
  const hasFields = /ENTRY|TP|TARGET|SL|STOP/.test(upper);
  return hasPair && (hasSide || hasFields);
}

/**
 * Parse raw signal text into structured data.
 * @param {string} rawText
 * @returns {{ symbol, action, price, stopLoss, targets, leverage, parseStatus, notes }}
 */
function parseSignal(rawText) {
  const text = (rawText || "").trim();
  const result = {
    symbol: null,
    action: null,
    price: null,
    stopLoss: null,
    targets: [],
    leverage: null,
    parseStatus: "unparsed",
    notes: [],
  };

  if (!text) {
    result.notes.push("empty_text");
    return result;
  }

  result.symbol = extractPair(text);
  result.action = extractSide(text);
  const entry = extractEntry(text);
  result.price = entry.length > 0 ? entry[0] : null;
  result.stopLoss = extractStop(text);
  result.targets = extractTargets(text);
  result.leverage = extractLeverage(text);

  const hasRequired = result.symbol && result.action;
  const hasStructure = result.price || result.targets.length > 0 || result.stopLoss;

  if (hasRequired && hasStructure) {
    result.parseStatus = "parsed";
  } else if (looksLikeSignal(text)) {
    result.parseStatus = "partial";
    result.notes.push("signal_like_but_incomplete");
  } else {
    result.parseStatus = "not_signal";
  }

  return result;
}

module.exports = { parseSignal };
