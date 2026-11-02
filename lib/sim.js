// Fake-but-plausible player behavior, used to seed history and to dry-run a week.
// Nothing here touches the network.
const T = require('./time');
const team = require('./team');
const { tick } = require('./automation');
const { setRsvp, checkIn } = require('./actions');
const MIN = 60000;

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const expo = (r, mean) => -Math.log(1 - r()) * mean;

// How much each copy variant "works" in the fake world (the engine doesn't know these).
const LIFT = { invite: { A: 1, B: 1.15 }, wedNudge: { A: 0.75, B: 1.4 }, thuLastChance: { A: 1.3, B: 0.85 }, friAsk: { A: 0.9, B: 1.25 }, satUrgent: { A: 1, B: 1.15 }, keeperAlert: { A: 1, B: 1.1 }, checkinPrompt: { A: 1, B: 1 } };

function profiles(db, r) {
  const out = {};
  for (const p of db.players) {
    const sub = p.role === 'sub';
    out[p.id] = {
      respond: sub ? 0.35 + r() * 0.2 : 0.4 + r() * 0.35,
      attend: sub ? 0.5 : 0.62 + r() * 0.3,
      show: 0.82 + r() * 0.16,
      early: sub ? 0 : 0.12 + r() * 0.2,
      forgetCheckin: 0.25,
      prefMinute: [7 * 60 + 30, 12 * 60 + 15, 17 * 60 + 30, 19 * 60 + 45, 20 * 60 + 15][Math.floor(r() * 5)] + Math.floor(r() * 40),
    };
  }
  return out;
}

function chooseStatus(r, p, prof, current) {
  if (p.role === 'sub') return r() < 0.6 ? 'in' : r() < 0.8 ? 'out' : 'maybe';
  if (current === 'maybe') return r() < prof.attend ? 'in' : 'out';
  return r() < prof.attend ? 'in' : r() < 0.65 ? 'out' : 'maybe';
}

// Simulate one game's week from `from` to `to` (Dates). Mutates db.
function simulateGame(db, game, { from, to, seed = 1, outboxFile, tag, captainMarksNoShows = true, prof, result }) {
  const r = rng(seed);
  prof ||= profiles(db, rng(seed + 99));
  const start = new Date(game.startsAt), end = team.gameEnd(game);
  const events = []; // {at, fn}
  const add = (at, fn) => { if (at < to) events.push({ at: new Date(at), fn }); };
  const handled = new Set(db.messages ? db.messages.map((m) => m.id) : []);
  const forgot = new Set();
  // spontaneous early replies (via personal page) before the invite goes out
  for (const p of team.roster(db)) {
    if (team.isInjuredAt(db, p.id, from) || team.rsvpFor(db, game.id, p.id)) continue;
    if (r() < prof[p.id].early) {
      const day = T.localDate(from);
      const at = T.atLocalTime(day, Math.min(20 * 60 + 50, prof[p.id].prefMinute + Math.floor(r() * 30)));
      add(at > from ? at : new Date(from.getTime() + 60 * MIN), (iso) => setRsvp(db, p.id, game.id, chooseStatus(r, p, prof[p.id], null), iso, 'page'));
    }
  }
  let gameDone = false;
  for (let t = new Date(from); t <= to; t = new Date(t.getTime() + 10 * MIN)) {
    events.sort((a, b) => a.at - b.at);
    while (events.length && events[0].at <= t) { const e = events.shift(); e.fn(e.at.toISOString()); }
    tick(db, t, { rng: r, outboxFile, tag, gameIds: [game.id], force: true });
    for (const m of db.messages) {
      if (handled.has(m.id) || m.status !== 'sent' || m.gameId !== game.id) continue;
      handled.add(m.id);
      const p = db.players.find((x) => x.id === m.playerId); const pf = prof[p.id];
      const sent = new Date(m.sentAt);
      if (m.step === 'checkinPrompt') { if (forgot.has(p.id) && r() < 0.85) add(new Date(sent.getTime() + expo(r, 50) * MIN), (at) => checkIn(db, p.id, game.id, at, 'self')); continue; }
      if (['gameDay', 'recap'].includes(m.step)) continue;
      const cur = team.rsvpFor(db, game.id, p.id);
      if (cur && cur.status === 'in') continue;
      const near = Math.abs(T.minuteOfDay(sent) - pf.prefMinute) <= 90;
      const pr = Math.min(0.95, pf.respond * (LIFT[m.step] ? LIFT[m.step][m.variant] : 1) * (near ? 1.25 : 0.85));
      if (r() < pr) {
        const at = new Date(sent.getTime() + expo(r, near ? 45 : 150) * MIN);
        if (at < start) add(at, (iso) => { const c = team.rsvpFor(db, game.id, p.id); setRsvp(db, p.id, game.id, chooseStatus(r, p, pf, c && c.status), iso, 'email'); const last = team.rsvpFor(db, game.id, p.id).history.slice(-1)[0]; last.msgId = m.id; });
      }
    }
    if (!gameDone && t >= new Date(start.getTime() - 30 * MIN)) {
      gameDone = true;
      for (const p of team.activePlayers(db)) {
        const rv = team.rsvpFor(db, game.id, p.id);
        if (!rv || rv.status !== 'in') continue;
        if (r() < prof[p.id].show) {
          if (r() < prof[p.id].forgetCheckin) forgot.add(p.id);
          else add(new Date(start.getTime() - Math.floor(r() * 25) * MIN), (at) => checkIn(db, p.id, game.id, at, 'self'));
        } else if (r() < 0.5) add(new Date(start.getTime() - 90 * MIN), () => { rv.toldTeam = true; });
      }
      if (result) add(new Date(end.getTime() + 3 * 60 * MIN), () => { game.result = result; });
      if (captainMarksNoShows) add(new Date(end.getTime() + 20 * 60 * MIN), () => {
        for (const p of team.activePlayers(db)) { const rv = team.rsvpFor(db, game.id, p.id); if (rv && rv.status === 'in' && !team.checkinFor(db, game.id, p.id) && !rv.toldTeam) rv.noShow = true; }
      });
    }
  }
  events.sort((a, b) => a.at - b.at);
  for (const e of events) if (e.at <= to) e.fn(e.at.toISOString());
  return prof;
}

module.exports = { rng, profiles, simulateGame, LIFT };
