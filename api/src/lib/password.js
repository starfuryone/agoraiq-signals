const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const SALT_ROUNDS = 12;

async function hash(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function verify(password, hash) {
  return bcrypt.compare(password, hash);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = { hash, verify, randomToken, hashToken };
