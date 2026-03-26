
'use strict';
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');

const PORT = process.env.PROVIDERS_PORT || 4400;
const db   = new Database(path.join(__dirname, 'providers.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    main_id       TEXT UNIQUE,
    name          TEXT NOT NULL,
    channel       TEXT,
    platform      TEXT DEFAULT 'telegram',
    trading_style TEXT,
    market_type   TEXT,
    exchange_focus TEXT,
    subscriber_count INTEGER DEFAULT 0,
    is_verified   INTEGER DEFAULT 0,
    marketplace_tier TEXT DEFAULT 'PENDING',
    slug          TEXT,
    active        INTEGER DEFAULT 1,
    synced_at     TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS provider_stats (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id   INTEGER REFERENCES providers(id) ON DELETE CASCADE,
    main_id       TEXT,
    period        TEXT NOT NULL DEFAULT '30d',
    win_rate      REAL,
    expectancy_r  REAL,
    trade_count   INTEGER DEFAULT 0,
    profit_factor REAL,
    max_drawdown  REAL,
    trust_score   REAL,
    sample_confidence TEXT,
    computed_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(provider_id, period)
  );
`);

const app = express();
app.use(express.json());
app.use((req,res,next)=>{res.setHeader('Access-Control-Allow-Origin','*');next();});

// GET /api/v1/providers
app.get('/api/v1/providers', (req,res)=>{
  try {
    const limit = Math.min(parseInt(req.query.limit)||50, 100);
    const period = req.query.period || '30d';
    const rows = db.prepare(`
      SELECT p.id, p.name, p.channel, p.platform, p.trading_style,
             p.market_type, p.exchange_focus, p.subscriber_count,
             p.is_verified, p.marketplace_tier,
             s.win_rate, s.trade_count, s.expectancy_r,
             s.profit_factor, s.max_drawdown, s.trust_score, s.sample_confidence
      FROM providers p
      LEFT JOIN provider_stats s ON s.provider_id = p.id AND s.period = ?
      WHERE p.active = 1
      ORDER BY COALESCE(s.trust_score, s.win_rate, 0) DESC
      LIMIT ?
    `).all(period, limit);
    res.json({ providers: rows.map(fmt) });
  } catch(e) { console.error('[providers]',e.message); res.status(500).json({error:'Internal error'}); }
});

// GET /api/v1/providers/top
app.get('/api/v1/providers/top', (req,res)=>{
  try {
    const rows = db.prepare(`
      SELECT p.id, p.name, p.channel, p.platform,
             s.win_rate, s.trade_count, s.expectancy_r, s.profit_factor, s.trust_score
      FROM providers p
      JOIN provider_stats s ON s.provider_id = p.id AND s.period = '30d'
      WHERE p.active = 1 AND s.trade_count >= 5
      ORDER BY COALESCE(s.trust_score, s.win_rate, 0) DESC
      LIMIT 5
    `).all();
    res.json({ providers: rows.map(fmt) });
  } catch(e) { res.status(500).json({error:'Internal error'}); }
});

// GET /api/v1/providers/:id
app.get('/api/v1/providers/:id', (req,res)=>{
  try {
    const p = /^\d+$/.test(req.params.id)
      ? db.prepare('SELECT * FROM providers WHERE id=?').get(req.params.id)
      : db.prepare('SELECT * FROM providers WHERE LOWER(name)=LOWER(?)').get(req.params.id);
    if(!p) return res.status(404).json({error:'Not found'});
    const stats = db.prepare('SELECT * FROM provider_stats WHERE provider_id=? ORDER BY period').all(p.id);
    res.json({...fmt(p), stats});
  } catch(e) { res.status(500).json({error:'Internal error'}); }
});

function fmt(r) {
  return {
    id: r.id, name: r.name,
    channel: r.channel||null, platform: r.platform||'telegram',
    tradingStyle: r.trading_style||null, marketType: r.market_type||null,
    exchangeFocus: r.exchange_focus||null,
    subscriberCount: r.subscriber_count||0,
    isVerified: !!r.is_verified, tier: r.marketplace_tier||'PENDING',
    winRate: r.win_rate!=null ? parseFloat(r.win_rate) : null,
    totalSignals: r.trade_count||0,
    expectancyR: r.expectancy_r!=null ? parseFloat(r.expectancy_r) : null,
    profitFactor: r.profit_factor!=null ? parseFloat(r.profit_factor) : null,
    maxDrawdown: r.max_drawdown!=null ? parseFloat(r.max_drawdown) : null,
    trustScore: r.trust_score!=null ? parseFloat(r.trust_score) : null,
    sampleConfidence: r.sample_confidence||null,
  };
}

// POST /api/v1/ai/provider-iq
app.post('/api/v1/ai/provider-iq', async (req,res)=>{
  try {
    const { providerId } = req.body;
    console.log('[ai] providerId received:', providerId, typeof providerId);
    if (!providerId) return res.status(400).json({error:'providerId required'});

    const p = db.prepare(
      'SELECT p.*, s.win_rate, s.trade_count, s.expectancy_r, s.profit_factor, ' +
      's.max_drawdown, s.trust_score, s.sample_confidence ' +
      'FROM providers p LEFT JOIN provider_stats s ON s.provider_id=p.id AND s.period=\'30d\' ' +
      'WHERE p.id=? OR p.main_id=? OR LOWER(p.name)=LOWER(?)'
    ).get(providerId, providerId, providerId);
    if (!p) return res.status(404).json({error:'Provider not found'});

    const wr = p.win_rate!=null ? (p.win_rate*100).toFixed(1)+'%' : 'N/A';
    const er = p.expectancy_r!=null ? p.expectancy_r.toFixed(2) : 'N/A';
    const pf = p.profit_factor!=null ? p.profit_factor.toFixed(2) : 'N/A';
    const dd = p.max_drawdown!=null ? p.max_drawdown.toFixed(1)+'%' : 'N/A';
    const tc = p.trade_count || 0;
    const conf = p.sample_confidence || 'unknown';

    const prompt = `You are a quantitative trading analyst. Analyze this crypto signal provider and give a concise 3-4 sentence assessment covering edge quality, risk profile, and whether they are worth following.

Provider: ${p.name}
Platform: ${p.platform || 'telegram'}
Win Rate (30d): ${wr}
Expected Return per trade E(R): ${er}
Profit Factor: ${pf}
Max Drawdown: ${dd}
Verified Trades: ${tc}
Sample Confidence: ${conf}
Tier: ${p.marketplace_tier || 'PENDING'}

Give a direct, data-driven assessment. Be honest about weaknesses.`;

    const hfRes = await fetch(
      'https://api.perplexity.ai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer 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',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'sonar',
          messages: [{role:'user', content: prompt}],
          max_tokens: 300,
          temperature: 0.4
        })
      }
    );

    if (!hfRes.ok) {
      const err = await hfRes.text();
      console.error('[ai/provider-iq] Perplexity error:', hfRes.status, err.slice(0,200));
      return res.status(502).json({error:'AI service unavailable'});
    }

    const data = await hfRes.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || 'Unable to generate insight.';
    res.json({ text });
  } catch(e) {
    console.error('[ai/provider-iq]', e.message);
    res.status(500).json({error:'Internal error'});
  }
});

// GET /api/v1/providers/:id/stats — all periods for sparkline
app.get('/api/v1/providers/:id/stats', (req,res)=>{
  try {
    const rows = db.prepare(
      'SELECT period, win_rate, trade_count, expectancy_r, profit_factor ' +
      'FROM provider_stats WHERE provider_id=? ORDER BY ' +
      "CASE period WHEN '7d' THEN 1 WHEN '30d' THEN 2 WHEN '90d' THEN 3 WHEN 'all' THEN 4 ELSE 5 END"
    ).all(req.params.id);
    res.json({ stats: rows });
  } catch(e) { res.status(500).json({error:'Internal error'}); }
});

app.listen(PORT, '127.0.0.1', ()=>console.log(`[providers-api] listening on 127.0.0.1:${PORT}`));
