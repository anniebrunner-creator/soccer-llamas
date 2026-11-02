const express = require('express');
const path = require('path');
const fs = require('fs');
const cfg = require('./config');
const store = require('./lib/store');
const T = require('./lib/time');
const team = require('./lib/team');
const { computePoints, leaderboard } = require('./lib/points');
const { setRsvp, checkIn } = require('./lib/actions');
const { esc, mapLink, chips, statusWord, layout } = require('./lib/views');

const fresh = !fs.existsSync(store.FILE);
if (fresh) require('./seed')({ force: true });
store.load();
const demo = cfg.demo ? require('./lib/demo') : null;
if (demo && (fresh || !fs.existsSync(demo.SNAP))) demo.saveSnapshot();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex'); next(); });

const db = () => store.get();
const back = (res, url, msg) => { const [u, h] = url.split('#'); res.redirect(303, u + (msg ? (u.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(msg) : '') + (h ? '#' + h : '')); };

// ---------- shared bits
function gameHeader(g) {
  return `<div class="kick">${esc(T.fmtGame(g.startsAt))}</div>
  <div class="where">📍 <a href="${mapLink(g.address || g.location)}" target="_blank" rel="noopener">${esc(g.location)}</a> · ${esc(g.address)}</div>
  ${g.notes ? `<div class="hint">${esc(g.notes)}</div>` : ''}`;
}
function headcountBlock(d, g) {
  const h = team.headcount(d, g);
  const n = h.in.length, max = Math.max(cfg.roster.comfyBuffer + 2, n);
  const pct = (x) => Math.min(100, (x / max) * 100);
  const color = h.level === 'short' ? 'var(--red)' : h.level === 'ok' ? 'var(--amber)' : 'var(--green)';
  const keeper = h.keepers.length
    ? `<span class="pill good">🧤 Keeper: ${h.keepers.map((p) => esc(p.name)).join(', ')}</span>`
    : `<span class="pill bad">🧤 No keeper yet</span>${h.maybeKeepers.length ? ` <span class="small muted">(maybe: ${h.maybeKeepers.map((p) => esc(p.name)).join(', ')})</span>` : ''}`;
  return `<div class="counts"><div class="count in"><b>${n}</b><span>In</span></div><div class="count"><b>${h.maybe.length}</b><span>Maybe</span></div><div class="count"><b>${h.out.length}</b><span>Out</span></div></div>
  <div class="meter"><i style="width:${pct(n)}%;background:${color}"></i><span class="tick" style="left:${pct(cfg.roster.minPlayers)}%"></span><span class="tick" style="left:${pct(cfg.roster.comfyBuffer)}%;opacity:.4"></span></div>
  <div class="meter-l"><span>0</span><span>need ${cfg.roster.minPlayers} · comfy ${cfg.roster.comfyBuffer}</span></div>
  <div class="banner ${h.level}">${h.level === 'short' ? '🚨' : h.level === 'ok' ? '👍' : '🎉'} ${esc(h.message)}</div>
  <div>${keeper}</div>
  <div class="names"><span class="lab">In:</span>${chips(h.in, 'y')}</div>
  <div class="names"><span class="lab">Maybe:</span>${chips(h.maybe)}</div>
  <div class="names"><span class="lab">Out:</span>${chips(h.out)}</div>
  ${h.none.length ? `<div class="names small muted"><span class="lab">No reply yet:</span>${h.none.map((p) => esc(p.name)).join(', ')}</div>` : ''}`;
}
function irBlock(d, { compact = false } = {}) {
  const list = team.activeInjuries(d).sort((a, b) => String(a.expectedReturn || '9').localeCompare(String(b.expectedReturn || '9')));
  return `<div class="card ir-card"><h2>🩹 Injury reserve ${list.length ? `<span class="pill">${list.length}</span>` : ''}</h2>${list.length ? `<ul class="clean ir">${list.map((i) => {
    const p = d.players.find((x) => x.id === i.playerId);
    const overdue = i.expectedReturn && i.expectedReturn < T.todayLocalStr();
    return `<li class="ir-row"><span class="ir-llama">🦙💛</span><div><b>${esc(p ? p.name : '?')}</b> — ${i.injury ? esc(i.injury) : '<span class="muted">resting up</span>'}
      <div class="small muted">Hurt ${esc(T.fmtDate(i.dateInjured))} · ${i.expectedReturn ? `${overdue ? 'was hoping for' : 'back'} ~${esc(T.fmtDate(i.expectedReturn))}` : 'return date TBD'}</div></div></li>`;
  }).join('')}</ul><p class="getwell">Get well soon, llamas! The herd is saving your spot. 🌼</p>` : '<p class="muted small">Everyone is healthy! 🦙💪</p>'}
  ${compact ? '' : '<p class="hint">Players share only what they\'re comfortable with. Injured players get no "are you playing?" messages until they\'re cleared.</p>'}</div>`;
}
function pinnieBlock(d) {
  const s = team.pinnieStatus(d);
  return `<div class="card"><h2>🟨 Spare pinnies</h2><p class="small">Our top ${cfg.pinnies.holders} point-earners each hold ${cfg.pinnies.sparesEach} spare pinnies.</p>
  <div>${s.holders.length ? s.holders.map((p) => `<span class="chip y">${esc(p.name)}</span>`).join('') : '<span class="muted small">not recorded yet</span>'}</div>
  ${!s.upToDate && s.shouldHold.length ? `<p class="hint">Next handoff → ${s.shouldHold.map((p) => esc(p.name)).join(', ')}</p>` : ''}</div>`;
}

// ---------- Demo landing (DEMO=1 serves it at / ; /demo always works)
function landing(req, res) {
  const d = db(); const p = demo ? demo.demoPlayer(d) : d.players[0];
  const big = (href, emoji, title, line) => `<a class="landbtn" href="${href}"><span>${emoji}</span><b>${title}</b><small>${line}</small></a>`;
  res.send(layout({ title: 'Demo', flash: req.query.msg, body: `
  <div class="card hero" style="text-align:center"><div style="font-size:54px">🦙⚽</div><h2 style="justify-content:center;font-size:22px">Welcome to the Soccer Llamas app!</h2>
    <p>A tiny team helper: who's coming Sunday, Llama Points, the injury list, and friendly automatic reminders. Tap around. It's all pretend, so you can't break anything.</p></div>
  <div class="landing">
    ${big('/dashboard', '📋', 'See the team dashboard', 'Next game, who\'s In, the top-5 points board and the injury list.')}
    ${big('/demo/player', '🙋‍♀️', 'Be a player', `Try tapping In / Out, "I'm here", and the injury list as ${esc(p ? p.name : 'a sample player')}.`)}
    ${big('/demo/captain', '🧢', 'See the captain side', 'Games, fees, points, the inbox that answers itself, Team health and the Outbox.')}
  </div>
  <p class="hint" style="text-align:center">Everyone here is made up. ${cfg.demo ? 'The demo resets itself every night.' : ''}</p>` }));
}
app.get('/demo', landing);
app.get('/demo/player', (req, res) => { const p = demo ? demo.demoPlayer(db()) : db().players[0]; res.redirect(303, `/p/${p.token}`); });
app.get('/demo/captain', (req, res) => { if (!cfg.demo) return res.redirect(303, '/admin'); res.redirect(303, `/admin?key=${encodeURIComponent(db().settings.adminToken)}`); });
if (cfg.demo) app.get('/', landing);

// ---------- Dashboard
app.get(cfg.demo ? '/dashboard' : ['/', '/dashboard'], (req, res) => {
  const d = db();
  const g = team.nextGame(d);
  const more = team.upcomingGames(d).slice(1);
  const lb = leaderboard(d);
  const body = `
  ${g ? `<div class="card hero"><h2>⚽ Next game</h2>${gameHeader(g)}${headcountBlock(d, g)}
    <p class="hint">Tap your personal link to say In / Out / Maybe. Lost it? Ask the captain.</p></div>` : '<div class="card hero"><h2>⚽ No games scheduled</h2><p>Season over — see you next time!</p></div>'}
  ${irBlock(d)}
  ${more.length ? `<div class="card"><h2>📅 Coming up</h2>${more.map((x) => { const h = team.headcount(d, x); return `<div class="game"><b>${esc(T.fmtGame(x.startsAt))}</b><div class="where">${esc(x.location)}</div><div class="small"><span class="pill in">${h.in.length} in</span> <span class="pill maybe">${h.maybe.length} maybe</span> <span class="pill out">${h.out.length} out</span> ${h.keepers.length ? '<span class="pill good">🧤</span>' : ''}</div></div>`; }).join('')}</div>` : ''}
  <div class="card"><h2>🏆 Llama Points — top ${cfg.leaderboardSize}</h2>
    ${lb.length ? `<ol class="lb">${lb.map((x, i) => `<li><span class="rank">${i + 1}</span><span class="nm">${esc(x.player.name)}</span><span class="pt">${x.total}</span></li>`).join('')}</ol>` : '<p class="muted">No points yet.</p>'}
    <p class="hint">Earn points by RSVPing early (+${cfg.points.rsvpByThursday.pts} by Thursday night), showing up, paying on time, helping on game day and bringing friends. Your own score is on your personal page.</p></div>
  ${pinnieBlock(d)}`;
  res.send(layout({ title: 'Dashboard', body, flash: req.query.msg, captain: d.settings.captainName }));
});

// ---------- Player page
function findPlayer(req, res, next) {
  const p = db().players.find((x) => x.token === req.params.token);
  if (!p) return res.status(404).send(layout({ title: 'Not found', body: '<div class="card"><h2>🦙 Hmm, that link doesn\'t work</h2><p>Ask your captain for your personal link.</p></div>' }));
  req.player = p; next();
}

app.get('/p/:token', findPlayer, (req, res) => {
  const d = db(); const p = req.player; const now = new Date();
  const pts = computePoints(d)[p.id];
  const upcoming = team.upcomingGames(d, now).filter((g) => new Date(g.startsAt) > now);
  const checkable = team.sortedGames(d).filter((g) => team.checkinOpen(g, now) && (team.checkinFor(d, g.id, p.id) || (team.rsvpFor(d, g.id, p.id) || {}).status !== 'out'));
  const missed = team.pastGames(d, now).filter((g) => { const r = team.rsvpFor(d, g.id, p.id); return r && r.status === 'in' && !team.checkinFor(d, g.id, p.id); }).slice(0, 3);
  const myInj = d.injuries.filter((i) => i.playerId === p.id);
  const myActive = myInj.find((i) => !i.cleared);
  const base = `/p/${p.token}`;

  const rsvpCards = upcoming.map((g) => {
    const r = team.rsvpFor(d, g.id, p.id); const w = T.rsvpWindows(g.startsAt);
    const early = now <= w.thursdayEnd;
    const btn = (s, label) => `<button name="status" value="${s}" class="${r && r.status === s ? 'sel-' + s : ''}">${label}</button>`;
    const h = team.headcount(d, g);
    return `<div class="game"><b>${esc(T.fmtGame(g.startsAt))}</b><div class="where">${esc(g.location)}</div>
      <form method="post" action="${base}/rsvp"><input type="hidden" name="gameId" value="${g.id}"><div class="btns">${btn('in', '👍 In')}${btn('maybe', '🤔 Maybe')}${btn('out', '👎 Out')}</div></form>
      <div class="hint">${r ? `You said <b>${statusWord[r.status]}</b> · ${esc(T.fmtStamp(r.updatedAt))}. ` : ''}${early ? `Reply by ${esc(T.fmtDay(w.thursdayEnd.getTime() - 1))} 11:59 pm for +${cfg.points.rsvpByThursday.pts} pts.` : now <= w.dayBeforeEnd && now >= w.dayBeforeStart ? `Reply today for +${cfg.points.rsvpSaturday.pts} pt.` : ''} So far: ${h.in.length} in.</div></div>`;
  }).join('');

  const checkinCards = checkable.map((g) => {
    const c = team.checkinFor(d, g.id, p.id);
    return `<div class="game"><b>${esc(T.fmtGame(g.startsAt))}</b> · ${esc(g.location)}<br>${c ? `<span class="pill good">✅ Checked in ${esc(T.fmtStamp(c.at))}</span>` : `<form method="post" action="${base}/checkin"><input type="hidden" name="gameId" value="${g.id}"><button class="primary" style="width:100%;margin-top:6px">✅ I'm here / I played</button></form>`}</div>`;
  }).join('');

  const missedCards = missed.map((g) => {
    const r = team.rsvpFor(d, g.id, p.id);
    return `<div class="game"><b>${esc(T.fmtGame(g.startsAt))}</b> — you said In but didn't check in.
      ${r.toldTeam ? '<span class="pill good">You told the team 👍</span>' : `<form method="post" action="${base}/told"><input type="hidden" name="gameId" value="${g.id}"><button class="small">I let the team know I couldn't make it</button></form>`}</div>`;
  }).join('');

  const body = `
  <div class="card hero"><h2>👋 Hi, ${esc(p.name)}!</h2>
    <div class="small muted">Your Llama Points</div><div class="score">${pts.total}</div>
    <details style="margin-top:10px"><summary>How I earned them</summary><table>${pts.items.map((i) => `<tr><td>${esc(i.label)}${i.note ? ` <span class="muted small">(${esc(i.note)})</span>` : ''}</td><td style="text-align:right;font-weight:800">${i.pts > 0 ? '+' : ''}${i.pts}</td></tr>`).join('') || '<tr><td class="muted">Nothing yet — RSVP early to start!</td></tr>'}</table></details>
    <p class="hint">Bookmark this page — it's your personal link (no password). Don't share it.</p></div>
  <div class="card"><h2>🗳️ Are you playing?</h2>${rsvpCards || '<p class="muted">No upcoming games.</p>'}</div>
  ${checkinCards ? `<div class="card"><h2>📍 Check in</h2><p class="small">At the field (or after), tap to mark yourself present. Honor system!</p>${checkinCards}</div>` : ''}
  ${missedCards ? `<div class="card"><h2>🙈 Missed a game?</h2>${missedCards}</div>` : ''}
  <div class="card"><h2>🧤 Keeper</h2><form method="post" action="${base}/keeper"><label><input type="checkbox" name="canKeep" value="1" ${p.canKeep ? 'checked' : ''} onchange="this.form.submit()">I'm willing to play keeper</label><noscript><button class="small">Save</button></noscript></form></div>
  <div class="card" id="ir"><h2>🩹 My injury reserve</h2>
    ${myActive ? `<div class="banner ok">You're on injury reserve — no "are you playing?" messages until you're cleared. Heal up! 🦙💛</div>
      <div class="game"><b>${esc(myActive.injury || 'Injury')}</b><div class="small muted">Hurt ${esc(T.fmtDate(myActive.dateInjured))}${myActive.expectedReturn ? ` · expected back ${esc(T.fmtDate(myActive.expectedReturn))}` : ''}</div>
      <form method="post" action="${base}/injury/${myActive.id}/update"><label>Change my expected return</label><div class="row"><input type="date" name="expectedReturn" value="${esc(myActive.expectedReturn || '')}"><button>Update</button></div></form>
      <form method="post" action="${base}/injury/${myActive.id}/clear"><button class="primary big">🎉 I'm cleared to play!</button></form></div>`
    : `<details><summary class="btn big" style="list-style:none">🩹 I'm injured — put me on IR</summary>
    <form method="post" action="${base}/injury">
      <label>Injury (vague is fine)</label><input name="injury" placeholder="e.g. sprained ankle, or just 'lower body'">
      <div class="row"><div><label>Date injured</label><input type="date" name="dateInjured" value="${T.todayLocalStr()}"></div><div><label>Expected return</label><input type="date" name="expectedReturn"></div></div>
      <p class="hint">Share only what you're comfortable with — the team sees this on the dashboard. You won't get "are you playing?" messages while you're on IR.</p>
      <button class="primary big">Put me on injury reserve</button></form></details>`}
    ${myInj.filter((i) => i.cleared).length ? `<p class="small muted">Past: ${myInj.filter((i) => i.cleared).map((i) => `${esc(i.injury || 'injury')} (cleared ${esc(T.fmtDay(i.clearedAt))})`).join(', ')}</p>` : ''}</div>
  ${irBlock(d, { compact: true })}
  <div class="card"><h2>🔕 Messages</h2>${team.isPausedAt(p, now) ? `<p class="small">Messages paused until ${esc(T.fmtDay(p.pausedUntil))}.</p>` : '<p class="small">You get game-week messages by email.</p>'}<a class="btn" href="${base}/pause">${team.isPausedAt(p, now) ? 'Resume or change' : 'Pause messages'}</a></div>
  <p class="small" style="text-align:center"><a href="/dashboard">← Team dashboard</a></p>`;
  res.send(layout({ title: p.name, body, flash: req.query.msg, captain: d.settings.captainName }));
});

app.post('/p/:token/rsvp', findPlayer, (req, res) => {
  const d = db(); const g = d.games.find((x) => x.id === req.body.gameId);
  const status = req.body.status;
  if (!g || !['in', 'out', 'maybe'].includes(status)) return back(res, `/p/${req.player.token}`, 'Something went wrong — try again.');
  if (new Date(g.startsAt) <= new Date()) return back(res, `/p/${req.player.token}`, 'That game already started — text the captain.');
  setRsvp(d, req.player.id, g.id, status); store.save();
  back(res, `/p/${req.player.token}`, { in: "You're In! 🦙⚽", out: 'Got it — you\'re Out. Thanks for telling us!', maybe: 'Marked Maybe. Update when you know!' }[status]);
});
app.post('/p/:token/checkin', findPlayer, (req, res) => {
  const d = db(); const g = d.games.find((x) => x.id === req.body.gameId);
  if (!g || !team.checkinOpen(g)) return back(res, `/p/${req.player.token}`, 'Check-in is not open for that game.');
  checkIn(d, req.player.id, g.id); store.save();
  back(res, `/p/${req.player.token}`, 'Checked in ✅ Thanks for showing up!');
});
app.post('/p/:token/told', findPlayer, (req, res) => {
  const d = db(); const r = team.rsvpFor(d, req.body.gameId, req.player.id);
  if (r) { r.toldTeam = true; r.toldTeamAt = new Date().toISOString(); store.save(); }
  back(res, `/p/${req.player.token}`, 'Thanks for letting the team know.');
});
app.post('/p/:token/keeper', findPlayer, (req, res) => { req.player.canKeep = !!req.body.canKeep; store.save(); back(res, `/p/${req.player.token}`, req.player.canKeep ? 'Thanks, keeper! 🧤' : 'Saved.'); });
app.post('/p/:token/injury', findPlayer, (req, res) => {
  const b = req.body;
  db().injuries.push({ id: store.id('i'), playerId: req.player.id, injury: (b.injury || '').trim().slice(0, 120), dateInjured: b.dateInjured || T.todayLocalStr(), expectedReturn: b.expectedReturn || '', cleared: false, clearedAt: null, addedBy: 'player', addedAt: new Date().toISOString() });
  store.save(); back(res, `/p/${req.player.token}`, 'Added to injury reserve. Heal up! 💛');
});
app.post('/p/:token/injury/:id/update', findPlayer, (req, res) => {
  const i = db().injuries.find((x) => x.id === req.params.id && x.playerId === req.player.id);
  if (i) { i.expectedReturn = req.body.expectedReturn || ''; i.returnCheckAt = null; store.save(); }
  back(res, `/p/${req.player.token}#ir`, 'Return date updated.');
});
// From the "Ready to come back?" email: confirm with a button (no change on a plain link visit)
app.get('/p/:token/ir/:id/cleared', findPlayer, (req, res) => {
  const i = db().injuries.find((x) => x.id === req.params.id && x.playerId === req.player.id);
  if (!i || i.cleared) return back(res, `/p/${req.player.token}`, i ? "You're already cleared. Welcome back!" : '');
  res.send(layout({ title: 'Welcome back?', body: `<div class="card hero"><h2>🦙💛 Ready to come back?</h2><p>Tap to take yourself off injury reserve. Game-week messages will start again.</p>
    <form method="post" action="/p/${req.player.token}/injury/${i.id}/clear"><button class="primary big">🎉 Yes, I'm cleared to play</button></form>
    <p class="small"><a href="/p/${req.player.token}#ir">Not yet — update my return date</a></p></div>` }));
});
app.post('/p/:token/injury/:id/clear', findPlayer, (req, res) => {
  const i = db().injuries.find((x) => x.id === req.params.id && x.playerId === req.player.id);
  if (i) { i.cleared = true; i.clearedAt = new Date().toISOString(); store.save(); }
  back(res, `/p/${req.player.token}`, 'Welcome back! 🎉');
});

// One-tap answer links from messages (personal link = no login). Records right away.
app.get('/p/:token/go/:gameId/:status', findPlayer, (req, res) => {
  const d = db(); const g = d.games.find((x) => x.id === req.params.gameId); const s = req.params.status;
  if (!g || !['in', 'out', 'maybe'].includes(s)) return back(res, `/p/${req.player.token}`, 'That link is old — answer below.');
  if (new Date(g.startsAt) <= new Date()) return back(res, `/p/${req.player.token}`, 'That game already started — text the captain.');
  const r = setRsvp(d, req.player.id, g.id, s, new Date().toISOString(), 'email');
  if (req.query.m) r.history[r.history.length - 1].msgId = String(req.query.m).slice(0, 40);
  store.save();
  back(res, `/p/${req.player.token}`, `Got it: ${statusWord[s]} for ${T.fmtDay(g.startsAt)}. ${s === 'in' ? '🦙⚽' : 'Thanks for letting us know!'}`);
});
app.get('/p/:token/pause', findPlayer, (req, res) => {
  const p = req.player; const paused = team.isPausedAt(p, new Date());
  const opt = (v, l) => `<form method="post" action="/p/${p.token}/pause"><input type="hidden" name="for" value="${v}"><button class="big ${v === 'resume' ? 'primary' : ''}">${l}</button></form>`;
  res.send(layout({ title: 'Messages', flash: req.query.msg, body: `<div class="card"><h2>🔕 Game-week messages</h2><p class="small">${paused ? `Paused until <b>${esc(T.fmtDay(p.pausedUntil))}</b>.` : 'You currently get invites, reminders and recaps.'}</p>
    ${paused ? opt('resume', '🔔 Turn messages back on') : ''}${opt('7', 'Pause for 1 week')}${opt('14', 'Pause for 2 weeks')}${opt('season', 'Pause for the rest of the season')}
    <p class="hint">You can still answer anytime on <a href="/p/${p.token}">your page</a>.</p></div>` }));
});
app.post('/p/:token/pause', findPlayer, (req, res) => {
  const p = req.player; const f = req.body.for;
  if (f === 'resume') { p.pausedUntil = null; p.pausedAt = null; }
  else { p.pausedAt = new Date().toISOString(); p.pausedUntil = f === 'season' ? '2027-01-01T07:00:00.000Z' : new Date(Date.now() + Number(f) * 86400000).toISOString(); }
  store.save(); back(res, `/p/${p.token}/pause`, f === 'resume' ? 'Messages are back on.' : 'Messages paused.');
});

app.use('/admin', require('./routes/admin'));
app.use('/api', require('./routes/api'));
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => { console.error(err); res.status(500).send(layout({ title: 'Oops', body: `<div class="card"><h2>🦙 Oops, something broke</h2><p>${esc(err.message)}</p></div>` })); });

if (require.main === module) app.listen(cfg.port, '0.0.0.0', () => { console.log(`Soccer Llamas running at http://localhost:${cfg.port}${cfg.demo ? ' (DEMO mode)' : ''}`); if (process.env.NO_SCHEDULER !== '1') require('./lib/scheduler').start(); if (demo) demo.startNightly(); });
module.exports = app;
