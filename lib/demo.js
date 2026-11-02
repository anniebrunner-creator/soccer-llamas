// DEMO mode helpers: snapshot of the fresh seed, instant reset, nightly re-seed.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cfg = require('../config');
const store = require('./store');
const T = require('./time');

const DIR = path.dirname(store.FILE);
const SNAP = path.join(DIR, 'seed-snapshot.json');
const DEMO_PLAYER = process.env.DEMO_PLAYER || 'Faux Fran';

function saveSnapshot() { fs.copyFileSync(store.FILE, SNAP); }
function resetFromSnapshot() {
  if (!fs.existsSync(SNAP)) throw new Error('No demo snapshot yet.');
  const outbox = path.resolve(__dirname, '..', cfg.channels.email.outboxFile);
  fs.writeFileSync(outbox, '');
  store.set(JSON.parse(fs.readFileSync(SNAP, 'utf8')));
}
// Fresh seed (dates relative to "now") in a child process so the server stays responsive.
function regenerate(cb = () => {}) {
  const tmp = path.join(DIR, 'db.next.json');
  execFile(process.execPath, [path.join(__dirname, '..', 'seed.js'), '--force'], { env: { ...process.env, LLAMAS_DB: tmp, OUTBOX_FILE: path.join(DIR, 'outbox.next.log') }, timeout: 180000 }, (err) => {
    if (err) { console.error('[demo] re-seed failed', err.message); return cb(err); }
    fs.renameSync(tmp, SNAP);
    resetFromSnapshot();
    console.log('[demo] nightly reset done', new Date().toISOString());
    cb();
  });
}
let lastReset = null;
function startNightly() {
  const [h, m] = cfg.demoResetTime.split(':').map(Number);
  lastReset = T.toLocalInputs(new Date()).date; // just seeded/loaded at startup
  setInterval(() => {
    const now = new Date(); const day = T.toLocalInputs(now).date; const p = T.parts(now);
    if (day !== lastReset && p.hour * 60 + p.minute >= h * 60 + m) { lastReset = day; regenerate(); }
  }, 60000);
}
const demoPlayer = (db) => db.players.find((p) => p.name === DEMO_PLAYER) || db.players.find((p) => p.role !== 'sub');
module.exports = { saveSnapshot, resetFromSnapshot, regenerate, startNightly, demoPlayer, SNAP };
