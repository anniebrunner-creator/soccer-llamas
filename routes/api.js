// Small JSON API for the AI assistant (captain key required).
const express = require('express');
const store = require('../lib/store');
const team = require('../lib/team');
const { leaderboard } = require('../lib/points');
const health = require('../lib/health');
const T = require('../lib/time');
const r = express.Router();
r.use((req, res, next) => ((req.get('x-admin-token') || req.query.key) === store.get().settings.adminToken ? next() : res.status(401).json({ error: 'captain key required' })));
r.get('/summary', (req, res) => {
  const d = store.get(); const g = team.nextGame(d); const h = g && team.headcount(d, g);
  const names = (l) => l.map((p) => p.name);
  res.json({
    // Names only. Out-notes (declineReason) stay off this summary, even for a captain key.
    nextGame: g && { id: g.id, when: T.fmtGame(g.startsAt), startsAt: g.startsAt, location: g.location, address: g.address, in: names(h.in), maybe: names(h.maybe), out: names(h.out), noReply: names(h.none), status: h.level, message: h.message, keepers: names(h.keepers) },
    leaderboardTop5: leaderboard(d).map((x) => ({ name: x.player.name, points: x.total })),
    injuryReserve: team.activeInjuries(d).map((i) => ({ name: (d.players.find((p) => p.id === i.playerId) || {}).name, injury: i.injury, expectedReturn: i.expectedReturn })),
    automationsOn: d.settings.automationsOn !== false,
    health: health.report(d).totals,
  });
});
// For hosts that sleep: an external cron can POST here every few minutes (catch-up makes it safe).
r.post('/tick', (req, res) => { require('../lib/scheduler').beat(); res.json({ ok: true, at: new Date().toISOString() }); });
module.exports = r;
