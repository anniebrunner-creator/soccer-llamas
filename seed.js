// Seeds data/db.json with clearly fake sample players and ~6 weeks of simulated history.
// Usage: node seed.js [--force]
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const T = require('./lib/time');
const { zonedToUtc } = T;
const { setRsvp } = require('./lib/actions');
const { leaderboard } = require('./lib/points');
const team = require('./lib/team');
const { simulateGame, profiles, rng } = require('./lib/sim');
const cfg = require('./config');

function seed({ force = false, now = new Date() } = {}) {
  if (fs.existsSync(store.FILE) && !force) { console.log('DB exists, not seeding (use --force).'); return store.load(); }
  const db = store.empty();
  db.settings = { captainName: 'Sample Captain', adminToken: cfg.adminToken, automationsOn: cfg.automation.onByDefault };
  db.messages = []; db.jobRuns = {}; db.standings = [];
  const outbox = path.resolve(__dirname, cfg.channels.email.outboxFile);
  if (fs.existsSync(outbox)) fs.unlinkSync(outbox);

  const names = ['Sample Sam', 'Demo Dana', 'Test Tess', 'Placeholder Pat', 'Example Elle', 'Mock Maya',
    'Faux Fran', 'Pretend Priya', 'Fictional Fi', 'Dummy Dee', 'Stand-in Stella', 'Prototype Paige'];
  const subNames = ['Backup Bea', 'Reserve Rae', 'Bench Billie'];
  const keepers = ['Test Tess', 'Mock Maya', 'Reserve Rae'];
  const P = {};
  [...names, ...subNames].forEach((name, i) => {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, '.');
    const p = { id: `p${i + 1}`, name, email: `${slug}@example.com`, phone: '', channel: 'email', token: store.token(), role: subNames.includes(name) ? 'sub' : 'roster', canKeep: keepers.includes(name), active: true, pausedUntil: null, joinedAt: '2026-08-15', card: { status: 'missing', date: null } };
    db.players.push(p); P[name.split(' ')[1]] = p.id;
  });
  const mt = (m, d, h, mi = 0) => zonedToUtc(2026, m, d, h, mi).toISOString();
  const STENGER = { location: 'Stenger Soccer Complex', address: '11200 W 58th Ave, Arvada, CO' };
  const ADDEN = { location: 'Addenbrooke Park', address: '601 S. Garrison St., Lakewood, CO' };
  const game = (gid, startsAt, loc, notes = '') => { db.games.push({ id: gid, startsAt, durationMin: 60, ...loc, opponent: '', notes, cancelled: false, calendarEventId: null, gameCardBy: null, result: null }); return gid; };

  // Past weeks (sample history so Team health has data)
  const past = [
    ['g_sep13', mt(9, 13, 11), STENGER], ['g_sep20', mt(9, 20, 11), STENGER], ['g_sep27', mt(9, 27, 9), ADDEN],
    ['g_oct04', mt(10, 4, 11), STENGER], ['g_oct11', mt(10, 11, 9), ADDEN], ['g_oct18', mt(10, 18, 11), STENGER],
  ].map(([gid, at, loc]) => game(gid, at, loc, 'Sample past game (simulated history).'));
  const g1 = game('g_oct25', mt(10, 25, 11), STENGER);
  const g2 = game('g_nov01', mt(11, 1, 11), STENGER, 'Clocks fall back the night before!');
  const g3 = game('g_nov08', mt(11, 8, 9), ADDEN, '9 am — earlier kickoff, different field.');
  for (const gid of [...past, g1, g2, g3]) db.games.find((g) => g.id === gid).gameCardBy = P.Tess;

  // Fees: requested Sep 1
  const req = mt(9, 1, 9);
  const fee = (k, paidAt, reminderSentAt = null) => db.fees.push({ id: store.id('f'), playerId: P[k], label: 'Fall 2026 fees', amount: 60, requestedAt: req, paidAt, reminderSentAt });
  fee('Sam', mt(9, 2, 12)); fee('Dana', mt(9, 3, 8)); fee('Tess', mt(9, 4, 20)); fee('Fran', mt(9, 1, 14));
  fee('Elle', mt(9, 6, 9)); fee('Fi', mt(9, 7, 17));
  fee('Pat', mt(9, 12, 10), mt(9, 10, 9)); fee('Maya', mt(9, 11, 19), mt(9, 10, 9)); fee('Paige', mt(9, 14, 8), mt(9, 10, 9));
  fee('Priya', null, mt(9, 10, 9)); fee('Dee', null, mt(9, 10, 9)); fee('Stella', null);
  for (const k of ['Sam', 'Fran', 'Tess', 'Fi', 'Elle']) db.players.find((p) => p.id === P[k]).card = { status: 'before_asked', date: '2026-08-28' };
  for (const k of ['Dana', 'Pat', 'Maya', 'Paige']) db.players.find((p) => p.id === P[k]).card = { status: 'after_asked', date: '2026-09-15' };

  // Injury (Stella, since Oct 11)
  db.injuries.push({ id: store.id('i'), playerId: P.Stella, injury: 'Sprained ankle', dateInjured: '2026-10-11', expectedReturn: '2026-11-08', cleared: false, clearedAt: null, addedBy: 'player', addedAt: mt(10, 12, 9) });
  // A second, vaguer injury whose expected return already passed -> gets one 'Ready to come back?' check-in
  db.injuries.push({ id: store.id('i'), playerId: P.Pat, injury: 'Tweaked hamstring', dateInjured: '2026-10-05', expectedReturn: '2026-10-18', cleared: false, clearedAt: null, addedBy: 'player', addedAt: mt(10, 5, 18) });
  // One player paused messages (shows the pause feature)
  Object.assign(db.players.find((p) => p.id === P.Dee), { pausedAt: mt(10, 14, 20), pausedUntil: mt(11, 2, 0) });

  // Simulate each past week through the real automation engine
  const prof = profiles(db, rng(42));
  const outcomes = [];
  past.forEach((gid, i) => {
    const g = db.games.find((x) => x.id === gid);
    const from = T.atLocalTime(T.shiftDay(T.localDate(g.startsAt), -6), 0);
    let to = T.atLocalTime(T.shiftDay(T.localDate(g.startsAt), 1), 12 * 60);
    if (to > now) to = now;
    simulateGame(db, g, { from, to, seed: 1000 + i, outboxFile: cfg.channels.email.outboxFile, tag: 'history', prof });
    const present = db.checkins.filter((c) => c.gameId === gid).length;
    const r = rng(7 + i); const us = Math.max(0, Math.round((present - 7) * 0.6 + r() * 3)); const them = Math.round(r() * 3.5 + (present < 9 ? 1.5 : 0));
    g.result = { outcome: us > them ? 'W' : us < them ? 'L' : 'T', us, them };
    outcomes.push(g.result.outcome);
  });
  // Division standing as the captain would enter it
  let place = 7;
  past.forEach((gid, i) => {
    const o = outcomes[i]; place = Math.max(2, Math.min(8, place + (o === 'W' ? -1 : o === 'L' ? 1 : 0)));
    const g = db.games.find((x) => x.id === gid);
    db.standings.push({ id: store.id('s'), date: T.toLocalInputs(new Date(new Date(g.startsAt).getTime() + 30 * 3600000)).date, place, of: 8, division: 'Women\'s B', note: '' });
  });

  // Awards from the last game
  const award = (k, type, date, note, gameId = null) => db.awards.push({ id: store.id('a'), playerId: P[k], type, date, note, gameId });
  award('Maya', 'sub_keeper', mt(10, 18, 12), 'Kept goal 2nd half', 'g_oct18');
  award('Dana', 'referral', '2026-08-20T18:00:00.000Z', 'Brought in Prototype Paige');
  award('Fran', 'gameday_help', mt(10, 18, 12), 'Pinnies', 'g_oct18');
  award('Sam', 'gameday_help', mt(10, 18, 12), 'Nets', 'g_oct18');
  award('Tess', 'gameday_help', mt(10, 11, 10), 'Game card', 'g_oct11');

  // This week (Oct 25): a few early replies via personal pages, before the Monday invite
  const early = [['Sam', 'in', mt(10, 18, 15)], ['Tess', 'in', mt(10, 18, 16)], ['Fran', 'in', mt(10, 18, 17)],
    ['Elle', 'in', mt(10, 18, 19)], ['Fi', 'in', mt(10, 18, 20)], ['Paige', 'maybe', mt(10, 18, 21)], ['Stella', 'out', mt(10, 18, 12)],
    ['Maya', 'in', mt(10, 19, 6, 15)], ['Dana', 'maybe', mt(10, 19, 6, 20)]];
  for (const [k, s, at] of early) if (new Date(at) <= now) setRsvp(db, P[k], g1, s, at, 'page');
  for (const [k, s] of [['Sam', 'in'], ['Fran', 'in'], ['Tess', 'in'], ['Stella', 'out']]) setRsvp(db, P[k], g2, s, mt(10, 18, 18), 'page');
  setRsvp(db, P.Fran, g3, 'in', mt(10, 18, 18, 5), 'page');

  store.set(db);
  db.pinnies = { holders: leaderboard(db, cfg.pinnies.holders).map((x) => x.player.id), recordedAt: mt(10, 18, 12, 30), note: 'Handed off after Oct 18 game' };
  store.save();
  console.log(`Seeded ${store.FILE}: ${db.messages.length} message records, ${db.rsvps.length} RSVPs, ${db.checkins.length} check-ins`);
  console.log(`  Captain link:     ${cfg.baseUrl}/admin?key=${db.settings.adminToken}`);
  for (const p of db.players) console.log(`  ${p.name.padEnd(16)} ${cfg.baseUrl}/p/${p.token}`);
  return db;
}

if (require.main === module) seed({ force: process.argv.includes('--force') });
module.exports = seed;
