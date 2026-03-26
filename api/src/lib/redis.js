const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

let _client = null;

function getRedis() {
  if (!_client) {
    _client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null, // required for BullMQ
      enableReadyCheck: false,
    });
    _client.on("error", (err) => console.error("[redis]", err.message));
  }
  return _client;
}

async function closeRedis() {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}

module.exports = { getRedis, closeRedis };
