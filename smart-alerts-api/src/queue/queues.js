"use strict";

const { Queue, QueueEvents } = require("bullmq");
const { getBullConnection } = require("../lib/redis");

const CONCURRENCY = parseInt(process.env.QUEUE_CONCURRENCY || "5", 10);
const RATE_PER_SEC = parseInt(process.env.QUEUE_RATE_PER_SEC || "25", 10);
const MAX_RETRIES = parseInt(process.env.QUEUE_MAX_RETRIES || "3", 10);

const PREFIX = "{smart-alerts}";

let _deliveryQueue = null;
let _deliveryEvents = null;

function deliveryQueue() {
  if (!_deliveryQueue) {
    _deliveryQueue = new Queue("sa-deliver", {
      connection: getBullConnection(),
      prefix: PREFIX,
      defaultJobOptions: {
        attempts: MAX_RETRIES,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 3600, count: 5000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }
  return _deliveryQueue;
}

function deliveryEvents() {
  if (!_deliveryEvents) {
    _deliveryEvents = new QueueEvents("sa-deliver", {
      connection: getBullConnection(),
      prefix: PREFIX,
    });
  }
  return _deliveryEvents;
}

async function closeAll() {
  if (_deliveryQueue) { try { await _deliveryQueue.close(); } catch {} _deliveryQueue = null; }
  if (_deliveryEvents) { try { await _deliveryEvents.close(); } catch {} _deliveryEvents = null; }
}

module.exports = {
  deliveryQueue,
  deliveryEvents,
  closeAll,
  PREFIX,
  CONCURRENCY,
  RATE_PER_SEC,
  MAX_RETRIES,
};
