// Llama Points: computed fresh from raw data every time (nothing stored).
const cfg = require('../config');
const { rsvpWindows } = require('./time');
const P = cfg.points;
const DAY = 86400000;

function statusAt(rsvp, when) {
  let s = null;
  for (const h of rsvp.history || []) if (new Date(h.at) <= when) s = h.status;
  return s;
}

function computePoints(db, now = new Date()) {
  const out = {};
  for (const p of db.players) out[p.id] = { playerId: p.id, total: 0, items: [] };
  const add = (pid, rule, at, note) => {
    if (!out[pid]) return;
    out[pid].items.push({ rule, label: P[rule].label, pts: P[rule].pts, at, note: note || '' });
    out[pid].total += P[rule].pts;
  };
  const games = Object.fromEntries(db.games.map((g) => [g.id, g]));

  for (const r of db.rsvps) {
    const g = games[r.gameId];
    if (!g || g.cancelled) continue;
    const start = new Date(g.startsAt);
    const w = rsvpWindows(g.startsAt);
    const label = new Date(g.startsAt).toISOString().slice(0, 10);
    const first = (r.history || []).find((h) => cfg.rsvpBonusStatuses.includes(h.status) && new Date(h.at) < start);
    if (first) {
      const t = new Date(first.at);
      if (t <= w.thursdayEnd) add(r.playerId, 'rsvpByThursday', first.at, `game ${label}`);
      else if (t >= w.dayBeforeStart && t <= w.dayBeforeEnd) add(r.playerId, 'rsvpSaturday', first.at, `game ${label}`);
    }
    const saidIn = statusAt(r, start) === 'in';
    const checked = db.checkins.find((c) => c.gameId === g.id && c.playerId === r.playerId);
    if (saidIn && checked) add(r.playerId, 'showedUp', checked.at, `game ${label}`);
    if (saidIn && !checked && r.noShow && !r.toldTeam) add(r.playerId, 'noShow', g.startsAt, `game ${label}`);
  }

  for (const f of db.fees) {
    if (!f.paidAt) continue;
    const paid = new Date(f.paidAt), req = new Date(f.requestedAt);
    if (!f.reminderSentAt && paid - req <= cfg.feeOnTimeDays * DAY) add(f.playerId, 'feesOnTime', f.paidAt, f.label);
    else if (f.reminderSentAt) add(f.playerId, 'feesAfterReminder', f.paidAt, f.label);
  }

  for (const p of db.players) if (p.card && p.card.status === 'before_asked') add(p.id, 'playerCardEarly', p.card.date, '');

  const awardRule = { sub_keeper: 'subOrKeeper', referral: 'referral', gameday_help: 'gameDayHelp' };
  for (const a of db.awards) if (awardRule[a.type]) add(a.playerId, awardRule[a.type], a.date, a.note);

  for (const k in out) out[k].items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out;
}

// Public top-N only (score > 0). Ties broken by name for stability.
function leaderboard(db, n = cfg.leaderboardSize) {
  const pts = computePoints(db);
  const active = db.players.filter((p) => p.active !== false);
  return active
    .map((p) => ({ player: p, total: pts[p.id].total }))
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total || a.player.name.localeCompare(b.player.name))
    .slice(0, n);
}

module.exports = { computePoints, leaderboard, statusAt };
