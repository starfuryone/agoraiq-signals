/**
 * Direct Telegram message sender.
 * Used by workers to push notifications without going through the bot process.
 */

const BOT_TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * Send a message to a Telegram chat.
 * Returns { ok, blocked } — blocked=true means user blocked the bot.
 */
async function send(chatId, text, opts = {}) {
  if (!BOT_TOKEN) {
    console.error("[telegram] BOT_TOKEN not set, skipping push");
    return { ok: false, blocked: false };
  }

  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode || "HTML",
      disable_web_page_preview: opts.disablePreview !== false,
    };

    if (opts.replyMarkup) {
      body.reply_markup = JSON.stringify(opts.replyMarkup);
    }

    const res = await fetch(API + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!data.ok) {
      // 403 = blocked, 400 = chat not found
      if (data.error_code === 403 || data.error_code === 400) {
        return { ok: false, blocked: true };
      }
      console.error(`[telegram] send failed to ${chatId}:`, data.description);
      return { ok: false, blocked: false };
    }

    return { ok: true, blocked: false };
  } catch (err) {
    console.error(`[telegram] send error to ${chatId}:`, err.message);
    return { ok: false, blocked: false };
  }
}

/**
 * Send with inline keyboard buttons.
 */
async function sendWithButtons(chatId, text, buttons) {
  return send(chatId, text, {
    replyMarkup: {
      inline_keyboard: buttons.map((btn) =>
        Array.isArray(btn) ? btn : [btn]
      ),
    },
  });
}

module.exports = { send, sendWithButtons };
