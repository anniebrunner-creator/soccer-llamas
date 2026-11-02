// Live heartbeat: runs the automation engine every minute (America/Denver math inside).
// On startup it immediately runs once, which catches up any steps missed while the server
// was down (each step has a catch-up window; after that it's recorded as "missed").
const cfg = require('../config');
const store = require('./store');
const { tick } = require('./automation');
let timer = null;
function beat() {
  try { const db = store.get(); const a = tick(db, new Date()); const b = inbound.flush(db, new Date()); if (a || b) store.save(); }
  catch (e) { console.error('[scheduler]', e); }
}
const inbound = require('./inbound');
let inboxTimer = null, polling = false;
async function inboxBeat() {
  if (polling) return; polling = true;
  try { const db = store.get(); const n = await inbound.poll(db, new Date()); if (n) { console.log('[inbox] processed', n); store.save(); } }
  catch (e) { console.error('[inbox]', e.message); } finally { polling = false; }
}
function start() { if (timer) return; beat(); inboxBeat(); inboxTimer = setInterval(inboxBeat, cfg.inbound.pollSeconds * 1000); timer = setInterval(beat, cfg.automation.tickSeconds * 1000); console.log('[scheduler] running every', cfg.automation.tickSeconds, 's'); }
module.exports = { start, beat, inboxBeat };
