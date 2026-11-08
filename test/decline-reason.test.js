// Optional Out notes: blank is valid, the owner can edit/clear, In/Maybe clears a stale
// note, and the text is absent from every response except the owner's page and the
// captain attendance page (existing captain-key check). Notes do not move points,
// injury reserve, or messages.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llamas-decline-'));
process.env.LLAMAS_DB = path.join(tmp, 'db.json');
process.env.OUTBOX_FILE = path.join(tmp, 'outbox.log');
process.env.NO_SCHEDULER = '1';
process.env.ADMIN_TOKEN = 'test-captain-key';
delete process.env.DEMO;
delete process.env.LLAMAS_LLM;

const store = require('../lib/store');
const { setRsvp, updateDeclineReason, declinePrivacyCopy, normalizeDeclineReason, DECLINE_REASON_MAX } = require('../lib/actions');
const { computePoints } = require('../lib/points');
const { buildEventPayload, planSync, applyGoogleResponses } = require('../lib/calendar');

const KEY = 'test-captain-key';
const NOTE = 'ZEBRA-PICNIC-NOTE-42';
const NOTE2 = 'CHANGED-PLANS-NOTE-77';
const XSS = '</textarea><script>alert(1)</script>';
const HEALTH = 'sprained my knee and cannot walk';
const WHEN = '2026-11-01T18:00:00.000Z';

function seedDb() {
  const db = store.empty();
  db.settings = { captainName: 'Test Captain', adminToken: KEY, automationsOn: false, autoRepliesOn: false, captainEmail: 'captain@example.com' };
  db.players = [
    { id: 'p_ada', name: 'Ada Llama', email: 'ada.llama@example.com', phone: '', channel: 'email', token: 'token-ada', role: 'roster', canKeep: false, active: true, pausedUntil: null, joinedAt: '2026-08-15', card: { status: 'missing', date: null } },
    { id: 'p_bea', name: 'Bea Llama', email: 'bea.llama@example.com', phone: '', channel: 'email', token: 'token-bea', role: 'roster', canKeep: false, active: true, pausedUntil: null, joinedAt: '2026-08-15', card: { status: 'missing', date: null } },
  ];
  db.games = [
    { id: 'g_next', startsAt: '2027-06-06T17:00:00.000Z', durationMin: 60, location: 'Stenger', address: '11200 W 58th Ave, Arvada, CO', opponent: 'Sample FC', notes: '', cancelled: false, calendarEventId: null, gameCardBy: null, result: null },
    { id: 'g_past', startsAt: '2020-01-05T18:00:00.000Z', durationMin: 60, location: 'Old Field', address: '1 Old St', opponent: '', notes: '', cancelled: false, calendarEventId: null, gameCardBy: null, result: null },
  ];
  db.messages = [];
  db.injuries = [];
  db.awards = [];
  store.set(db);
  return db;
}
seedDb();
const app = require('../server');

let server;
const request = (opts) => new Promise((resolve, reject) => {
  const body = opts.form ? new URLSearchParams(opts.form).toString() : null;
  const req = http.request({
    hostname: '127.0.0.1', port: server.address().port, path: opts.path, method: opts.method || 'GET',
    headers: { ...(opts.headers || {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}) },
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

function rsvpOf(playerId, gameId = 'g_next') {
  return store.get().rsvps.find((r) => r.playerId === playerId && r.gameId === gameId);
}
function mark(playerId, status, gameId = 'g_next') {
  const r = setRsvp(store.get(), playerId, gameId, status, WHEN, 'page');
  store.save();
  return r;
}
function pointsOf(playerId) { return computePoints(store.get())[playerId]; }
async function postRsvp(token, form) {
  return request({ method: 'POST', path: `/p/${token}/rsvp`, form });
}
async function pageOf(token) {
  const res = await request({ path: `/p/${token}` });
  assert.equal(res.status, 200);
  return res.body;
}
function hidden(text, label) {
  assert.equal(text.includes(NOTE), false, `${label} leaked the note`);
  assert.equal(text.includes(NOTE2), false, `${label} leaked the edited note`);
  assert.equal(text.includes('declineReason'), false, `${label} leaked the field name`);
  assert.equal(text.includes(XSS), false, `${label} leaked the raw note markup`);
  assert.equal(text.includes(HEALTH), false, `${label} leaked the health-like note`);
}

describe('optional out note', { concurrency: 1 }, () => {
  before(async () => { server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); });
  after(async () => { if (server) await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); });

  it('normalizes blank notes and describes privacy without pretending the demo is a private login', () => {
    assert.equal(normalizeDeclineReason(null).value, null);
    assert.equal(normalizeDeclineReason('   \n\t ').value, null);
    assert.equal(normalizeDeclineReason('  family plans  ').value, 'family plans');
    assert.equal(normalizeDeclineReason('a'.repeat(DECLINE_REASON_MAX)).ok, true);
    const tooLong = normalizeDeclineReason('b'.repeat(DECLINE_REASON_MAX + 1));
    assert.equal(tooLong.ok, false);
    assert.match(tooLong.error, /leave it blank/);
    const demo = declinePrivacyCopy(true);
    const real = declinePrivacyCopy(false);
    for (const copy of [demo, real]) {
      assert.match(copy, /Leaving this blank is completely fine/);
      assert.match(copy, /does not change your points, reminders, or injury reserve/);
      assert.match(copy, /health details/);
    }
    assert.match(demo, /public demo captain key/);
    assert.match(demo, /not a private login/);
    assert.match(demo, /made up/);
    assert.doesNotMatch(real, /not a private login/);
    assert.match(real, /Other players and the public team page do not get this note/);
    assert.match(real, /captain link/);
  });

  it('accepts a blank out with the optional prompt and no points difference versus another blank out', async () => {
    mark('p_ada', 'out');
    mark('p_bea', 'out');
    const before = pointsOf('p_ada');
    assert.equal(before.total, pointsOf('p_bea').total);
    assert.ok(before.items.some((i) => i.rule === 'rsvpByThursday' && i.pts === 3));
    const ada = await pageOf('token-ada');
    assert.match(ada, /Why can\u2019t you make it\?/);
    assert.match(ada, /<span class="muted">optional<\/span>/);
    assert.match(ada, /Leaving this blank is completely fine/);
    assert.doesNotMatch(ada, /name="declineReason"[^>]*required/);
    assert.equal(rsvpOf('p_ada').declineReason, null);

    const blank = await postRsvp('token-ada', { gameId: 'g_next', status: 'out', note: '1', declineReason: '   \n  ' });
    assert.equal(blank.status, 303);
    assert.equal(decodeURIComponent(blank.headers.location).includes('ZEBRA'), false);
    assert.match(decodeURIComponent(blank.headers.location), /No note saved|completely fine|Note cleared/);
    assert.equal(rsvpOf('p_ada').status, 'out');
    assert.equal(rsvpOf('p_ada').declineReason, null);
    assert.deepEqual(pointsOf('p_ada'), before);
    assert.equal(pointsOf('p_ada').total, pointsOf('p_bea').total);
    assert.equal(store.get().injuries.length, 0);
    assert.equal(store.get().messages.length, 0);
  });

  it('saves, edits, and clears the owner note without a new RSVP history entry or a points change', async () => {
    const row = mark('p_ada', 'out');
    row.toldTeam = false;
    row.noShow = false;
    const history = row.history.length;
    const updatedAt = row.updatedAt;
    const before = pointsOf('p_ada');
    const msgCount = store.get().messages.length;
    const saved = await postRsvp('token-ada', { gameId: 'g_next', status: 'out', note: '1', declineReason: `  ${NOTE}  ` });
    assert.equal(saved.status, 303);
    assert.equal(decodeURIComponent(saved.headers.location).includes(NOTE), false);
    assert.equal(rsvpOf('p_ada').declineReason, NOTE);
    assert.ok(rsvpOf('p_ada').declineReasonAt);
    assert.equal(rsvpOf('p_ada').history.length, history);
    assert.equal(rsvpOf('p_ada').updatedAt, updatedAt);
    assert.equal(JSON.stringify(rsvpOf('p_ada').history).includes(NOTE), false);
    assert.deepEqual(pointsOf('p_ada'), before);
    assert.equal(store.get().messages.length, msgCount);
    let html = await pageOf('token-ada');
    assert.ok(html.includes(NOTE));
    assert.match(html, /Clear note/);

    const edited = await postRsvp('token-ada', { gameId: 'g_next', status: 'out', note: '1', declineReason: NOTE2 });
    assert.equal(edited.status, 303);
    assert.equal(rsvpOf('p_ada').declineReason, NOTE2);
    assert.equal(rsvpOf('p_ada').history.length, history);
    html = await pageOf('token-ada');
    assert.ok(html.includes(NOTE2));
    assert.equal(html.includes(NOTE), false);

    const cleared = await postRsvp('token-ada', { gameId: 'g_next', status: 'out', note: '1', clearReason: '1', declineReason: NOTE2 });
    assert.equal(cleared.status, 303);
    assert.match(decodeURIComponent(cleared.headers.location), /Note cleared/);
    assert.equal(rsvpOf('p_ada').declineReason, null);
    assert.equal(rsvpOf('p_ada').declineReasonAt, null);
    assert.equal(rsvpOf('p_ada').status, 'out');
    html = await pageOf('token-ada');
    assert.equal(html.includes(NOTE2), false);
    assert.match(html, /Why can\u2019t you make it\?/);
    assert.deepEqual(pointsOf('p_ada'), before);
  });

  it('rejects an over-long note and escapes markup', async () => {
    mark('p_ada', 'out');
    await postRsvp('token-ada', { gameId: 'g_next', status: 'out', note: '1', declineReason: NOTE });
    const too = await postRsvp('token-ada', { gameId: 'g_next', status: 'out', note: '1', declineReason: 'x'.repeat(DECLINE_REASON_MAX + 1) });
    assert.equal(too.status, 303);
    assert.match(decodeURIComponent(too.headers.location), /under 500 characters/);
    assert.equal(rsvpOf('p_ada').declineReason, NOTE);

    await postRsvp('token-ada', { gameId: 'g_next', status: 'out', note: '1', declineReason: XSS });
    assert.equal(rsvpOf('p_ada').declineReason, XSS);
    const html = await pageOf('token-ada');
    assert.equal(html.includes('<script>'), false);
    assert.ok(html.includes('&lt;script&gt;'));
    const captain = await request({ path: '/admin/games/g_next', headers: { 'x-admin-token': KEY } });
    assert.equal(captain.status, 200);
    assert.equal(captain.body.includes('<script>'), false);
    assert.ok(captain.body.includes('&lt;script&gt;'));
    assert.ok(captain.body.includes('&lt;/textarea&gt;'));
  });

  it('clears a stale note when the RSVP becomes In or Maybe, and does not bring it back', async () => {
    mark('p_ada', 'out');
    await postRsvp('token-ada', { gameId: 'g_next', status: 'out', note: '1', declineReason: NOTE });
    const before = pointsOf('p_ada');
    const toIn = await postRsvp('token-ada', { gameId: 'g_next', status: 'in' });
    assert.match(decodeURIComponent(toIn.headers.location), /You're In/);
    assert.equal(rsvpOf('p_ada').status, 'in');
    assert.equal(rsvpOf('p_ada').declineReason, null);
    let html = await pageOf('token-ada');
    assert.equal(html.includes('Why can\u2019t you make it?'), false);
    assert.equal(html.includes(NOTE), false);
    assert.equal(pointsOf('p_ada').total, before.total);

    mark('p_ada', 'out');
    updateDeclineReason(rsvpOf('p_ada'), NOTE);
    store.save();
    await postRsvp('token-ada', { gameId: 'g_next', status: 'maybe' });
    assert.equal(rsvpOf('p_ada').status, 'maybe');
    assert.equal(rsvpOf('p_ada').declineReason, null);
    await postRsvp('token-ada', { gameId: 'g_next', status: 'out' });
    assert.equal(rsvpOf('p_ada').status, 'out');
    assert.equal(rsvpOf('p_ada').declineReason, null, 'a new Out must not resurrect the old note');

    updateDeclineReason(rsvpOf('p_ada'), NOTE);
    store.save();
    const again = await postRsvp('token-ada', { gameId: 'g_next', status: 'out' });
    assert.match(decodeURIComponent(again.headers.location), /you're Out/);
    assert.equal(rsvpOf('p_ada').declineReason, NOTE, 'tapping Out again does not wipe a note');
    const hacked = await postRsvp('token-ada', { gameId: 'g_next', status: 'out', declineReason: 'SHOULD-NOT-SAVE' });
    assert.match(decodeURIComponent(hacked.headers.location), /you're Out/);
    assert.equal(rsvpOf('p_ada').declineReason, NOTE, 'a status post cannot smuggle a note');
    assert.equal(JSON.stringify(store.get()).includes('SHOULD-NOT-SAVE'), false);
  });

  it('one-tap links and calendar replies clear the note only when leaving Out', async () => {
    mark('p_ada', 'out');
    updateDeclineReason(rsvpOf('p_ada'), NOTE);
    store.save();
    const stay = await request({ path: '/p/token-ada/go/g_next/out' });
    assert.equal(stay.status, 303);
    assert.equal(rsvpOf('p_ada').status, 'out');
    assert.equal(rsvpOf('p_ada').declineReason, NOTE);
    const gone = await request({ path: '/p/token-ada/go/g_next/in' });
    assert.equal(gone.status, 303);
    assert.equal(rsvpOf('p_ada').status, 'in');
    assert.equal(rsvpOf('p_ada').declineReason, null);

    mark('p_ada', 'out');
    updateDeclineReason(rsvpOf('p_ada'), NOTE);
    store.save();
    const db = store.get();
    const game = db.games.find((g) => g.id === 'g_next');
    assert.equal(JSON.stringify(buildEventPayload(db, game)).includes(NOTE), false);
    assert.equal(JSON.stringify(planSync(db)).includes(NOTE), false);
    applyGoogleResponses(db, [{ gameId: 'g_next', email: 'ada.llama@example.com', responseStatus: 'declined', at: new Date().toISOString() }], (playerId, gameId, status, at, source) => setRsvp(db, playerId, gameId, status, at, source));
    assert.equal(rsvpOf('p_ada').declineReason, NOTE);
    applyGoogleResponses(db, [{ gameId: 'g_next', email: 'ada.llama@example.com', responseStatus: 'accepted', at: new Date().toISOString() }], (playerId, gameId, status, at, source) => setRsvp(db, playerId, gameId, status, at, source));
    assert.equal(rsvpOf('p_ada').status, 'in');
    assert.equal(rsvpOf('p_ada').declineReason, null);
    store.save();
  });

  it('keeps the note off public, other-player, and summary responses; captain attendance can see it', async () => {
    mark('p_ada', 'out');
    mark('p_bea', 'in');
    updateDeclineReason(rsvpOf('p_ada'), NOTE);
    store.save();
    const own = await pageOf('token-ada');
    assert.ok(own.includes(NOTE));
    const other = await pageOf('token-bea');
    hidden(other, 'other player page');
    const dash = await request({ path: '/dashboard', headers: { cookie: `llamas_captain=${KEY}` } });
    assert.equal(dash.status, 200);
    assert.ok(dash.body.includes('Ada Llama'));
    hidden(dash.body, 'dashboard');
    const noKey = await request({ path: '/admin/games/g_next' });
    assert.equal(noKey.status, 401);
    hidden(noKey.body, 'captain page without key');
    const badKey = await request({ path: '/admin/games/g_next', headers: { 'x-admin-token': 'not-the-key' } });
    assert.equal(badKey.status, 401);
    hidden(badKey.body, 'captain page with wrong key');
    const apiOpen = await request({ path: '/api/summary' });
    assert.equal(apiOpen.status, 401);
    hidden(apiOpen.body, 'api without key');
    const apiBad = await request({ path: '/api/summary?key=demo-captain' });
    assert.equal(apiBad.status, 401);
    hidden(apiBad.body, 'api with the public demo key');
    const api = await request({ path: '/api/summary', headers: { 'x-admin-token': KEY } });
    assert.equal(api.status, 200);
    const summary = JSON.parse(api.body);
    assert.ok(summary.nextGame.out.includes('Ada Llama'));
    hidden(api.body, 'captain summary API');
    const captain = await request({ path: '/admin/games/g_next', headers: { 'x-admin-token': KEY } });
    assert.equal(captain.status, 200);
    assert.ok(captain.body.includes(NOTE));
    assert.match(captain.body, /optional note/);
    const viaLink = await request({ path: `/admin/games/g_next?key=${KEY}` });
    assert.equal(viaLink.status, 303);
    const cookie = (Array.isArray(viaLink.headers['set-cookie']) ? viaLink.headers['set-cookie'] : [viaLink.headers['set-cookie']]).map((c) => c.split(';')[0]).join('; ');
    const followed = await request({ path: viaLink.headers.location, headers: { cookie } });
    assert.equal(followed.status, 200);
    assert.ok(followed.body.includes(NOTE));

    const sneak = await postRsvp('token-bea', { gameId: 'g_next', status: 'out', note: '1', declineReason: 'BEA-SHOULD-NOT-OVERWRITE-ADA' });
    assert.equal(sneak.status, 303);
    assert.equal(rsvpOf('p_ada').declineReason, NOTE);
    assert.notEqual(rsvpOf('p_bea') && rsvpOf('p_bea').declineReason, 'BEA-SHOULD-NOT-OVERWRITE-ADA');
  });

  it('does not mark injury reserve, change reminders, or penalize a health-like note', async () => {
    mark('p_ada', 'out');
    mark('p_bea', 'out');
    const before = pointsOf('p_ada');
    const msgs = store.get().messages.length;
    const awards = store.get().awards.length;
    await postRsvp('token-ada', { gameId: 'g_next', status: 'out', note: '1', declineReason: HEALTH });
    assert.equal(rsvpOf('p_ada').declineReason, HEALTH);
    assert.equal(store.get().injuries.length, 0);
    assert.equal(store.get().messages.length, msgs);
    assert.equal(store.get().awards.length, awards);
    assert.equal(rsvpOf('p_ada').noShow, false);
    assert.equal(rsvpOf('p_ada').toldTeam, false);
    assert.deepEqual(pointsOf('p_ada'), before);
    assert.equal(pointsOf('p_ada').total, pointsOf('p_bea').total);
    const captain = await request({ path: '/admin/games/g_next', headers: { 'x-admin-token': KEY } });
    assert.ok(captain.body.includes(HEALTH));
    const dash = await request({ path: '/dashboard' });
    assert.equal(dash.body.includes(HEALTH), false);
    const noshow = await request({ method: 'POST', path: '/admin/games/g_next/attendance', headers: { 'x-admin-token': KEY }, form: { playerId: 'p_ada', action: 'noshow' } });
    assert.equal(noshow.status, 303);
    assert.equal(rsvpOf('p_ada').declineReason, HEALTH);
    assert.equal(rsvpOf('p_ada').noShow, true);
    assert.equal(pointsOf('p_ada').total, before.total);
    rsvpOf('p_ada').noShow = false;
    store.save();
  });

  it('lets the owner edit a note after kickoff without reopening the RSVP', async () => {
    mark('p_ada', 'out', 'g_past');
    const html = await pageOf('token-ada');
    assert.match(html, /id="why-g_past"/);
    assert.match(html, /already started/);
    const saved = await postRsvp('token-ada', { gameId: 'g_past', status: 'out', note: '1', declineReason: NOTE });
    assert.equal(saved.status, 303);
    assert.equal(rsvpOf('p_ada', 'g_past').declineReason, NOTE);
    const locked = await postRsvp('token-ada', { gameId: 'g_past', status: 'in' });
    assert.match(decodeURIComponent(locked.headers.location), /already started/);
    assert.equal(rsvpOf('p_ada', 'g_past').status, 'out');
    assert.equal(rsvpOf('p_ada', 'g_past').declineReason, NOTE);
    const cleared = await postRsvp('token-ada', { gameId: 'g_past', status: 'out', note: '1', clearReason: '1' });
    assert.equal(cleared.status, 303);
    assert.equal(rsvpOf('p_ada', 'g_past').declineReason, null);
    const captain = await request({ path: '/admin/games/g_past', headers: { 'x-admin-token': KEY } });
    assert.match(captain.body, /No note/);
    assert.equal(captain.body.includes(NOTE), false);
  });

  it('does not copy an inbound email into the note, and an In email clears a stale note', async () => {
    const db = store.get();
    db.settings.autoRepliesOn = true;
    mark('p_ada', 'out');
    updateDeclineReason(rsvpOf('p_ada'), NOTE);
    store.save();
    const inbound = require('../lib/inbound');
    const injuries = db.injuries.length;
    await inbound.ingest(db, { from: 'Ada Llama <ada.llama@example.com>', subject: 'Re: Sunday', body: "I can't make it this week", messageId: '<out-note-test@local>' }, { source: 'test' });
    assert.equal(rsvpOf('p_ada').status, 'out');
    assert.equal(rsvpOf('p_ada').declineReason, NOTE);
    assert.equal(JSON.stringify(rsvpOf('p_ada').history).includes("can't make it"), false);
    assert.equal(db.injuries.length, injuries);
    await inbound.ingest(db, { from: 'ada.llama@example.com', subject: 'Re: Sunday', body: "I'm in", messageId: '<in-note-test@local>' }, { source: 'test' });
    assert.equal(rsvpOf('p_ada').status, 'in');
    assert.equal(rsvpOf('p_ada').declineReason, null);
    assert.equal(db.injuries.length, injuries);
    db.settings.autoRepliesOn = false;
    store.save();
  });

  it('still answers check-in when it is closed', async () => {
    const res = await postRsvp('token-ada', { gameId: 'g_next', status: 'in' });
    assert.equal(res.status, 303);
    const check = await request({ method: 'POST', path: '/p/token-ada/checkin', form: { gameId: 'g_next' } });
    assert.match(decodeURIComponent(check.headers.location), /Check-in is not open/);
  });
});
