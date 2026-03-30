require('dotenv').config({ override: true });
console.log('PPLX key:', process.env.PPLX_API_KEY ? 'loaded' : 'MISSING');
console.log('Model:', process.env.PPLX_MODEL);
const ai = require('./src/lib/ai');
ai.scoreSignal({
  symbol: 'BTCUSDT',
  direction: 'LONG',
  entry: 84000,
  stop: 82000,
  targets: [87000, 90000],
}).then(r => {
  console.log('model:', r.model);
  console.log('score:', r.score);
  console.log('thesis:', r.thesis);
  console.log('tags:', r.tags);
  console.log('breakdown:', JSON.stringify(r.score_breakdown));
}).catch(e => console.error(e));
