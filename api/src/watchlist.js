'use strict';
const express  = require('express');
const Database = require('better-sqlite3');
const jwt      = require('jsonwebtoken');
const path     = require('path');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-to-a-random-64-char-string';
const db = new Database(path.join(__dirname, '../../watchlist.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS watchlist (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    signal_id   TEXT NOT NULL,
    signal_data TEXT NOT NULL,
    watched_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, signal_id)
  )
`);

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(t, JWT_SECRET);
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function uid(req) {
  const u = req.user;
  return String(u.id || u.sub || u.userId || u.email || 'anon');
}

const router = express.Router();

// GET /api/v1/watchlist
router.get('/', auth, (req, res) => {
  const rows = db.prepare(
    'SELECT signal_data, watched_at FROM watchlist WHERE user_id=? ORDER BY watched_at DESC'
  ).all(uid(req));
  res.json({
    signals: rows.map(r => ({ ...JSON.parse(r.signal_data), watched_at: r.watched_at })),
    count: rows.length
  });
});

// POST /api/v1/watchlist
router.post('/', auth, (req, res) => {
  const sig = req.body;
  if (!sig || !sig.id) return res.status(400).json({ error: 'signal.id required' });
  db.prepare(
    'INSERT OR REPLACE INTO watchlist (user_id, signal_id, signal_data) VALUES (?,?,?)'
  ).run(uid(req), String(sig.id), JSON.stringify(sig));
  res.json({ ok: true });
});

// DELETE /api/v1/watchlist/:signalId
router.delete('/:signalId', auth, (req, res) => {
  db.prepare('DELETE FROM watchlist WHERE user_id=? AND signal_id=?')
    .run(uid(req), req.params.signalId);
  res.json({ ok: true });
});

// GET /api/v1/watchlist/check/:signalId  (for reflecting saved state on open)
router.get('/check/:signalId', auth, (req, res) => {
  const row = db.prepare('SELECT id FROM watchlist WHERE user_id=? AND signal_id=?')
    .get(uid(req), req.params.signalId);
  res.json({ saved: !!row });
});

module.exports = router;
