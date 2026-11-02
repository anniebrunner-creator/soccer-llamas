// Inbound replies to the team inbox: match -> classify -> apply -> auto-reply (no approvals).
// Local: reads data/inbox-fixtures/*.json and the captain "Inbox" paste form. Production:
// pollGmail() would list unread mail on the team account via the Gmail API (OAuth) — stub below.
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const COPY = require('../messages').replies;
const T = require('./time');
const team = require('./team');
const { id } = require('./store');
const { setRsvp } = require('./actions');
const { classify, shouldIgnore } = require('./classify');
const { isQuiet, afterQuiet } = require('./automation');
const { channels } = require('./channels');
const I = cfg.inbound;
const DAY = 86400000;

const addrOf = (s) => { const m = String(s || '').match(/<([^>]+)>/); return (m ? m[1] : String(s || '')).trim().toLowerCase(); };
const nameOf = (s) => { const m = String(s || '').match(/^\s*"?([^"<]+?)"?\s*</); return m ? m[1].trim() : ''; };
const threadKey = (e) => e.threadId || `${addrOf(e.from)}|${String(e.subject || '').replace(/^((re|fwd?):\s*)+/i, '').trim().toLowerCase()}`;
const ensure = (db) => { db.inbound ||= []; db.pendingReferrals ||= []; db.fyi ||= []; db.messages ||= []; db.settings.autoRepliesOn ??= true; db.settings.captainEmail ||= I.captainEmail; };

function gameAfter(db, g) { const list = team.upcomingGames(db).filter((x) => new Date(x.startsAt) > new Date()); const i = list.findIndex((x) => x.id === g.id); return list[i + 1] || null; }
function links(p, g) { const b = cfg.baseUrl + '/p/' + p.token; return g ? { inLink: `${b}/go/${g.id}/in?m=reply`, outLink: `${b}/go/${g.id}/out?m=reply`, maybeLink: `${b}/go/${g.id}/maybe?m=reply` } : {}; }
function feeAnswer(db, p) {
  const fees = db.fees.filter((f) => f.playerId === p.id);
  if (!fees.length) return "💵 Fees: I don't see any fees for you right now.";
  return fees.map((f) => f.paidAt ? `💵 ${f.label} ($${f.amount}): marked paid on ${T.fmtDay(f.paidAt)}. You're all set, thank you!` : `💵 ${f.label} ($${f.amount}): our records don't show this as received yet.`).join('\n');
}
function gameAnswer(g) { return g ? `📅 ${T.fmtGame(g.startsAt)} at ${g.location}, ${g.address}\n📍 Map: https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(g.address)}` : 'No upcoming games on the schedule right now.'; }

// A/B for reply copy: even split, then favor the variant that turns Outs/Maybes into Ins.
function replyStats(db) {
  const out = {};
  for (const m of db.messages) {
    if (m.kind !== 'reply' || !m.variant) continue;
    const k = m.intent; const v = ((out[k] ||= {})[m.variant] ||= { sends: 0, conversions: 0, eligible: 0 });
    v.sends++;
    if (m.convGameId) {
      v.eligible++;
      const r = db.rsvps.find((x) => x.gameId === m.convGameId && x.playerId === m.playerId);
      const t0 = new Date(m.sentAt || m.createdAt);
      if (r && r.history.some((h) => h.status === 'in' && new Date(h.at) > t0)) v.conversions++;
    }
  }
  return out;
}
function chooseVariant(db, intent) {
  const vs = Object.keys(COPY[intent] || { A: 1 }); if (vs.length < 2) return vs[0];
  const st = replyStats(db)[intent] || {}; const n = (v) => (st[v] ? st[v].sends : 0);
  if (vs.some((v) => n(v) < I.abMinSends) || Math.random() < 0.1) return n('A') <= n('B') ? 'A' : 'B';
  const rate = (v) => ((st[v].conversions + 1) / (st[v].eligible + 2));
  return rate('A') >= rate('B') ? 'A' : 'B';
}

function fill(tpl, vars) { return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')); }

async function ingest(db, email, { now = new Date(), source = 'fixture' } = {}) {
  ensure(db);
  const rec = { id: id('in'), source, messageId: email.messageId || id('mid'), threadId: threadKey(email), from: email.from, fromAddr: addrOf(email.from), subject: email.subject || '', body: email.body || '', headers: email.headers || {}, receivedAt: email.receivedAt || now.toISOString(), processedAt: now.toISOString(), actions: [], status: 'processed' };
  if (db.inbound.some((x) => x.messageId === rec.messageId)) return null; // already handled
  db.inbound.push(rec);
  const ign = shouldIgnore({ ...email, from: rec.fromAddr });
  if (ign) { rec.status = 'ignored'; rec.ignoredReason = ign; return rec; }
  if (!db.settings.autoRepliesOn) { rec.status = 'held'; rec.ignoredReason = 'auto-replies are OFF (will process when turned on)'; return rec; }
  return handle(db, rec, now);
}

async function handle(db, rec, now) {
  const p = db.players.find((x) => x.email && x.email.toLowerCase() === rec.fromAddr);
  const next = team.nextGame(db, now);
  const act = (type, detail) => rec.actions.push({ type, detail, at: now.toISOString() });
  let intent, vars = { game: next ? T.fmtGame(next.startsAt) : 'our next game', location: next ? next.location : '' }, convGameId = null, extras = '';

  if (!p) {
    rec.playerId = null; intent = 'unknown';
    rec.classification = { method: 'rules', intent: 'unknown' };
    db.fyi.push({ id: id('fyi'), at: now.toISOString(), inboundId: rec.id, reason: 'New person wrote in (wants to join or sub?)', summary: `${rec.from}: "${rec.subject}"` });
    act('captain-fyi', 'unknown sender → captain FYI digest');
  } else {
    rec.playerId = p.id;
    const c = await classify(rec.subject, rec.body, { games: db.games, now });
    rec.classification = { ...c, cleaned: undefined };
    intent = c.intent;
    const g = db.games.find((x) => x.id === c.gameId) || next;
    const after = g ? gameAfter(db, g) : null;
    Object.assign(vars, { first: p.name, game: g ? T.fmtGame(g.startsAt) : 'our next game', time: g ? T.fmtTime(g.startsAt) : '', location: g ? g.location : '', count: g ? team.headcount(db, g).in.length : 0, nextGame: after ? T.fmtGame(after.startsAt) : 'the next one', nextInLink: after ? links(p, after).inLink : cfg.baseUrl + '/p/' + p.token, pageLink: cfg.baseUrl + '/p/' + p.token, pauseLink: cfg.baseUrl + '/p/' + p.token + '/pause', ...links(p, g) });
    // --- apply updates
    if (c.rsvp && g && new Date(g.startsAt) > now) {
      const prev = team.rsvpFor(db, g.id, p.id); const before = prev ? { status: prev.status } : null;
      const r = setRsvp(db, p.id, g.id, c.rsvp, now.toISOString(), 'email-reply');
      r.history[r.history.length - 1].inboundId = rec.id;
      if (intent === 'late') r.late = true;
      act('rsvp', before && before.status === c.rsvp ? `still ${c.rsvp} for ${T.fmtDay(g.startsAt)}` : `${before ? before.status + ' → ' : ''}${c.rsvp} for ${T.fmtDay(g.startsAt)}`);
    }
    if (intent === 'injury') {
      const existing = db.injuries.find((x) => x.playerId === p.id && !x.cleared);
      if (existing) { if (c.injury.expectedReturn) existing.expectedReturn = c.injury.expectedReturn; act('injury', 'already on IR; updated'); }
      else { db.injuries.push({ id: id('i'), playerId: p.id, injury: c.injury.text || 'injury', dateInjured: c.injury.dateInjured, expectedReturn: c.injury.expectedReturn || '', cleared: false, clearedAt: null, addedBy: 'email', addedAt: now.toISOString(), inboundId: rec.id }); act('injury', `added to IR: ${c.injury.text || 'injury'}${c.injury.expectedReturn ? ', back ~' + T.fmtDate(c.injury.expectedReturn) : ''}`); }
      vars.part = c.injury.part || 'injury';
      vars.returnText = c.injury.expectedReturn ? ` (hoping for ~${T.fmtDate(c.injury.expectedReturn)})` : '';
    }
    if (intent === 'pause') {
      p.pausedAt = now.toISOString(); p.pausedUntil = new Date(now.getTime() + I.pauseDays * DAY).toISOString();
      vars.until = T.fmtDay(p.pausedUntil); act('pause', `messages paused until ${vars.until}`);
    }
    if (c.flags.friend || intent === 'friend') {
      const ex = db.pendingReferrals.find((x) => x.playerId === p.id && x.status === 'pending' && (!x.friendName || !c.friendName || x.friendName === c.friendName));
      if (ex) { if (c.friendName) ex.friendName = c.friendName; act('referral', `pending referral updated${c.friendName ? ': ' + c.friendName : ''}`); }
      else { db.pendingReferrals.push({ id: id('ref'), playerId: p.id, friendName: c.friendName || '', inboundId: rec.id, createdAt: now.toISOString(), status: 'pending' }); act('referral', `pending +${cfg.points.referral.pts} referral${c.friendName ? ' for ' + c.friendName : ''} (captain confirms once she plays)`); }
      vars.friend = c.friendName || 'your friend';
      if (intent !== 'friend') extras += fill(COPY.friendLine, vars);
    }
    if (intent === 'conflict') vars.reasonLine = c.flags.sick ? `Oh no, feel better soon, ${p.name}! 💛` : `Family first, ${p.name}! 💛`;
    if (c.flags.late) extras += COPY.lateLine;
    const answers = c.questions.map((q) => (q === 'fees' ? feeAnswer(db, p) : gameAnswer(g)));
    const uniq = [...new Set(answers)];
    if (uniq.length) extras = (intent === 'question' ? '\n\n' : '\n\n') + uniq.join('\n') + extras;
    if (c.sensitive) {
      extras += COPY.sensitiveLine;
      db.fyi.push({ id: id('fyi'), at: now.toISOString(), inboundId: rec.id, reason: c.questions.includes('fees') ? 'Money question / dispute' : 'Sounds upset or sensitive', summary: `${p.name}: "${(c.cleaned || '').slice(0, 160)}"` });
      act('captain-fyi', 'flagged sensitive → captain FYI digest (reply still sent)');
    }
    const ir = db.injuries.find((x) => x.playerId === p.id && !x.cleared);
    if (ir && intent === 'other') { intent = 'irOther'; vars.clearLink = `${cfg.baseUrl}/p/${p.token}/ir/${ir.id}/cleared`; }
    if (['out', 'conflict'].includes(intent)) convGameId = after ? after.id : null;
    if (['maybe', 'other', 'question'].includes(intent)) convGameId = g ? g.id : null;
  }
  vars.extras = extras;
  // --- reply (safety: one per thread per day, quiet hours, kill switch)
  const variant = chooseVariant(db, intent);
  const m = { id: id('m'), kind: 'reply', step: 'reply', intent, variant, channel: 'email', playerId: rec.playerId, to: rec.fromAddr, threadId: rec.threadId, inReplyTo: rec.messageId, inboundId: rec.id, convGameId, gameId: null, createdAt: now.toISOString(), subject: /^re:/i.test(rec.subject) ? rec.subject : `Re: ${rec.subject || 'Soccer Llamas'}`, body: fill(COPY[intent][variant], vars) };
  const dayAgo = now.getTime() - DAY;
  const repliedRecently = db.messages.filter((x) => x.kind === 'reply' && x.threadId === rec.threadId && x.status !== 'skipped' && new Date(x.createdAt).getTime() > dayAgo).length >= I.maxRepliesPerThreadPerDay;
  if (repliedRecently) { m.status = 'skipped'; m.reason = 'already replied in this thread today (updates were still applied)'; }
  else { m.status = 'queued'; m.scheduledFor = afterQuiet(now).toISOString(); }
  db.messages.push(m);
  rec.replyMsgId = m.id;
  return rec;
}

// Send queued replies (respecting quiet hours + kill switch) and the daily FYI digest.
function flush(db, now = new Date(), opts = {}) {
  ensure(db); let changed = false;
  if (!db.settings.autoRepliesOn || isQuiet(now)) return false;
  for (const m of db.messages) {
    if (m.kind !== 'reply' || m.status !== 'queued' || new Date(m.scheduledFor) > now) continue;
    m.sentAt = now.toISOString();
    try { m.delivery = channels.email.send(m, opts).delivery; m.status = 'sent'; } catch (e) { m.status = 'failed'; m.reason = e.message; }
    changed = true;
  }
  const [hh, mm] = I.fyiDigestTime.split(':').map(Number);
  const dueToday = T.atLocalTime(T.localDate(now), hh * 60 + mm);
  const pending = db.fyi.filter((f) => !f.digestId);
  if (pending.length && now >= dueToday) {
    const m = fyiDigest(db, pending, now); m.sentAt = now.toISOString();
    try { m.delivery = channels.email.send(m, opts).delivery; m.status = 'sent'; } catch (e) { m.status = 'failed'; m.reason = e.message; }
    db.messages.push(m); pending.forEach((f) => (f.digestId = m.id)); changed = true;
  }
  return changed;
}
function fyiDigest(db, items, now) {
  const lines = items.map((f) => { const r = db.inbound.find((x) => x.id === f.inboundId); const rep = r && db.messages.find((x) => x.id === r.replyMsgId); return `• ${f.reason}\n  ${f.summary}\n  Auto-reply: ${rep ? rep.status : 'none'}${r && r.actions.length ? '\n  Done automatically: ' + r.actions.map((a) => a.detail).join('; ') : ''}`; });
  return { id: id('m'), kind: 'fyi', step: 'captainFyi', variant: null, channel: 'email', playerId: null, to: db.settings.captainEmail, createdAt: now.toISOString(), status: 'queued',
    subject: `🦙 Captain FYI: ${items.length} inbox item${items.length === 1 ? '' : 's'} (${T.fmtDay(now)})`,
    body: `Hi ${db.settings.captainName}! Just so you know, nothing needs approval. The app already replied.\n\n${lines.join('\n\n')}\n\nFull log: ${cfg.baseUrl}/admin/inbox\n— Soccer Llamas 🦙` };
}
function digestPreview(db, now = new Date()) { ensure(db); const p = db.fyi.filter((f) => !f.digestId); return p.length ? fyiDigest(db, p, now) : null; }

// Local mode: pick up new fixture files.
async function pollFixtures(db, now = new Date()) {
  const dir = path.resolve(__dirname, '..', I.fixturesDir);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    e.messageId ||= 'fixture:' + f;
    if ((db.inbound || []).some((x) => x.messageId === e.messageId)) continue;
    if (await ingest(db, e, { now, source: 'fixture:' + f })) n++;
  }
  return n;
}
// Production: Gmail API polling as the team account (not implemented in the prototype).
// users.messages.list({ userId: 'me', q: 'in:inbox is:unread -from:me newer_than:3d' }) ->
// users.messages.get(format: 'full') -> map headers (From, Subject, Message-ID, Auto-Submitted,
// List-Id, Precedence) + text/plain body -> ingest() -> add label 'llamas-processed', remove UNREAD.
// Replies: users.messages.send with threadId + In-Reply-To/References headers.
async function pollGmail() { throw new Error('Gmail polling is not enabled in this local prototype.'); }

async function poll(db, now = new Date()) { return !cfg.demo && I.mode === 'gmail-api' ? pollGmail(db, now) : pollFixtures(db, now); }

module.exports = { ingest, handle, flush, poll, pollFixtures, replyStats, digestPreview, addrOf };
