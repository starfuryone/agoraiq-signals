/**
 * Transaction Logger — independent MongoDB + DigitalOcean Spaces archival.
 *
 * Every billing event is recorded in MongoDB (agoraiq_transactions DB)
 * and archived as NDJSON to DO Spaces daily.
 *
 * Env vars:
 *   MONGO_TRANSACTIONS_URI  — e.g. mongodb://127.0.0.1:27017/agoraiq_transactions
 *   DO_SPACES_KEY           — DigitalOcean Spaces access key
 *   DO_SPACES_SECRET        — DigitalOcean Spaces secret key
 *   DO_SPACES_BUCKET        — bucket name (default: datacleanupbucket)
 *   DO_SPACES_REGION        — region (default: sfo3)
 *
 * Usage:
 *   const txlog = require("./lib/transaction-log");
 *   await txlog.record("upgrade_immediate", { botUserId, plan, ... });
 */

let _db = null;
let _s3 = null;

const BUCKET = () => process.env.DO_SPACES_BUCKET || "datacleanupbucket";
const REGION = () => process.env.DO_SPACES_REGION || "sfo3";
const PREFIX = "agoraiq/billing-transactions";

// ── MongoDB connection (lazy, non-blocking) ─────────────────────

async function getMongo() {
  if (_db) return _db;
  const uri = process.env.MONGO_TRANSACTIONS_URI;
  if (!uri) {
    console.warn("[txlog] MONGO_TRANSACTIONS_URI not set — MongoDB logging disabled");
    return null;
  }
  try {
    const { MongoClient } = require("mongodb");
    const client = new MongoClient(uri, {
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000,
    });
    await client.connect();
    _db = client.db(); // uses DB name from URI
    console.log("[txlog] MongoDB connected");
    return _db;
  } catch (err) {
    console.error("[txlog] MongoDB connect failed:", err.message);
    _db = null;
    return null;
  }
}

// ── DO Spaces / S3 client (lazy) ────────────────────────────────

function getS3() {
  if (_s3) return _s3;
  const key = process.env.DO_SPACES_KEY;
  const secret = process.env.DO_SPACES_SECRET;
  if (!key || !secret) {
    console.warn("[txlog] DO_SPACES_KEY/SECRET not set — Spaces archival disabled");
    return null;
  }
  try {
    const { S3Client } = require("@aws-sdk/client-s3");
    _s3 = new S3Client({
      region: REGION(),
      endpoint: `https://${REGION()}.digitaloceanspaces.com`,
      credentials: { accessKeyId: key, secretAccessKey: secret },
      forcePathStyle: false,
    });
    console.log("[txlog] DO Spaces client ready");
    return _s3;
  } catch (err) {
    console.error("[txlog] S3 client init failed:", err.message);
    return null;
  }
}

// ── Record a transaction ────────────────────────────────────────

/**
 * @param {string} eventType — e.g. "checkout_new", "upgrade_immediate", "downgrade_scheduled",
 *                              "switch_yearly_immediate", "switch_monthly_scheduled",
 *                              "webhook_activated", "webhook_updated", "webhook_deleted",
 *                              "webhook_payment_failed", "webhook_scheduled_applied"
 * @param {object} data — arbitrary event payload
 */
async function record(eventType, data) {
  const doc = {
    eventType,
    timestamp: new Date().toISOString(),
    ...data,
  };

  // Fire-and-forget — never block billing flow
  setImmediate(async () => {
    await writeToMongo(doc);
    await archiveToSpaces(doc);
  });
}

// ── MongoDB write ───────────────────────────────────────────────

async function writeToMongo(doc) {
  try {
    const db = await getMongo();
    if (!db) return;
    await db.collection("transactions").insertOne({
      ...doc,
      _createdAt: new Date(),
    });
  } catch (err) {
    console.error("[txlog/mongo] write failed:", err.message);
  }
}

// ── DO Spaces archival (append to daily NDJSON) ─────────────────

async function archiveToSpaces(doc) {
  try {
    const s3 = getS3();
    if (!s3) return;

    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10); // 2026-03-31
    const key = `${PREFIX}/${dateKey}.ndjson`;

    // Read existing content (if any), append new line
    let existing = "";
    try {
      const { GetObjectCommand } = require("@aws-sdk/client-s3");
      const resp = await s3.send(new GetObjectCommand({
        Bucket: BUCKET(),
        Key: key,
      }));
      existing = await resp.Body.transformToString();
    } catch (err) {
      // File doesn't exist yet — that's fine
      if (err.Code !== "NoSuchKey" && err.name !== "NoSuchKey" && err.$metadata?.httpStatusCode !== 404) {
        console.warn("[txlog/spaces] get existing failed:", err.message);
      }
    }

    const line = JSON.stringify(doc);
    const newContent = existing ? existing.trimEnd() + "\n" + line + "\n" : line + "\n";

    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET(),
      Key: key,
      Body: newContent,
      ContentType: "application/x-ndjson",
      ACL: "private",
    }));
  } catch (err) {
    console.error("[txlog/spaces] archive failed:", err.message);
  }
}

// ── Helpers for building transaction payloads ───────────────────

function checkoutPayload(botUserId, plan, cycle, customerId, sessionOrSubId, extra) {
  return {
    botUserId,
    plan,
    period: cycle,
    stripeCustomerId: customerId,
    ...extra,
  };
}

module.exports = { record, getMongo, checkoutPayload };
