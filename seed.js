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
  // All dates are relative to "now" so the demo always looks mid-season (8 games played, 3 to go).
  const today = T.localDate(now);
  const toSun = (7 - today.dow) % 7 || 7; // next Sunday (today counts as played if it's Sunday)
  const sunDay = (k) => T.shiftDay(today, toSun + 7 * k);
  const at = (day, off, h, mi = 0) => { const x = T.shiftDay(day, off); return zonedToUtc(x.y, x.m, x.d, h, mi).toISOString(); };
  const sun = (k, h, mi = 0) => at(sunDay(k), 0, h, mi);
  const ymd = (day, off = 0) => { const x = T.shiftDay(day, off); return `${x.y}-${String(x.m).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`; };
  const STENGER = { location: 'Stenger Soccer Complex', address: '11200 W 58th Ave, Arvada, CO' };
  const ADDEN = { location: 'Addenbrooke Park', address: '601 S. Garrison St., Lakewood, CO' };
  const OPP = ['Kickin\' Chickens', 'Net Ninjas', 'Grass Stains', 'Hat Trick Hens', 'Mud Puppies', 'Sole Sisters', 'Offside Otters', 'Pitch Please', 'Turf Turtles', 'Goal Diggers', 'Shin Diggers'];
  const game = (gid, startsAt, loc, notes = '', opponent = '') => { db.games.push({ id: gid, startsAt, durationMin: 60, ...loc, opponent, notes, cancelled: false, calendarEventId: null, gameCardBy: null, result: null }); return gid; };

  // Past weeks (sample history so Team health has data)
  const past = [-8, -7, -6, -5, -4, -3, -2, -1].map((k, i) => game(`g_w${i + 1}`, sun(k, i % 3 === 2 ? 9 : 11), i % 3 === 2 ? ADDEN : STENGER, 'Sample past game (simulated history).', OPP[i]));
  const g1 = game('g_w9', sun(0, 11), STENGER, 'Bring both pinnie colors — we might be the away team.', OPP[8]);
  const g2 = game('g_w10', sun(1, 9), ADDEN, '9 am — earlier kickoff, different field.', OPP[9]);
  const g3 = game('g_w11', sun(2, 11), STENGER, 'Last regular-season game, then team happy hour 🍻', OPP[10]);
  for (const gid of [...past, g1, g2, g3]) db.games.find((g) => g.id === gid).gameCardBy = P.Tess;
  const start = sunDay(-8);

  // Fees: requested the week before the first game. Paid by cash, check or any app; the captain just taps "Paid".
  const req = at(start, -6, 9);
  const fee = (k, dPaid, dRem = null) => db.fees.push({ id: store.id('f'), playerId: P[k], label: 'Season fees', amount: 60, requestedAt: req, paidAt: dPaid == null ? null : at(start, -6 + dPaid, 12), reminderSentAt: dRem == null ? null : at(start, -6 + dRem, 9) });
  fee('Sam', 1); fee('Dana', 2); fee('Tess', 3); fee('Fran', 0); fee('Elle', 5); fee('Fi', 6);
  fee('Pat', 11, 9); fee('Maya', 10, 9); fee('Paige', 13, 9);
  fee('Priya', null, 9); fee('Dee', null, 9); fee('Stella', null);
  for (const k of ['Sam', 'Fran', 'Tess', 'Fi', 'Elle']) db.players.find((p) => p.id === P[k]).card = { status: 'before_asked', date: ymd(start, -10) };
  for (const k of ['Dana', 'Pat', 'Maya', 'Paige']) db.players.find((p) => p.id === P[k]).card = { status: 'after_asked', date: ymd(start, 2) };

  // Injury reserve: Stella (ankle, back for the next-next game), Pat (return date passed -> "Ready to come back?" check)
  db.injuries.push({ id: store.id('i'), playerId: P.Stella, injury: 'Sprained ankle', dateInjured: ymd(sunDay(-3)), expectedReturn: ymd(sunDay(1)), cleared: false, clearedAt: null, addedBy: 'player', addedAt: at(sunDay(-3), 1, 9) });
  db.injuries.push({ id: store.id('i'), playerId: P.Pat, injury: 'Tweaked hamstring', dateInjured: ymd(sunDay(-4)), expectedReturn: ymd(sunDay(-2)), cleared: false, clearedAt: null, addedBy: 'player', addedAt: at(sunDay(-4), 0, 18) });
  db.injuries.push({ id: store.id('i'), playerId: P.Elle, injury: 'Sore knee', dateInjured: ymd(sunDay(-7)), expectedReturn: ymd(sunDay(-5)), cleared: true, clearedAt: at(sunDay(-5), -2, 19), addedBy: 'player', addedAt: at(sunDay(-7), 0, 15) });
  // One player paused messages (shows the pause feature)
  Object.assign(db.players.find((p) => p.id === P.Dee), { pausedAt: at(sunDay(-2), -3, 20), pausedUntil: at(sunDay(0), 2, 0) });
  const mt = null; // (old fixed-date helper removed)

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
  const L1 = past[7], L2 = past[6], L3 = past[5];
  const gAt = (gid) => db.games.find((g) => g.id === gid).startsAt;
  award('Maya', 'sub_keeper', gAt(L1), 'Kept goal 2nd half', L1);
  award('Rae', 'sub_keeper', gAt(L3), 'Subbed in when we had 7', L3);
  award('Dana', 'referral', at(start, -20, 12), 'Brought in Prototype Paige');
  award('Fran', 'gameday_help', gAt(L1), 'Pinnies', L1);
  award('Sam', 'gameday_help', gAt(L1), 'Nets', L1);
  award('Tess', 'gameday_help', gAt(L2), 'Game card', L2);
  award('Elle', 'gameday_help', gAt(L3), 'Corner flags', L3);

  // Next game: a realistic mid-week picture (some In, a couple Maybe, injured Out, several not answered yet)
  const wk = sunDay(0); const lastSun = sunDay(-1);
  const early = [['Sam', 'in', at(lastSun, 0, 15)], ['Tess', 'in', at(lastSun, 0, 16)], ['Fran', 'in', at(lastSun, 0, 17)],
    ['Elle', 'in', at(lastSun, 0, 19)], ['Fi', 'in', at(lastSun, 0, 20)], ['Paige', 'maybe', at(lastSun, 0, 21)], ['Stella', 'out', at(lastSun, 0, 12)],
    ['Maya', 'in', at(wk, -6, 6, 15)], ['Dana', 'maybe', at(wk, -6, 6, 20)], ['Rae', 'in', at(wk, -6, 7, 5)]];
  for (const [k, s, t] of early) if (new Date(t) <= now) setRsvp(db, P[k], g1, s, t, 'page');
  for (const [k, s] of [['Sam', 'in'], ['Fran', 'in'], ['Tess', 'in'], ['Maya', 'in'], ['Stella', 'out']]) setRsvp(db, P[k], g2, s, at(lastSun, 0, 18), 'page');
  setRsvp(db, P.Fran, g3, 'in', at(lastSun, 0, 18, 5), 'page');

  store.set(db);
  db.pinnies = { holders: leaderboard(db, cfg.pinnies.holders).map((x) => x.player.id), recordedAt: at(lastSun, 0, 12, 30), note: 'Handed off after last Sunday\'s game' };
  store.save();
  console.log(`Seeded ${store.FILE}: ${db.messages.length} message records, ${db.rsvps.length} RSVPs, ${db.checkins.length} check-ins`);
  console.log(`  Captain link:     ${cfg.baseUrl}/admin?key=${db.settings.adminToken}`);
  for (const p of db.players) console.log(`  ${p.name.padEnd(16)} ${cfg.baseUrl}/p/${p.token}`);
  return db;
}

if (require.main === module) seed({ force: process.argv.includes('--force') });
module.exports = seed;
