// Tiny JSON-file store: whole DB in memory, atomic write on every change.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.LLAMAS_DB || path.join(__dirname, '..', 'data', 'db.json');
let db = null;

const empty = () => ({ players: [], games: [], rsvps: [], checkins: [], fees: [], awards: [], injuries: [], pinnies: { holders: [], recordedAt: null, note: '' }, settings: { captainName: 'Your Captain', adminToken: null }, inbound: [], pendingReferrals: [], fyi: [], messages: [], jobRuns: {}, standings: [] });

function load() {
  if (!fs.existsSync(FILE)) return null;
  const e = empty(); db = { ...e, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; db.settings = { ...e.settings, ...db.settings };
  return db;
}
function get() { if (!db) load(); return db; }
function set(newDb) { db = newDb; save(); }
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}
const id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
const token = () => crypto.randomBytes(9).toString('base64url');

module.exports = { FILE, load, get, set, save, id, token, empty };
