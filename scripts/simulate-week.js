// Practice run of the full automatic flow for one game (default: Oct 25) on a COPY of the data.
// Pretend players reply; nothing real changes and nothing is sent anywhere.
// Usage: node scripts/simulate-week.js [gameId]
const fs = require('fs');
const path = require('path');
const T = require('../lib/time');
const team = require('../lib/team');
const store = require('../lib/store');
const { simulateGame, profiles, rng } = require('../lib/sim');
const cfg = require('../config');

const gameId = process.argv[2] || 'g_oct25';
const dir = path.join(path.dirname(store.FILE), 'simulation');
fs.mkdirSync(dir, { recursive: true });
const outbox = path.join(dir, 'oct25-outbox.log');
if (fs.existsSync(outbox)) fs.unlinkSync(outbox);

const db = JSON.parse(fs.readFileSync(store.FILE, 'utf8'));
db.settings.automationsOn = true;
const g = db.games.find((x) => x.id === gameId);
const before = new Set(db.messages.map((m) => m.id));
const from = new Date();
const to = T.atLocalTime(T.shiftDay(T.localDate(g.startsAt), 1), 15 * 60);
simulateGame(db, g, { from, to, seed: 2025, outboxFile: outbox, tag: 'sim', prof: profiles(db, rng(42)), result: { outcome: 'W', us: 3, them: 1 } });
// simulated result so the recap has a score
const newMsgs = db.messages.filter((m) => !before.has(m.id));
newMsgs.forEach((m) => (m.tag = 'sim'));
fs.writeFileSync(path.join(dir, 'oct25-db.json'), JSON.stringify(db, null, 2));

const pn = (id) => db.players.find((p) => p.id === id).name;
const h = team.headcount(db, g);
const steps = cfg.automation.steps.map((s) => {
  const run = db.jobRuns[`${g.id}:${s.key}`] || {};
  const ms = newMsgs.filter((m) => m.step === s.key);
  return { step: s.label, due: run.dueAt ? T.fmtGame(run.dueAt) : '', status: run.status || 'not reached', sent: ms.filter((m) => m.status === 'sent').map((m) => `${pn(m.playerId)} [${m.variant}] ${T.fmtStamp(m.sentAt)}`), skipped: ms.filter((m) => m.status === 'skipped').map((m) => `${pn(m.playerId)}: ${m.reason}`) };
});
const irMsgs = newMsgs.filter((m) => m.step === 'irCheck').map((m) => `${pn(m.playerId)}: ${m.status} ${m.sentAt ? T.fmtStamp(m.sentAt) : m.reason || ''}`);
const summary = { irChecks: irMsgs, game: T.fmtGame(g.startsAt), simulatedFrom: T.fmtStamp(from), simulatedTo: T.fmtStamp(to), finalHeadcount: { in: h.in.map((p) => p.name), maybe: h.maybe.map((p) => p.name), out: h.out.map((p) => p.name), noReply: h.none.map((p) => p.name), keepers: h.keepers.map((p) => p.name) }, checkedIn: db.checkins.filter((c) => c.gameId === g.id).map((c) => pn(c.playerId)), totals: { sent: newMsgs.filter((m) => m.status === 'sent').length, skipped: newMsgs.filter((m) => m.status === 'skipped').length }, steps };
fs.writeFileSync(path.join(dir, 'oct25-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
