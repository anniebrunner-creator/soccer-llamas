// Captain pages. Plain words, big buttons, a short help line on every screen.
const express = require('express');
const fs = require('fs');
const cfg = require('../config');
const store = require('../lib/store');
const T = require('../lib/time');
const team = require('../lib/team');
const { computePoints, leaderboard } = require('../lib/points');
const { checkIn } = require('../lib/actions');
const { planSync } = require('../lib/calendar');
const auto = require('../lib/automation');
const health = require('../lib/health');
const { esc, mapLink, statusWord, layout, adminNav, help } = require('../lib/views');

const r = express.Router();
const db = () => store.get();
const back = (res, url, msg) => { const [u, h] = url.split('#'); res.redirect(303, u + (msg ? (u.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(msg) : '') + (h ? '#' + h : '')); };
const page = (req, res, active, title, body) => res.send(layout({ title, body, nav: adminNav(active), flash: req.query.msg, captain: db().settings.captainName }));
const pname = (id) => (db().players.find((p) => p.id === id) || {}).name || '?';
const noon = (date) => T.fromLocalInputs(date, '12:00').toISOString();
const playerOptions = (sel, list = team.activePlayers(db())) => list.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
const gameOptions = (sel) => team.sortedGames(db()).map((g) => `<option value="${g.id}" ${g.id === sel ? 'selected' : ''}>${esc(T.fmtGame(g.startsAt))}</option>`).join('');

// ---------- sign-in via captain link (/admin?key=...) -> cookie
const cookie = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((x) => x[0]));
const setKey = (res, key) => res.set('Set-Cookie', `llamas_captain=${encodeURIComponent(key)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`);
r.post('/login', (req, res) => {
  if (req.body.key && req.body.key.trim() === db().settings.adminToken) { setKey(res, req.body.key.trim()); return back(res, '/admin', 'Welcome, captain! 🦙'); }
  back(res, '/admin', "That key didn't work.");
});
r.get('/logout', (req, res) => { res.set('Set-Cookie', 'llamas_captain=; Path=/; Max-Age=0'); back(res, '/', 'Signed out.'); });
r.use((req, res, next) => {
  const key = db().settings.adminToken;
  if (req.query.key && req.query.key === key) { setKey(res, key); const u = req.originalUrl.replace(/([?&])key=[^&]*&?/, '$1').replace(/[?&]$/, ''); return res.redirect(303, u || '/admin'); }
  if (cookie(req).llamas_captain === key || req.get('x-admin-token') === key) return next();
  res.status(401).send(layout({ title: 'Captain sign-in', flash: req.query.msg, body: `<div class="card"><h2>🧢 Captain sign-in</h2>${help('Open the captain link you were given (it signs you in). Or paste the captain key here.')}<form method="post" action="/admin/login"><label>Captain key</label><input name="key" autocomplete="off"><button class="primary big">Sign in</button></form></div>` }));
});

// ---------- Home: "season at a glance" so a new captain can see the job being done
function glance(d) {
  const lb = leaderboard(d, 5);
  const ir = team.activeInjuries(d);
  const fees = d.fees; const paid = fees.filter((f) => f.paidAt);
  const owed = fees.filter((f) => !f.paidAt);
  const sent = (d.messages || []).filter((m) => m.status === 'sent').sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
  const queued = (d.messages || []).filter((m) => m.status === 'queued').length;
  const week = sent.filter((m) => new Date(m.sentAt) > new Date(Date.now() - 7 * 864e5)).length;
  const lbl = (k) => (cfg.automation.steps.find((s) => s.key === k) || { label: k === 'irCheck' ? 'Ready to come back?' : k === 'reply' ? 'Auto-reply' : k }).label;
  const handled = (d.inbound || []).filter((e) => e.status !== 'ignored').length;
  return `<div class="card"><h2>🔭 Season at a glance</h2>${help('Everything below happened without you typing a single group text.')}
    <div class="stat"><div><b>${sent.length}</b><span>messages sent for you (${week} this week)</span></div><div><b>${handled}</b><span>player emails answered automatically</span></div>
    <div><b>$${paid.reduce((a, f) => a + f.amount, 0)}</b><span>fees collected · $${owed.reduce((a, f) => a + f.amount, 0)} still out</span></div><div><b>${queued}</b><span>reminders queued</span></div></div>
    <h3>⭐ Llama Points top 5</h3><ol class="lb">${lb.map((x, i) => `<li><span class="rank">${i + 1}</span><span class="nm">${esc(x.player.name)}</span><span class="pt">${x.total}</span></li>`).join('')}</ol>
    <h3>🩹 Injury list</h3>${ir.length ? `<ul class="clean small">${ir.map((i) => `<li><b>${esc(pname(i.playerId))}</b> — ${esc(i.injury || 'injury')}${i.expectedReturn ? ` · back ~${esc(T.fmtDate(i.expectedReturn))}` : ''}</li>`).join('')}</ul>` : '<p class="muted small">Nobody hurt.</p>'}
    <h3>📨 Latest automatic messages</h3><ul class="clean small">${sent.slice(0, 4).map((m) => `<li>✉️ ${esc(T.fmtStamp(m.sentAt))} · ${esc(lbl(m.step))} → ${esc(pname(m.playerId))}</li>`).join('') || '<li class="muted">None yet</li>'}</ul>
    <a class="btn" href="/admin/outbox">See all messages</a></div>`;
}

// ---------- Home
r.get('/', (req, res) => {
  const d = db(); const on = d.settings.automationsOn !== false; const g = team.nextGame(d);
  const h = g && team.headcount(d, g);
  const todo = [];
  for (const pg of team.pastGames(d).slice(0, 3)) {
    if (pg.cancelled) continue;
    const ns = d.rsvps.filter((x) => x.gameId === pg.id && x.status === 'in' && !team.checkinFor(d, pg.id, x.playerId) && !x.noShow && !x.toldTeam);
    if (ns.length) todo.push(`<a href="/admin/games/${pg.id}">${ns.length} player(s) said In but didn't check in for ${esc(T.fmtDay(pg.startsAt))}</a>: were they there?`);
    if (!pg.result) todo.push(`<a href="/admin/games/${pg.id}">Enter the score for ${esc(T.fmtDay(pg.startsAt))}</a>`);
  }
  const refs = (d.pendingReferrals || []).filter((x) => x.status === 'pending').length; if (refs) todo.push(`<a href="/admin/inbox">${refs} friend referral(s) to confirm</a> once they play`);
  const unpaid = d.fees.filter((f) => !f.paidAt).length; if (unpaid) todo.push(`<a href="/admin/money">${unpaid} fee(s) not paid yet</a>`);
  const sched = g ? auto.schedule(d, g).filter((x) => !x.run || x.queued).slice(0, 3) : [];
  const body = `
  <div class="card kill ${on ? 'on' : 'off'}"><div><b style="font-size:18px">${on ? '✅ Automatic messages are ON' : '⛔ Automatic messages are OFF'}</b><div class="small">${on ? 'Invites, reminders and recaps go out on their own.' : 'Nothing will be sent until you turn this back on.'}</div></div>
    <form method="post" action="/admin/automations"><input type="hidden" name="on" value="${on ? '0' : '1'}"><button class="${on ? '' : 'primary'}">${on ? 'Turn OFF' : 'Turn ON'}</button></form></div>
  ${g ? `<div class="card hero"><h2>⚽ Next game: ${esc(T.fmtGame(g.startsAt))}</h2><div class="where">${esc(g.location)}</div>
    <div class="banner ${h.level}">${esc(h.in.length)} in · ${h.maybe.length} maybe · ${h.out.length} out. ${esc(h.message)}</div>
    <div class="small">${h.keepers.length ? '🧤 Keeper: ' + h.keepers.map((p) => esc(p.name)).join(', ') : '🧤 <b>No keeper yet</b>'}</div>
    ${sched.length ? `<h3>Coming up automatically</h3><ul class="clean small">${sched.map((x) => `<li>📨 ${esc(T.fmtGame(x.due))}: ${esc(x.step.label)}${x.queued ? ` (${x.queued} waiting)` : ''}</li>`).join('')}</ul>` : ''}
    <a class="btn" href="/admin/games/${g.id}" style="margin-top:8px">Open this game</a></div>` : ''}
  <div class="card"><h2>📝 To do</h2>${todo.length ? `<ul class="todo">${todo.map((t) => `<li>${t}</li>`).join('')}</ul>` : '<p class="muted">All caught up! 🎉</p>'}</div>
  ${glance(d)}
  <h3 class="grp">This week</h3><div class="bigbtns">
    <a href="/admin/games"><span>📅</span>Games<small>who's in, scores, who came</small></a>
    <a href="/admin/inbox"><span>📥</span>Inbox<small>replies answered for you</small></a>
    <a href="/admin/outbox"><span>📨</span>Outbox<small>reminders sent &amp; queued</small></a>
    <a href="/admin/injuries"><span>🩹</span>Injury list<small>${team.activeInjuries(d).length} on reserve</small></a>
  </div>
  <h3 class="grp">Team &amp; season</h3><div class="bigbtns">
    <a href="/admin/players"><span>👯</span>Players<small>personal links, add a player</small></a>
    <a href="/admin/money"><span>💵</span>Fees &amp; cards<small>who paid (no Venmo needed)</small></a>
    <a href="/admin/points"><span>⭐</span>Llama Points<small>leaderboard, give points</small></a>
    <a href="/admin/pinnies"><span>🟨</span>Pinnies<small>Amber/Kat keep them</small></a>
    <a href="/admin/health"><span>📈</span>Team health<small>attendance chart, what works</small></a>
    <a href="/admin/calendar"><span>🗓️</span>Calendar preview<small>planned invites</small></a>
    <a href="/admin/settings"><span>⚙️</span>Settings<small>hand-over, check-in rules</small></a>
    <a href="/dashboard"><span>📋</span>Team page<small>what players see</small></a>
  </div>`;
  const demoCard = cfg.demo ? `<div class="card" style="border:2px dashed var(--ink)"><h2>🧪 Demo controls</h2>${help('Visitors can change anything here. This puts all the sample data back the way it started (it also resets itself every night).')}<form method="post" action="/admin/demo-reset" onsubmit="return confirm('Reset all demo data?')"><button class="primary big">↺ Reset demo data</button></form></div>` : '';
  page(req, res, '/admin', 'Captain', `<div class="card"><h2>🧢 Hi, ${esc(d.settings.captainName)}!</h2>${help('This is the captain\'s corner. The app runs the weekly messages for you. Check the To-do list after each game.')}</div>` + demoCard + body);
});
for (const [a, to] of [['todo', '/admin'], ['ir', '/admin/injuries'], ['injury', '/admin/injuries'], ['fees', '/admin/money'], ['leaderboard', '/admin/points'], ['messages', '/admin/outbox'], ['roster', '/admin/players']]) r.get('/' + a, (req, res) => res.redirect(302, to));
r.post('/demo-reset', (req, res) => { if (!cfg.demo) return back(res, '/admin', 'Only available in demo mode.'); require('../lib/demo').resetFromSnapshot(); back(res, '/admin', 'Demo data reset to the starting sample. 🦙'); });
r.post('/automations', (req, res) => { db().settings.automationsOn = req.body.on === '1'; store.save(); back(res, '/admin', req.body.on === '1' ? 'Automatic messages turned ON.' : 'Automatic messages turned OFF. Nothing will be sent.'); });

// ---------- Games
const gameForm = (g = {}) => {
  const li = g.startsAt ? T.toLocalInputs(g.startsAt) : { date: '', time: '11:00' };
  return `<div class="row"><div><label>Date</label><input type="date" name="date" value="${li.date}" required></div><div><label>Kickoff (Mountain Time)</label><input type="time" name="time" value="${li.time}" required></div></div>
  <label>Field name</label><input name="location" value="${esc(g.location || 'Stenger Soccer Complex')}" required>
  <label>Address</label><input name="address" value="${esc(g.address || '11200 W 58th Ave, Arvada, CO')}">
  <div class="row"><div><label>Opponent (optional)</label><input name="opponent" value="${esc(g.opponent || '')}"></div><div><label>Who brings the game card</label><select name="gameCardBy"><option value="">Captain</option>${playerOptions(g.gameCardBy)}</select></div></div>
  <label>Note for players (optional)</label><input name="notes" value="${esc(g.notes || '')}">
  ${g.id ? `<label><input type="checkbox" name="cancelled" value="1" ${g.cancelled ? 'checked' : ''}>Game cancelled</label>` : ''}`;
};
const readGame = (b, g) => Object.assign(g, { startsAt: T.fromLocalInputs(b.date, b.time).toISOString(), location: b.location.trim(), address: (b.address || '').trim(), opponent: (b.opponent || '').trim(), notes: (b.notes || '').trim(), gameCardBy: b.gameCardBy || null, cancelled: !!b.cancelled });
r.get('/games', (req, res) => {
  const d = db(); const now = new Date();
  const row = (g) => { const h = team.headcount(d, g); const past = team.gameEnd(g) < now; return `<div class="game"><a href="/admin/games/${g.id}"><b>${esc(T.fmtGame(g.startsAt))}</b></a> ${g.cancelled ? '<span class="pill bad">cancelled</span>' : ''}<div class="where">${esc(g.location)}</div><div class="small">${past ? `${d.checkins.filter((c) => c.gameId === g.id).length} came · ${g.result ? `<b>${g.result.outcome} ${g.result.us}-${g.result.them}</b>` : '<span class="pill maybe">score needed</span>'}` : `<span class="pill in">${h.in.length} in</span> <span class="pill maybe">${h.maybe.length} maybe</span> <span class="pill out">${h.out.length} out</span>`}</div></div>`; };
  page(req, res, '/admin/games', 'Games', `<div class="card"><h2>📅 Games</h2>${help('Tap a game to change it, enter the score, or fix who came.')}
    <h3>Coming up</h3>${team.sortedGames(d).filter((g) => team.gameEnd(g) >= now).map(row).join('') || '<p class="muted">None</p>'}
    <h3>Played</h3>${team.pastGames(d).map(row).join('')}</div>
    <div class="card"><h2>➕ Add a game</h2><form method="post" action="/admin/games">${gameForm()}<button class="primary big">Add game</button></form></div>`);
});
r.post('/games', (req, res) => { const g = readGame(req.body, { id: store.id('g'), durationMin: cfg.defaultGameMinutes, calendarEventId: null, result: null }); db().games.push(g); store.save(); back(res, '/admin/games', 'Game added.'); });
r.get('/games/:id', (req, res) => {
  const d = db(); const g = d.games.find((x) => x.id === req.params.id); if (!g) return back(res, '/admin/games', 'Game not found.');
  const started = new Date(g.startsAt) <= new Date();
  const rows = team.activePlayers(d).map((p) => {
    const rv = team.rsvpFor(d, g.id, p.id); const c = team.checkinFor(d, g.id, p.id);
    if (!rv && !c && p.role === 'sub') return '';
    let state = c ? '<span class="pill good">✅ came</span>' : rv && rv.noShow ? '<span class="pill bad">no-show</span>' : rv && rv.toldTeam ? '<span class="pill maybe">told the team</span>' : '';
    const act = (a, label) => `<form class="inline" method="post" action="/admin/games/${g.id}/attendance"><input type="hidden" name="playerId" value="${p.id}"><input type="hidden" name="action" value="${a}"><button class="small">${label}</button></form>`;
    const note = rv && rv.status === 'out' ? (rv.declineReason ? `<div class="decline-note">${esc(rv.declineReason)}</div>` : '<div class="small muted">No note</div>') : '';
    return `<tr><td><b>${esc(p.name)}</b>${p.role === 'sub' ? ' <span class="tag">sub</span>' : ''}<br><span class="pill ${rv ? rv.status : 'none'}">${rv ? statusWord[rv.status] : 'no reply'}</span> ${state}${note}</td><td style="text-align:right">${started ? (c ? act('clear', 'Undo') : `${act('checkin', '✅ Came')} ${rv && rv.status === 'in' ? `${act('noshow', '❌ No-show')} ${act('told', 'Told us')}` : ''}`) : ''}</td></tr>`;
  }).join('');
  const res_ = g.result || {};
  page(req, res, '/admin/games', 'Game', `
  <div class="card hero"><h2>⚽ ${esc(T.fmtGame(g.startsAt))}</h2><div class="where">${esc(g.location)}</div></div>
  ${started ? `<div class="card"><h2>🏁 Score</h2>${help('Enter it after the game. It shows in the Monday recap and on Team health.')}
    <form method="post" action="/admin/games/${g.id}/result"><div class="row"><div><label>Us</label><input type="number" min="0" name="us" value="${res_.us ?? ''}"></div><div><label>Them</label><input type="number" min="0" name="them" value="${res_.them ?? ''}"></div></div><button class="primary big">Save score</button></form></div>` : ''}
  <div class="card"><h2>🙋 Who's coming / who came</h2>${help(started ? 'Players check themselves in. Fix it here if someone forgot. "No-show" costs −3 points; "Told us" means no penalty.' : 'Players answer with their own links. After kickoff you can fix who came here.')}
    <p class="privacy">${esc(cfg.demo
      ? 'If someone said Out, an optional note may show here. This demo has no private captain login — these pages use the public demo key, and every player is made up. A blank note is normal. Notes do not change points, reminders, or injury reserve.'
      : 'If someone said Out, an optional note shows on this attendance page only. Other players and the public team page do not include it. Anyone with the captain link can read it. A blank note is normal and does not change points, reminders, or injury reserve.')}</p>
    <table>${rows}</table></div>
  <div class="card"><h2>✏️ Change game details</h2><form method="post" action="/admin/games/${g.id}">${gameForm(g)}<button class="primary big">Save changes</button></form></div>`);
});
r.post('/games/:id', (req, res) => { const g = db().games.find((x) => x.id === req.params.id); if (g) { readGame(req.body, g); store.save(); } back(res, `/admin/games/${req.params.id}`, 'Saved.'); });
r.post('/games/:id/result', (req, res) => {
  const g = db().games.find((x) => x.id === req.params.id); const us = Number(req.body.us), them = Number(req.body.them);
  if (g && req.body.us !== '' && req.body.them !== '') { g.result = { outcome: us > them ? 'W' : us < them ? 'L' : 'T', us, them }; store.save(); }
  back(res, `/admin/games/${req.params.id}`, 'Score saved.');
});
r.post('/games/:id/attendance', (req, res) => {
  const d = db(); const { playerId, action } = req.body; const gid = req.params.id;
  const rv = team.rsvpFor(d, gid, playerId);
  if (action === 'checkin') checkIn(d, playerId, gid, new Date().toISOString(), 'captain');
  if (action === 'clear') { d.checkins = d.checkins.filter((c) => !(c.gameId === gid && c.playerId === playerId)); if (rv) { rv.noShow = false; rv.toldTeam = false; } }
  if (action === 'noshow' && rv) { rv.noShow = true; rv.toldTeam = false; }
  if (action === 'told' && rv) { rv.toldTeam = true; rv.noShow = false; }
  store.save(); back(res, `/admin/games/${gid}`, 'Updated.');
});

// ---------- Players
r.get('/players', (req, res) => {
  const d = db();
  const rows = d.players.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<details class="game"><summary>${esc(p.name)} ${p.role === 'sub' ? '<span class="tag">sub</span>' : ''} ${p.canKeep ? '🧤' : ''} ${p.active === false ? '<span class="tag">inactive</span>' : ''} ${team.isPausedAt(p, new Date()) ? '<span class="tag">messages paused</span>' : ''}</summary>
    <p class="small">Personal link (send this to her):<br><input readonly value="${esc(cfg.baseUrl)}/p/${p.token}" onclick="this.select()"></p>
    <form method="post" action="/admin/players/${p.id}">
      <label>Name</label><input name="name" value="${esc(p.name)}">
      <div class="row"><div><label>Email</label><input name="email" value="${esc(p.email)}"></div><div><label>Mobile (for texts later)</label><input name="phone" value="${esc(p.phone || '')}"></div></div>
      <label>On the team as</label><select name="role"><option value="roster" ${p.role !== 'sub' ? 'selected' : ''}>Regular player</option><option value="sub" ${p.role === 'sub' ? 'selected' : ''}>Sub (only asked when we're short)</option></select>
      <label><input type="checkbox" name="canKeep" value="1" ${p.canKeep ? 'checked' : ''}>Can play keeper</label>
      <label><input type="checkbox" name="active" value="1" ${p.active !== false ? 'checked' : ''}>Still on the team</label>
      <button class="primary">Save</button></form>
    <form method="post" action="/admin/players/${p.id}/newlink" onsubmit="return confirm('Make a new link? Her old link will stop working.')"><button class="small" style="margin-top:6px">Make her a new link</button></form></details>`).join('');
  page(req, res, '/admin/players', 'Players', `<div class="card"><h2>👯 Players</h2>${help('Each player has her own link — no passwords. Tap a name to copy her link or change details.')}${rows}</div>
  <div class="card"><h2>➕ Add a player</h2><form method="post" action="/admin/players"><label>Name</label><input name="name" required><label>Email</label><input name="email" type="email"><label>On the team as</label><select name="role"><option value="roster">Regular player</option><option value="sub">Sub</option></select>
  <label>Who brought her? (gets +${cfg.points.referral.pts} points)</label><select name="referredBy"><option value="">Nobody / not sure</option>${playerOptions()}</select><button class="primary big">Add player</button></form></div>`);
});
r.post('/players', (req, res) => {
  const d = db(); const b = req.body; const p = { id: store.id('p'), name: b.name.trim(), email: (b.email || '').trim(), phone: '', channel: 'email', token: store.token(), role: b.role === 'sub' ? 'sub' : 'roster', canKeep: false, active: true, pausedUntil: null, joinedAt: T.todayLocalStr(), card: { status: 'missing', date: null } };
  d.players.push(p);
  if (b.referredBy) d.awards.push({ id: store.id('a'), playerId: b.referredBy, type: 'referral', date: new Date().toISOString(), note: `Brought in ${p.name}`, gameId: null });
  store.save(); back(res, '/admin/players', `Added ${p.name}. Copy her link from the list and send it to her.`);
});
r.post('/players/:id', (req, res) => {
  const p = db().players.find((x) => x.id === req.params.id); const b = req.body;
  if (p) Object.assign(p, { name: b.name.trim() || p.name, email: (b.email || '').trim(), phone: (b.phone || '').trim(), role: b.role === 'sub' ? 'sub' : 'roster', canKeep: !!b.canKeep, active: !!b.active });
  store.save(); back(res, '/admin/players', 'Saved.');
});
r.post('/players/:id/newlink', (req, res) => { if (cfg.demo) return back(res, '/admin/players', 'Making new links is turned off in the demo.'); const p = db().players.find((x) => x.id === req.params.id); if (p) { p.token = store.token(); store.save(); } back(res, '/admin/players', 'New link made. Send her the new one.'); });

// ---------- Fees & player cards
const feeSummary = (d) => { const paid = d.fees.filter((f) => f.paidAt); const tot = d.fees.reduce((a, f) => a + f.amount, 0); const got = paid.reduce((a, f) => a + f.amount, 0); return tot ? `<div class="stat"><div><b>$${got}</b><span>collected of $${tot}</span></div><div><b>${paid.length}/${d.fees.length}</b><span>players paid</span></div></div><div class="bar"><i style="width:${Math.round(100 * got / tot)}%"></i></div>` : ''; };
r.get('/money', (req, res) => {
  const d = db();
  const rows = team.activePlayers(d).map((p) => {
    const fs_ = d.fees.filter((f) => f.playerId === p.id);
    const fee = fs_.map((f) => `<div class="small"><b>${esc(f.label)}</b> $${f.amount} — ${f.paidAt ? `<span class="pill good">paid ${esc(T.fmtDay(f.paidAt))}</span>` : '<span class="pill bad">not paid</span>'} ${f.reminderSentAt ? `<span class="tag">reminded ${esc(T.fmtDay(f.reminderSentAt))}</span>` : ''}
      ${f.paidAt ? '' : `<form class="inline" method="post" action="/admin/money/${f.id}/paid"><input type="hidden" name="date" value="${T.todayLocalStr()}"><button class="small">💵 Paid today</button></form>${f.reminderSentAt ? '' : ` <form class="inline" method="post" action="/admin/money/${f.id}/reminded"><button class="small">I reminded her</button></form>`}`}</div>`).join('') || '<span class="small muted">no fees asked</span>';
    const c = p.card || {};
    return `<tr><td><b>${esc(p.name)}</b>${fee}</td><td><form method="post" action="/admin/card/${p.id}"><select name="status" onchange="this.form.submit()"><option value="missing" ${c.status === 'missing' ? 'selected' : ''}>❌ No card yet</option><option value="before_asked" ${c.status === 'before_asked' ? 'selected' : ''}>⭐ Got it before I asked</option><option value="after_asked" ${c.status === 'after_asked' ? 'selected' : ''}>✅ Got it after I asked</option></select><noscript><button class="small">Save</button></noscript></form></td></tr>`;
  }).join('');
  page(req, res, '/admin/money', 'Fees & cards', `<div class="card"><h2>💵 Fees & 🪪 player cards</h2>${feeSummary(d)}${help(`No Venmo hookup needed: players pay however they like (cash at the field, check, any app). You just tap "Paid today" when money comes in. Paying within ${cfg.feeOnTimeDays} days = +${cfg.points.feesOnTime.pts} points, after a reminder = +${cfg.points.feesAfterReminder.pts}. A player card before you ask = +${cfg.points.playerCardEarly.pts}.`)}
    <table><tr><th>Fees</th><th>Player card</th></tr>${rows}</table></div>
  <div class="card"><h2>📣 Ask everyone for fees</h2>${help('Adds a fee for every player. (Write your own message to the team; the date starts the 1-week clock.)')}
    <form method="post" action="/admin/money/request"><label>What for</label><input name="label" placeholder="Spring 2027 fees" required><div class="row"><div><label>Amount $</label><input type="number" name="amount" value="60"></div><div><label>Date asked</label><input type="date" name="date" value="${T.todayLocalStr()}"></div></div><button class="primary big">Add fee for everyone</button></form></div>`);
});
r.post('/money/request', (req, res) => {
  const d = db(); const b = req.body;
  for (const p of team.activePlayers(d)) if (!d.fees.some((f) => f.playerId === p.id && f.label === b.label)) d.fees.push({ id: store.id('f'), playerId: p.id, label: b.label.trim(), amount: Number(b.amount) || 0, requestedAt: noon(b.date), paidAt: null, reminderSentAt: null });
  store.save(); back(res, '/admin/money', 'Fee added for everyone.');
});
r.post('/money/:id/paid', (req, res) => { const f = db().fees.find((x) => x.id === req.params.id); if (f) { f.paidAt = new Date().toISOString(); store.save(); } back(res, '/admin/money', 'Marked paid. 💵'); });
r.post('/money/:id/reminded', (req, res) => { const f = db().fees.find((x) => x.id === req.params.id); if (f) { f.reminderSentAt = new Date().toISOString(); store.save(); } back(res, '/admin/money', 'Noted the reminder.'); });
r.post('/card/:id', (req, res) => { const p = db().players.find((x) => x.id === req.params.id); if (p) { p.card = { status: req.body.status, date: T.todayLocalStr() }; store.save(); } back(res, '/admin/money', 'Player card saved.'); });

// ---------- Give points
const AWARD = { sub_keeper: `🧤 Subbed or played keeper when we were short (+${cfg.points.subOrKeeper.pts})`, gameday_help: `🧺 Helped on game day — pinnies, nets, game card (+${cfg.points.gameDayHelp.pts})`, referral: `🤝 Brought in a new player (+${cfg.points.referral.pts})` };
r.get('/points', (req, res) => {
  const d = db(); const pts = computePoints(d);
  const list = d.awards.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).map((a) => `<tr><td><b>${esc(pname(a.playerId))}</b><br><span class="small">${esc(AWARD[a.type])}${a.note ? ' · ' + esc(a.note) : ''}</span></td><td class="small">${esc(T.fmtDay(a.date))}<form method="post" action="/admin/points/${a.id}/delete" onsubmit="return confirm('Remove these points?')"><button class="small">Remove</button></form></td></tr>`).join('');
  page(req, res, '/admin/points', 'Llama Points', `<div class="card"><h2>🏆 Leaderboard (what the team sees)</h2>${help('Only the top ' + cfg.leaderboardSize + ' are shown on the team page. Nobody is ranked at the bottom.')}<ol class="lb">${leaderboard(d).map((x, i) => `<li><span class="rank">${i + 1}</span><span class="nm">${esc(x.player.name)}</span><span class="pt">${x.total}</span></li>`).join('')}</ol>
    <details><summary class="small">How points are earned</summary><ul class="clean small">${Object.values(cfg.points).map((x) => `<li>${x.pts > 0 ? '+' : ''}${x.pts} · ${esc(x.label)}</li>`).join('')}</ul></details></div>
  <div class="card"><h2>⭐ Give points</h2>${help('Most points add up on their own (answering early, showing up, fees). Use this for the things only you see.')}
    <form method="post" action="/admin/points"><label>Who</label><select name="playerId">${playerOptions()}</select><label>For what</label><select name="type">${Object.entries(AWARD).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
    <label>Which game (optional)</label><select name="gameId"><option value="">—</option>${gameOptions(team.pastGames(d)[0] && team.pastGames(d)[0].id)}</select><label>Note (optional)</label><input name="note" placeholder="e.g. brought the nets"><button class="primary big">Give points</button></form></div>
  <div class="card"><h2>🗂️ Points given</h2><table>${list}</table></div>
  <div class="card"><h2>🔢 Everyone's total (A–Z)</h2>${help('Only the top 5 are shown to the team. Nobody is ranked at the bottom.')}<table>${team.activePlayers(d).map((p) => `<tr><td>${esc(p.name)}</td><td style="text-align:right"><b>${pts[p.id].total}</b></td></tr>`).join('')}</table></div>`);
});
r.post('/points', (req, res) => {
  const b = req.body; if (!AWARD[b.type]) return back(res, '/admin/points', 'Pick what the points are for.');
  const g = db().games.find((x) => x.id === b.gameId);
  db().awards.push({ id: store.id('a'), playerId: b.playerId, type: b.type, gameId: g ? g.id : null, date: g ? g.startsAt : new Date().toISOString(), note: (b.note || '').trim() });
  store.save(); back(res, '/admin/points', `Points given to ${pname(b.playerId)} ⭐`);
});
r.post('/points/:id/delete', (req, res) => { db().awards = db().awards.filter((a) => a.id !== req.params.id); store.save(); back(res, '/admin/points', 'Removed.'); });

// ---------- Pinnies
// Custody is not assigned from Llama Points, and this page cannot reassign it.
r.get('/pinnies', (req, res) => {
  page(req, res, '/admin/pinnies', 'Pinnies', `<div class="card"><h2>🟨 Spare pinnies</h2><p>${esc(cfg.pinnies.custody)}</p></div>`);
});

// ---------- Injuries
r.get('/injuries', (req, res) => {
  const d = db();
  const row = (i) => `<div class="game"><b>${esc(pname(i.playerId))}</b> — ${esc(i.injury || 'injury')} ${i.cleared ? `<span class="pill good">cleared ${esc(T.fmtDay(i.clearedAt))}</span>` : '<span class="pill bad">on reserve</span>'}<div class="small muted">Hurt ${esc(T.fmtDate(i.dateInjured))}${i.expectedReturn ? ` · expected back ${esc(T.fmtDate(i.expectedReturn))}` : ''}</div>
    ${i.cleared ? '' : `<form method="post" action="/admin/injuries/${i.id}"><div class="row"><div><label>Expected return</label><input type="date" name="expectedReturn" value="${esc(i.expectedReturn || '')}"></div><div><label>&nbsp;</label><button class="small">Update date</button></div></div></form><form method="post" action="/admin/injuries/${i.id}/clear"><button class="small">✅ Cleared to play</button></form>`}</div>`;
  page(req, res, '/admin/injuries', 'Injuries', `<div class="card"><h2>🩹 Injury reserve</h2>${help('Players usually add themselves. While someone is on the list she gets no "are you playing?" messages. Players share only what they\'re comfortable with.')}
    ${d.injuries.filter((i) => !i.cleared).map(row).join('') || '<p class="muted">Nobody injured 🎉</p>'}
    ${d.injuries.some((i) => i.cleared) ? `<details><summary>Cleared</summary>${d.injuries.filter((i) => i.cleared).map(row).join('')}</details>` : ''}</div>
  <div class="card"><h2>➕ Add someone</h2><form method="post" action="/admin/injuries"><label>Who</label><select name="playerId">${playerOptions()}</select><label>Injury (vague is fine)</label><input name="injury"><div class="row"><div><label>Date injured</label><input type="date" name="dateInjured" value="${T.todayLocalStr()}"></div><div><label>Expected return</label><input type="date" name="expectedReturn"></div></div><button class="primary big">Add to injury reserve</button></form></div>`);
});
r.post('/injuries', (req, res) => { const b = req.body; db().injuries.push({ id: store.id('i'), playerId: b.playerId, injury: (b.injury || '').trim().slice(0, 120), dateInjured: b.dateInjured || T.todayLocalStr(), expectedReturn: b.expectedReturn || '', cleared: false, clearedAt: null, addedBy: 'captain', addedAt: new Date().toISOString() }); store.save(); back(res, '/admin/injuries', 'Added.'); });
r.post('/injuries/:id', (req, res) => { const i = db().injuries.find((x) => x.id === req.params.id); if (i) { i.expectedReturn = req.body.expectedReturn || ''; i.returnCheckAt = null; store.save(); } back(res, '/admin/injuries', 'Date updated.'); });
r.post('/injuries/:id/clear', (req, res) => { const i = db().injuries.find((x) => x.id === req.params.id); if (i) { i.cleared = true; i.clearedAt = new Date().toISOString(); store.save(); } back(res, '/admin/injuries', 'Cleared — messages to her restart automatically.'); });

// ---------- Team health
r.get('/health', (req, res) => {
  const d = db(); const rep = health.report(d); const t = rep.totals; const pct = health.pct;
  const COPY = require('../messages');
  const nudgeRows = Object.values(rep.vstats).filter((v) => v.step.goal !== 'none').map((v) => ['A', 'B'].map((k) => { const x = v.variants[k]; return `<tr><td>${k === 'A' ? `<b>${esc(v.step.label)}</b><br>` : ''}<span class="small">${k}: "${esc(COPY[v.step.key][k].subject.replace(/\{\w+\}/g, '…'))}"</span> ${v.winner === k ? '🏆' : ''}</td><td>${x.sends}</td><td>${pct(x.rate)}</td><td>${x.medianMinutes == null ? '–' : x.medianMinutes < 90 ? x.medianMinutes + ' min' : (x.medianMinutes / 60).toFixed(1) + ' h'}</td></tr>`; }).join('')).join('');
  const gameRows = rep.games.slice().reverse().map((x) => `<tr><td>${esc(T.fmtDay(x.game.startsAt))}</td><td>${x.inAtKickoff}</td><td><b>${x.present}</b></td><td>${pct(x.byThuRate)}</td><td>${pct(x.showUpRate)}</td><td>${x.result ? `<b>${x.result.outcome}</b> ${x.result.us}-${x.result.them}` : '–'}</td></tr>`).join('');
  const st = d.standings || []; const last = st[st.length - 1];
  page(req, res, '/admin/health', 'Team health', `
  <div class="card gw"><h2>💡 What's working</h2>${help('The app tries two versions of each message and keeps the one that gets more answers. It also learns when each player usually replies.')}<ul class="clean">${rep.working.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>
  <div class="card"><h2>📊 The numbers (last ${rep.games.length} games)</h2><div class="stat">
    <div><b>${pct(t.byThuRate)}</b><span>answered by Thursday</span></div><div><b>${t.avgPresent == null ? '–' : t.avgPresent.toFixed(1)}</b><span>players per game (said In: ${t.avgIn == null ? '–' : t.avgIn.toFixed(1)})</span></div>
    <div><b>${pct(t.showUpRate)}</b><span>of "In" actually came</span></div><div><b>${pct(t.noShowRate)}</b><span>no-shows (no heads-up)</span></div>
    <div><b>${pct(t.responseRate)}</b><span>answered before kickoff</span></div><div><b>${t.record.join('-')}</b><span>wins-losses-ties${last ? ` · #${last.place} of ${last.of}` : ''}</span></div></div></div>
  <div class="card"><h2>📈 Players per game</h2>${help(`Dots are how many players came. The green line is our average; dashed lines are the normal range. A red dot means an unusual week. Pink area = fewer than ${cfg.roster.minPlayers}.`)}${health.chartSvg(rep.games, rep.chart)}</div>
  <div class="card"><h2>🗓️ Game by game</h2><table><tr><th>Game</th><th>Said in</th><th>Came</th><th>By Thu</th><th>Showed</th><th>Score</th></tr>${gameRows}</table></div>
  <div class="card"><h2>📨 Which messages get answers</h2>${help('"Answered" = she replied after that message. 🏆 = the winning version, now sent most of the time.')}<table><tr><th>Message</th><th>Sent</th><th>Answered</th><th>Typical wait</th></tr>${nudgeRows}</table></div>
  <div class="card"><h2>💬 Auto-replies: do they bring players back?</h2>${help('"Came around" = she said In later (for the game we asked about) after our friendly reply.')}
    <table><tr><th>Reply type</th><th>Sent</th><th>Came around</th></tr>${Object.entries(require('../lib/inbound').replyStats(d)).map(([k, vs]) => Object.entries(vs).map(([v, x]) => `<tr><td>${esc(INTENT_LABEL[k] || k)} <span class="tag">${v}</span></td><td>${x.sends}</td><td>${x.eligible ? `${x.conversions}/${x.eligible}` : '–'}</td></tr>`).join('')).join('') || '<tr><td class="muted">No replies yet</td></tr>'}</table></div>
  <div class="card"><h2>🏆 Division standing</h2>${help('Type in our place from the league website now and then.')}
    <table>${st.slice().reverse().map((s) => `<tr><td>${esc(T.fmtDate(s.date))}</td><td><b>#${s.place}</b> of ${s.of}</td><td class="small">${esc(s.division || '')} ${esc(s.note || '')}</td></tr>`).join('')}</table>
    <form method="post" action="/admin/standings"><div class="row"><div><label>Our place</label><input type="number" min="1" name="place" required></div><div><label>Out of</label><input type="number" min="1" name="of" value="${last ? last.of : 8}"></div></div><label>Note (optional)</label><input name="note"><button class="primary big">Save standing</button></form></div>`);
});
r.post('/standings', (req, res) => { const d = db(); d.standings ||= []; d.standings.push({ id: store.id('s'), date: T.todayLocalStr(), place: Number(req.body.place), of: Number(req.body.of), division: (d.standings.slice(-1)[0] || {}).division || '', note: (req.body.note || '').trim() }); store.save(); back(res, '/admin/health', 'Standing saved.'); });

// ---------- Outbox
const SIM_FILE = require('path').join(require('path').dirname(store.FILE), 'simulation', 'oct25-db.json');
r.get('/outbox', (req, res) => {
  const d = db(); const sim = req.query.view === 'sim';
  let src = d;
  if (sim) { if (!fs.existsSync(SIM_FILE)) return back(res, '/admin/outbox', 'No simulation yet. Run: npm run simulate'); src = JSON.parse(fs.readFileSync(SIM_FILE, 'utf8')); }
  const msgs = (src.messages || []).filter((m) => !sim || m.tag === 'sim').slice().sort((a, b) => String(b.sentAt || b.scheduledFor).localeCompare(String(a.sentAt || a.scheduledFor))).slice(0, 150);
  const pn = (id) => (src.players.find((p) => p.id === id) || {}).name || '?';
  const label = (k) => (cfg.automation.steps.find((s) => s.key === k) || { label: k === 'irCheck' ? 'Ready to come back?' : k }).label;
  const g = team.nextGame(d);
  const sched = g ? auto.schedule(d, g) : [];
  const counts = msgs.reduce((a, m) => ((a[m.status] = (a[m.status] || 0) + 1), a), {});
  page(req, res, '/admin/outbox', 'Outbox', `
  <div class="card"><h2>📨 Outbox</h2>${help(`Every automatic message, newest first. <b>Local test mode:</b> nothing is really emailed — messages are only written here. They will come from ${esc(cfg.teamAccount.email)}.`)}
    <div class="btns" style="grid-template-columns:1fr 1fr"><a class="btn ${sim ? '' : 'primary'}" href="/admin/outbox">Real (this app)</a><a class="btn ${sim ? 'primary' : ''}" href="/admin/outbox?view=sim">Oct 25 practice run</a></div>
    <p class="small">${sim ? 'A practice run of the whole Oct 25 week with pretend replies. It did not change the real data.' : ''} Showing ${msgs.length}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}.</p></div>
  ${!sim && g ? `<div class="card"><h2>⏭️ Coming up for ${esc(T.fmtDay(g.startsAt))}</h2><table>${sched.map((x) => `<tr><td>${esc(x.step.label)}</td><td class="small">${esc(T.fmtGame(x.due))}</td><td class="small">${x.run ? (x.run.status === 'done' ? `✅ ${x.sent} sent${x.queued ? `, ${x.queued} waiting` : ''}` : esc(x.run.status)) : '⏳'}</td></tr>`).join('')}</table></div>` : ''}
  <div class="card">${msgs.map((m) => `<details class="msg"><summary>${m.status === 'sent' ? '✉️' : m.status === 'queued' ? '⏳' : '⏭️'} <b>${esc(pn(m.playerId))}</b> · ${esc(label(m.step))}${m.variant ? ` <span class="tag">${m.variant}</span>` : ''} <span class="tag">${esc(m.channel)}</span><br><span class="small muted">${m.status === 'sent' ? esc(T.fmtStamp(m.sentAt)) + (m.shiftMinutes ? ` (moved ${m.shiftMinutes > 0 ? '+' : ''}${m.shiftMinutes} min to her usual time)` : '') : m.status === 'queued' ? 'will send ' + esc(T.fmtStamp(m.scheduledFor)) : 'not sent: ' + esc(m.reason)}</span></summary>${m.subject ? `<pre>To: ${esc(m.to)}\nSubject: ${esc(m.subject)}\n\n${esc(m.body)}</pre>` : ''}</details>`).join('') || '<p class="muted">Nothing yet.</p>'}</div>`);
});

// ---------- Inbox (auto-handled replies)
const inbound = require('../lib/inbound');
const INTENT_LABEL = { in: '👍 In', out: '👎 Out', maybe: '🤔 Maybe', injury: '🩹 Injury', conflict: '🏠 Sick / family', late: '⏰ Running late', friend: '🤝 Bringing a friend', question: '❓ Question', pause: '🔕 Pause messages', other: '🤷 Unclear', irOther: '🩹 On IR, unclear', unknown: '👋 New person' };
r.get('/inbox', (req, res) => {
  const d = db(); d.inbound ||= []; const on = d.settings.autoRepliesOn !== false;
  const refs = (d.pendingReferrals || []).filter((x) => x.status === 'pending');
  const digest = inbound.digestPreview(d);
  const items = d.inbound.slice().reverse().map((e) => {
    const rep = d.messages.find((m) => m.id === e.replyMsgId); const c = e.classification || {};
    const replyState = !rep ? '' : rep.status === 'sent' ? `✉️ replied ${esc(T.fmtStamp(rep.sentAt))}` : rep.status === 'queued' ? `⏳ reply goes out ${esc(T.fmtStamp(rep.scheduledFor))}${auto.isQuiet(new Date()) ? ' (quiet hours)' : ''}` : `⏭️ no reply: ${esc(rep.reason)}`;
    return `<details class="msg"><summary>${e.status === 'ignored' ? '🚫' : e.status === 'held' ? '⏸️' : '📩'} <b>${esc(e.playerId ? pname(e.playerId) : e.from)}</b> · ${e.status === 'ignored' ? `<span class="tag">ignored: ${esc(e.ignoredReason)}</span>` : e.status === 'held' ? '<span class="tag">waiting (auto-replies OFF)</span>' : `<span class="pill">${esc(INTENT_LABEL[rep ? rep.intent : c.intent] || c.intent)}</span>${c.sensitive ? ' <span class="pill bad">FYI to captain</span>' : ''}`}
      <br><span class="small muted">${esc(T.fmtStamp(e.processedAt))} · "${esc(e.subject)}"</span>
      ${e.actions.length ? `<div class="small">✅ ${e.actions.map((a) => esc(a.detail)).join(' · ')}</div>` : ''}<div class="small muted">${replyState}</div></summary>
      <pre>From: ${esc(e.from)}\nSubject: ${esc(e.subject)}\n\n${esc(e.body)}</pre>${rep ? `<div class="small"><b>Auto-reply${rep.variant ? ' (version ' + rep.variant + ')' : ''}:</b></div><pre>To: ${esc(rep.to)}\nSubject: ${esc(rep.subject)}\n\n${esc(rep.body)}</pre>` : ''}
      <div class="small muted">Read by: ${esc(c.method || 'rules')}${c.llmError ? ' (AI failed, used rules)' : ''}</div></details>`;
  }).join('');
  page(req, res, '/admin/inbox', 'Inbox', `
  <div class="card kill ${on ? 'on' : 'off'}"><div><b style="font-size:18px">${on ? '✅ Auto-replies are ON' : '⛔ Auto-replies are OFF'}</b><div class="small">${on ? 'Replies to the team inbox are read, the roster is updated, and a friendly answer goes out automatically.' : 'New emails wait here. Nothing is answered or changed.'}</div></div>
    <form method="post" action="/admin/inbox/switch"><input type="hidden" name="on" value="${on ? '0' : '1'}"><button class="${on ? '' : 'primary'}">${on ? 'Turn OFF' : 'Turn ON'}</button></form></div>
  <div class="card"><h2>📥 Inbox</h2>${help(`Players reply to ${esc(cfg.teamAccount.email)}. The app reads each email, updates RSVPs, injuries and pauses, and answers kindly. <b>You don't need to approve anything.</b> Anything upset or about money also lands in your daily FYI email. Never answered: auto-replies, out-of-office, mailing lists, no-reply senders. At most 1 reply per conversation per day, and none at night.`)}
    <p class="small"><b>Local test mode:</b> replies only go to the Outbox.</p></div>
  ${refs.length ? `<div class="card"><h2>🤝 Friends to confirm</h2>${help(`When the friend actually plays, tap Confirm to give +${cfg.points.referral.pts} points.`)}${refs.map((x) => `<div class="game"><b>${esc(pname(x.playerId))}</b> is bringing <b>${esc(x.friendName || 'a friend')}</b> <span class="small muted">${esc(T.fmtDay(x.createdAt))}</span>
    <div><form class="inline" method="post" action="/admin/referrals/${x.id}"><input type="hidden" name="do" value="confirm"><button class="small primary">She played: +${cfg.points.referral.pts}</button></form> <form class="inline" method="post" action="/admin/referrals/${x.id}"><input type="hidden" name="do" value="dismiss"><button class="small">Didn't happen</button></form></div></div>`).join('')}</div>` : ''}
  ${digest ? `<div class="card"><h2>🗞️ Tonight's FYI email to you</h2>${help(`Goes to ${esc(d.settings.captainEmail || cfg.inbound.captainEmail)} at ${esc(cfg.inbound.fyiDigestTime)} MT. Just so you know. Nothing to approve.`)}<pre>${esc(digest.subject)}\n\n${esc(digest.body)}</pre></div>` : ''}
  <div class="card"><h2>🗂️ Every email (newest first)</h2>${items || '<p class="muted">No emails yet.</p>'}</div>
  <div class="card"><h2>🧪 Try it: paste a test email</h2>${help('Pretend to be a player. Use her email address (see Players). It runs exactly like a real email.')}
    <form method="post" action="/admin/inbox/test"><label>From (email)</label><input name="from" placeholder="sample.sam@example.com" required><label>Subject</label><input name="subject" value="Re: Sunday"><label>Message</label><textarea name="body" rows="4" required placeholder="Sorry, sprained my ankle, out 2 weeks"></textarea>
    <label><input type="checkbox" name="auto" value="1">Pretend it's an automatic "out of office" email</label><button class="primary big">Run it</button></form></div>`);
});
r.post('/inbox/switch', async (req, res, next) => {
  try {
    const d = db(); d.settings.autoRepliesOn = req.body.on === '1';
    if (d.settings.autoRepliesOn) for (const e of (d.inbound || []).filter((x) => x.status === 'held')) { e.status = 'processed'; e.ignoredReason = null; await inbound.handle(d, e, new Date()); }
    store.save(); back(res, '/admin/inbox', d.settings.autoRepliesOn ? 'Auto-replies are ON.' : 'Auto-replies are OFF. New emails will wait.');
  } catch (e) { next(e); }
});
r.post('/inbox/test', async (req, res, next) => {
  try {
    const b = req.body; const headers = b.auto ? { 'Auto-Submitted': 'auto-replied' } : {};
    const rec = await inbound.ingest(db(), { from: b.from.trim(), subject: (b.subject || '').trim(), body: b.body, headers, messageId: `<paste-${Date.now()}@local>` }, { source: 'paste' });
    inbound.flush(db(), new Date()); store.save();
    back(res, '/admin/inbox', rec.status === 'ignored' ? `Ignored: ${rec.ignoredReason}` : 'Done! See the top of the list.');
  } catch (e) { next(e); }
});
r.post('/referrals/:id', (req, res) => {
  const d = db(); const x = (d.pendingReferrals || []).find((y) => y.id === req.params.id);
  if (x && req.body.do === 'confirm') { x.status = 'confirmed'; d.awards.push({ id: store.id('a'), playerId: x.playerId, type: 'referral', date: new Date().toISOString(), note: `Brought in ${x.friendName || 'a friend'}`, gameId: null }); }
  if (x && req.body.do === 'dismiss') x.status = 'dismissed';
  store.save(); back(res, '/admin/inbox', x && x.status === 'confirmed' ? `+${cfg.points.referral.pts} points given 🙌` : 'Updated.');
});

// ---------- Calendar preview (stub; no API calls)
r.get('/calendar', (req, res) => {
  const plan = planSync(db());
  const word = { accepted: '✅ Yes (In)', declined: '❌ No (Out)', tentative: '🤔 Maybe', needsAction: '— no reply' };
  page(req, res, '/admin/calendar', 'Calendar preview', `<div class="card"><h2>🗓️ Calendar preview</h2>${help(`This shows the Google Calendar invites the app <b>would</b> send — one per game, every player invited. Nothing is sent yet. Saying Yes/No/Maybe on the invite will count as In/Out/Maybe.`)}
    <p class="small">Invites will come from the team account: <b>${esc(cfg.teamAccount.email)}</b> (calendar: ${esc(cfg.teamAccount.calendarId)})<br>Saved to <code>data/calendar-plan.json</code> · ${esc(T.fmtStamp(plan.generatedAt))}</p></div>
  ${plan.events.map((e) => `<div class="card"><h2>${esc(e.event.summary)}</h2><div class="small"><b>${esc(e.humanTime)}</b> (${esc(e.event.start.timeZone)})<br>📍 ${esc(e.event.location)}<br>Organizer: ${esc(e.event.organizer.email)} · would ${esc(e.action)}</div>
    <h3>Invited (${e.event.attendees.length})</h3>${e.event.attendees.map((a) => `<div class="cal-att"><span>${esc(a.displayName)} <span class="muted">${esc(a.email)}</span></span><span>${word[a.responseStatus]}</span></div>`).join('')}
    <details><summary class="small">Technical details (event payload)</summary><pre>${esc(JSON.stringify(e.event, null, 2))}</pre></details></div>`).join('')}`);
});

// ---------- Settings / hand-over
r.get('/settings', (req, res) => {
  const d = db();
  page(req, res, '/admin/settings', 'Settings', `<div class="card"><h2>⚙️ Settings</h2>${help('Handing the team to a new captain? Change the name, then make a new captain link and give it to her. The old link stops working right away.')}
    <form method="post" action="/admin/settings"><label>Captain's name (shown at the bottom of every page)</label><input name="captainName" value="${esc(d.settings.captainName)}">
    <label>Captain's email (gets the daily FYI digest)</label><input name="captainEmail" type="email" value="${esc(d.settings.captainEmail || cfg.inbound.captainEmail)}"><button class="primary big">Save</button></form></div>
  <div class="card"><h2>🔑 Captain link</h2><p class="small">Your current captain link (keep it private, like a house key):</p><input readonly value="${esc(cfg.baseUrl)}/admin?key=${esc(d.settings.adminToken)}" onclick="this.select()">
    <form method="post" action="/admin/settings/reset" onsubmit="return confirm('Make a new captain link? The old one will stop working.')"><button class="big">Make a new captain link</button></form></div>
  <div class="card"><h2>📨 Team email account</h2><p class="small">Messages and calendar invites come from <b>${esc(cfg.teamAccount.email)}</b>. Whoever is captain should have the login for this account. (Changing it is a technical setup step — see the README.)</p></div>
  <div class="card"><h2>✅ Self check-in (honor system)</h2><p class="small">Players tap <b>"I'm here"</b> on their own link from ${cfg.demo ? 'any time in game week (demo)' : `${cfg.checkin.opensMinutesBefore} min before kickoff`} until ${cfg.checkin.closesHoursAfter} h after. We trust each other: no GPS, no photos. If someone forgets or taps by mistake, fix it on the game page. Only "said In, didn't come, didn't tell anyone" costs points (${cfg.points.noShow.pts}).</p></div>
  <div class="card"><h2>🔒 What's turned off${cfg.demo ? ' in this demo' : ''}</h2><p class="small">${cfg.demo ? 'No real emails, texts or calendar invites are sent. Messages are only written to the Outbox so you can read them. Out-notes on a game page are not a private channel here: anyone can open the captain pages with the public demo key, and all players are made up.' : 'Real sending is controlled by the setup in the README. Out-notes are visible to anyone who has the captain link; there is no separate account login.'}</p></div>
  <p style="text-align:center"><a class="btn" href="/admin/logout">Sign out</a></p>`);
});
r.post('/settings', (req, res) => { db().settings.captainName = (req.body.captainName || '').trim().slice(0, 60) || 'Captain'; if (req.body.captainEmail) db().settings.captainEmail = req.body.captainEmail.trim().slice(0, 120); store.save(); back(res, '/admin/settings', 'Saved.'); });
r.post('/settings/reset', (req, res) => {
  if (cfg.demo) return back(res, '/admin/settings', 'Making a new captain link is turned off in the demo (so visitors keep access).');
  const d = db(); d.settings.adminToken = store.token() + store.token(); store.save(); setKey(res, d.settings.adminToken);
  back(res, '/admin/settings', 'New captain link made. Copy it below and keep it safe. The old one no longer works.');
});

module.exports = r;
