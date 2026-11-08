// The weekly flow: decides who gets which message when, then "sends" via channels.
// Pure-ish: everything operates on a db object passed in, so the same engine runs live
// (lib/scheduler.js) and in simulations (scripts/simulate-week.js, seed.js).
const cfg = require('../config');
const COPY = require('../messages');
const T = require('./time');
const team = require('./team');
const { leaderboard, computePoints } = require('./points');
const { id } = require('./store');
const { channels, pickChannel } = require('./channels');
const { variantStats, median } = require('./analytics');

const A = cfg.automation;
const MIN = 60000, HOUR = 3600000;
const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const QS = hm(A.quietHours.start), QE = hm(A.quietHours.end);

function isQuiet(d) { const m = T.minuteOfDay(d); return QS > QE ? (m >= QS || m < QE) : (m >= QS && m < QE); }
function afterQuiet(d) {
  if (!isQuiet(d)) return new Date(d);
  const ld = T.localDate(d);
  const day = T.minuteOfDay(d) >= QS ? T.shiftDay(ld, 1) : ld;
  return T.atLocalTime(day, QE);
}

function dueAt(step, game) {
  if (step.at.fromStart != null) return new Date(new Date(game.startsAt).getTime() + step.at.fromStart * MIN);
  if (step.at.fromEnd != null) return new Date(team.gameEnd(game).getTime() + step.at.fromEnd * MIN);
  return T.atLocalTime(T.shiftDay(T.localDate(game.startsAt), step.at.day), hm(step.at.time));
}
const shiftMs = (step) => (step.learn && A.sendTimeLearning.enabled ? A.sendTimeLearning.maxShiftHours * HOUR : 0);
function timing(step, game) {
  const due = dueAt(step, game);
  const start = new Date(game.startsAt);
  const planAt = new Date(due.getTime() - shiftMs(step));
  let expires = new Date(due.getTime() + (step.expiresHours || 20) * HOUR);
  if (due < start && expires > start) expires = start;
  let latest = null;
  if (step.latest === 'kickoff') latest = new Date(start.getTime() - 30 * MIN);
  else if (step.latest === 'thursdayDeadline') latest = new Date(T.rsvpWindows(game.startsAt).thursdayEnd.getTime() - 60 * MIN);
  else latest = expires;
  return { due, planAt, expires, latest };
}

// ---- who
const statusOf = (db, game, p) => { const r = team.rsvpFor(db, game.id, p.id); return r ? r.status : null; };
function reliability(db, p) {
  let saidIn = 0, came = 0, asked = 0, answered = 0;
  for (const g of db.games) {
    const r = team.rsvpFor(db, g.id, p.id);
    if (r && r.history.length) { asked++; answered++; } // simple: any answer = responsive
    if (r && r.status === 'in' && team.gameEnd(g) < new Date()) { saidIn++; if (team.checkinFor(db, g.id, p.id)) came++; }
  }
  return 0.7 * ((came + 1) / (saidIn + 2)) + 0.3 * ((answered + 1) / (asked + 2));
}
function audience(db, step, game) {
  const R = team.roster(db), S = team.subs(db), all = [...R, ...S];
  const st = (p) => statusOf(db, game, p);
  switch (step.audience) {
    case 'roster': return R.map((p) => ({ p }));
    case 'nonResponders': return R.filter((p) => !st(p)).map((p) => ({ p }));
    case 'nonRespondersAndMaybes': return all.filter((p) => (p.role !== 'sub' && !st(p)) || st(p) === 'maybe').map((p) => ({ p }));
    case 'maybesThenSubs': {
      const maybes = all.filter((p) => st(p) === 'maybe').map((p) => ({ p }));
      const h = team.headcount(db, game);
      const k = Math.max(0, cfg.roster.comfyBuffer - h.in.length - maybes.length) + 1;
      const ranked = S.filter((p) => !st(p)).sort((a, b) => reliability(db, b) - reliability(db, a)).slice(0, k);
      return [...maybes, ...ranked.map((p) => ({ p, delay: step.subsDelayMinutes || 60 }))];
    }
    case 'notOut': return all.filter((p) => st(p) !== 'out' && (p.role !== 'sub' || true)).map((p) => ({ p }));
    case 'ins': return all.filter((p) => st(p) === 'in').map((p) => ({ p }));
    case 'insNotCheckedIn': return all.filter((p) => st(p) === 'in' && !team.checkinFor(db, game.id, p.id)).map((p) => ({ p }));
    case 'recap': return all.filter((p) => p.role !== 'sub' || st(p) === 'in').map((p) => ({ p }));
    default: return [];
  }
}
function stillInAudience(db, step, game, p) {
  if (step.audience === 'maybesThenSubs') { const s = statusOf(db, game, p); return s === 'maybe' || (p.role === 'sub' && !s); }
  return audience(db, step, game).some((x) => x.p.id === p.id);
}
function conditionHolds(db, step, game) {
  if (!step.when) return true;
  const h = team.headcount(db, game);
  if (step.when === 'belowComfy') return h.in.length < cfg.roster.comfyBuffer;
  if (step.when === 'belowMinimum') return h.in.length < cfg.roster.minPlayers;
  if (step.when === 'noKeeper') return h.keepers.length === 0;
  return true;
}
function skipReason(db, game, p, now) {
  if (team.isPausedAt(p, now)) return 'paused messages';
  if (team.isInjuredAt(db, p.id, now)) return 'on injury reserve';
  if (statusOf(db, game, p) === 'out') return 'already said Out';
  return null;
}

// ---- when (per-player send-time learning)
function preferredMinute(db, p, before) {
  const evs = [];
  for (const r of db.rsvps) if (r.playerId === p.id) for (const h of r.history) if (new Date(h.at) < before) evs.push(T.minuteOfDay(h.at));
  if (evs.length < A.sendTimeLearning.minEvents) return null;
  const m = median(evs);
  return m >= QS || m < QE ? null : m; // ignore night-owl medians
}
function sendTimeFor(db, step, p, t, now) {
  let at = new Date(t.due.getTime());
  if (step.learn && A.sendTimeLearning.enabled) {
    const pm = preferredMinute(db, p, now);
    if (pm != null) {
      const target = T.atLocalTime(T.localDate(t.due), pm).getTime();
      const s = shiftMs(step);
      at = new Date(Math.min(t.due.getTime() + s, Math.max(t.due.getTime() - s, target)));
    }
  }
  if (at < now) at = new Date(now);
  return afterQuiet(at);
}

// ---- which copy (A/B: even split until N sends each, then mostly the winner)
function makeChooser(db, step, rng) {
  const stats = variantStats(db)[step.key];
  const counts = { A: stats.variants.A.sends, B: stats.variants.B.sends };
  return () => {
    let v;
    const ready = counts.A >= A.abTest.minSendsPerVariant && counts.B >= A.abTest.minSendsPerVariant;
    if (!ready || step.goal === 'none') v = counts.A <= counts.B ? 'A' : 'B';
    else if (rng() < A.abTest.explore) v = rng() < 0.5 ? 'A' : 'B';
    else v = stats.winner || (stats.variants.A.smoothed >= stats.variants.B.smoothed ? 'A' : 'B');
    counts[v]++;
    return v;
  };
}

// ---- what (render copy)
function personalLinks(p, game, msgId) {
  const b = cfg.baseUrl + '/p/' + p.token;
  const go = (s) => `${b}/go/${game.id}/${s}?m=${msgId}`;
  return { inLink: go('in'), outLink: go('out'), maybeLink: go('maybe'), pageLink: b, pauseLink: b + '/pause' };
}
function llamaOfWeek(db, game, now) {
  const from = T.atLocalTime(T.shiftDay(T.localDate(game.startsAt), -6), 0).getTime();
  const pts = computePoints(db);
  let best = null;
  for (const p of team.activePlayers(db)) {
    const wk = pts[p.id].items.filter((i) => i.at && new Date(i.at).getTime() >= from && new Date(i.at) <= now).reduce((s, i) => s + i.pts, 0);
    if (wk > 0 && (!best || wk > best.pts)) best = { p, pts: wk };
  }
  return best ? `${best.p.name} (+${best.pts} this week)` : 'the whole herd';
}
function render(db, msg, game, p, now) {
  const h = team.headcount(db, game);
  const gc = db.players.find((x) => x.id === game.gameCardBy);
  const r = game.result;
  const vars = {
    name: p.name.split(' ')[0] === 'Sample' ? p.name : p.name, date: T.fmtDay(game.startsAt), time: T.fmtTime(game.startsAt),
    location: game.location, address: game.address, map: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(game.address)}`,
    count: h.in.length, need: Math.max(0, (msg.step === 'friAsk' ? cfg.roster.comfyBuffer : cfg.roster.minPlayers) - h.in.length),
    target: cfg.roster.comfyBuffer, min: cfg.roster.minPlayers, deadline: '11:59 pm',
    pinnies: cfg.pinnies.custody, gameCard: gc ? gc.name : (db.settings.captainName || 'captain'),
    keeper: h.keepers.map((x) => x.name).join(', ') || 'none yet',
    leaderboard: leaderboard(db).map((x, i) => `${i + 1}. ${x.player.name} — ${x.total}`).join('\n'),
    llamaOfWeek: llamaOfWeek(db, game, now),
    result: r && r.outcome ? `${{ W: 'Win', L: 'Loss', T: 'Tie' }[r.outcome]} ${r.us}–${r.them}` : 'result coming soon',
    present: db.checkins.filter((c) => c.gameId === game.id).length,
    ...personalLinks(p, game, msg.id),
  };
  const tpl = COPY[msg.step][msg.variant];
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
  return { subject: fill(tpl.subject), body: fill(tpl.body) };
}

// ---- plan a step for one game
function runStep(db, game, step, t, now, rng) {
  const key = `${game.id}:${step.key}`;
  if (!conditionHolds(db, step, game)) { db.jobRuns[key] = { status: 'not needed', ranAt: now.toISOString(), dueAt: t.due.toISOString() }; return; }
  const choose = makeChooser(db, step, rng);
  let queued = 0, skipped = 0;
  for (const { p, delay } of audience(db, step, game)) {
    const m = { id: id('m'), gameId: game.id, step: step.key, variant: null, channel: pickChannel(p), playerId: p.id, to: p.email, createdAt: now.toISOString(), latestAt: t.latest.toISOString(), status: 'queued' };
    const why = skipReason(db, game, p, now);
    if (why) { Object.assign(m, { status: 'skipped', reason: why, scheduledFor: t.due.toISOString() }); skipped++; }
    else {
      let at = sendTimeFor(db, step, p, t, now);
      if (delay) at = afterQuiet(new Date(at.getTime() + delay * MIN));
      if (at > t.latest) Object.assign(m, { status: 'skipped', reason: 'quiet hours / too late', scheduledFor: at.toISOString() });
      else { m.variant = choose(); m.scheduledFor = at.toISOString(); m.shiftMinutes = Math.round((at - t.due) / MIN); queued++; }
    }
    db.messages.push(m);
  }
  db.jobRuns[key] = { status: 'done', ranAt: now.toISOString(), dueAt: t.due.toISOString(), queued, skipped, late: now - t.planAt > 15 * MIN };
}

// ---- deliver queued messages whose time has come
function dispatch(db, now, opts) {
  if (isQuiet(now)) return 0;
  let n = 0;
  const weekAgo = now.getTime() - 7 * 24 * HOUR;
  for (const m of db.messages) {
    if (m.kind || m.status !== 'queued' || new Date(m.scheduledFor) > now) continue;
    const game = db.games.find((g) => g.id === m.gameId);
    const p = db.players.find((x) => x.id === m.playerId);
    const step = A.steps.find((s) => s.key === m.step);
    let why = !game || game.cancelled ? 'game cancelled' : !p || p.active === false ? 'player inactive' : skipReason(db, game, p, now);
    if (!why && new Date(m.latestAt) < now) why = 'too late (server was off)';
    if (!why && step.audience === 'roster' && step.goal === 'rsvp' && statusOf(db, game, p)) why = 'already answered';
    if (!why && !stillInAudience(db, step, game, p)) why = step.goal === 'checkin' ? 'already checked in' : 'already answered';
    if (!why && !conditionHolds(db, step, game)) why = 'not needed anymore';
    if (!why) {
      const recent = db.messages.filter((x) => x.playerId === p.id && x.status === 'sent' && new Date(x.sentAt).getTime() > weekAgo).length;
      if (recent >= A.weeklyCapPerPlayer) why = 'weekly message limit';
    }
    if (why) { m.status = 'skipped'; m.reason = why; continue; }
    Object.assign(m, render(db, m, game, p, now));
    m.sentAt = now.toISOString();
    try { const r = channels[m.channel].send(m, opts); m.status = 'sent'; m.delivery = r.delivery; if (opts.tag) m.tag = opts.tag; n++; }
    catch (e) { m.status = 'failed'; m.reason = e.message; }
  }
  return n;
}

// Injury reserve: one gentle "Ready to come back?" after the expected return date passes.
function irChecks(db, now, opts) {
  const today = T.toLocalInputs(now).date;
  for (const i of db.injuries) {
    if (i.cleared || !i.expectedReturn || i.returnCheckAt || i.expectedReturn >= today) continue;
    const p = db.players.find((x) => x.id === i.playerId);
    if (!p || p.active === false) continue;
    const [y, mo, d] = i.expectedReturn.split('-').map(Number);
    const at = afterQuiet(T.atLocalTime(T.shiftDay({ y, m: mo, d }, 1), hm(A.irCheckTime)));
    if (at > now) continue;
    i.returnCheckAt = now.toISOString();
    const m = { id: id('m'), gameId: null, injuryId: i.id, step: 'irCheck', variant: 'A', channel: pickChannel(p), playerId: p.id, to: p.email, createdAt: now.toISOString(), scheduledFor: now.toISOString(), status: 'queued' };
    if (team.isPausedAt(p, now)) { m.status = 'skipped'; m.reason = 'paused messages'; db.messages.push(m); continue; }
    const base = cfg.baseUrl + '/p/' + p.token;
    const vars = { name: p.name, returnDate: T.fmtDate(i.expectedReturn), clearLink: `${base}/ir/${i.id}/cleared`, pageLink: base, pauseLink: base + '/pause' };
    const tpl = COPY.irCheck.A; const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
    Object.assign(m, { subject: fill(tpl.subject), body: fill(tpl.body), sentAt: now.toISOString() });
    try { m.delivery = channels[m.channel].send(m, opts).delivery; m.status = 'sent'; if (opts.tag) m.tag = opts.tag; } catch (e) { m.status = 'failed'; m.reason = e.message; }
    db.messages.push(m);
  }
}

// One scheduler heartbeat. Runs due steps (catching up anything missed while off, until
// that step's window expires), then dispatches. Returns true if db changed.
function tick(db, now = new Date(), opts = {}) {
  db.messages ||= []; db.jobRuns ||= {};
  if (db.settings.automationsOn === false && !opts.force) return false;
  const rng = opts.rng || Math.random;
  const before = db.messages.length + Object.keys(db.jobRuns).length;
  const lookFrom = now.getTime() - 4 * 24 * HOUR, lookTo = now.getTime() + 9 * 24 * HOUR;
  for (const g of db.games) {
    if (g.cancelled || (opts.gameIds && !opts.gameIds.includes(g.id))) continue;
    const s = new Date(g.startsAt).getTime();
    if (s < lookFrom || s > lookTo) continue;
    for (const step of A.steps) {
      const key = `${g.id}:${step.key}`;
      if (db.jobRuns[key]) continue;
      const t = timing(step, g);
      if (now < t.planAt) continue;
      if (now > t.expires) { db.jobRuns[key] = { status: 'missed', ranAt: now.toISOString(), dueAt: t.due.toISOString() }; continue; }
      runStep(db, g, step, t, now, rng);
    }
  }
  const sent = dispatch(db, now, opts);
  if (!isQuiet(now)) irChecks(db, now, opts);
  return sent > 0 || db.messages.length + Object.keys(db.jobRuns).length !== before || db.messages.some((m) => m._dirty);
}

// For the captain's "coming up automatically" list
function schedule(db, game) {
  return A.steps.map((step) => {
    const t = timing(step, game);
    const run = (db.jobRuns || {})[`${game.id}:${step.key}`];
    const msgs = (db.messages || []).filter((m) => m.gameId === game.id && m.step === step.key);
    return { step, due: t.due, run, sent: msgs.filter((m) => m.status === 'sent').length, skipped: msgs.filter((m) => m.status === 'skipped').length, queued: msgs.filter((m) => m.status === 'queued').length };
  });
}

module.exports = { tick, schedule, timing, isQuiet, afterQuiet, reliability, preferredMinute, render };
