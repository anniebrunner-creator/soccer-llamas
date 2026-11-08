// Pinnie custody stays with Amber/Kat. Points, stored holder ids, and the old
// "hand them to the leaderboard" action must not award custody. Next-season fee
// coverage is not implemented as a prize.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llamas-pinnies-'));
process.env.LLAMAS_DB = path.join(tmp, 'db.json');
process.env.OUTBOX_FILE = path.join(tmp, 'outbox.log');
process.env.NO_SCHEDULER = '1';
process.env.ADMIN_TOKEN = 'test-captain-key';
delete process.env.DEMO;

const store = require('../lib/store');
const cfg = require('../config');
const { pinnieStatus } = require('../lib/team');
const { render } = require('../lib/automation');
const { computePoints } = require('../lib/points');

const KEY = 'test-captain-key';
const CUSTODY = 'Amber/Kat keep team pinnies.';

function buildDb() {
  const db = store.empty();
  db.settings = { captainName: 'Test Captain', adminToken: KEY, automationsOn: false, autoRepliesOn: false };
  db.players = [
    { id: 'p_leader', name: 'Point Leader', email: 'leader@example.com', phone: '', channel: 'email', token: 'token-leader', role: 'roster', canKeep: false, active: true, pausedUntil: null, joinedAt: '2026-08-15', card: { status: 'missing', date: null } },
    { id: 'p_tess', name: 'Teammate Tess', email: 'tess@example.com', phone: '', channel: 'email', token: 'token-tess', role: 'roster', canKeep: false, active: true, pausedUntil: null, joinedAt: '2026-08-15', card: { status: 'missing', date: null } },
  ];
  db.games = [{ id: 'g_next', startsAt: '2027-06-06T17:00:00.000Z', durationMin: 60, location: 'Stenger', address: '1 Field St', opponent: '', notes: '', cancelled: false, calendarEventId: null, gameCardBy: null, result: null }];
  db.awards = [{ id: 'a1', playerId: 'p_leader', type: 'referral', date: '2026-11-01T18:00:00.000Z', note: 'Brought a friend', gameId: null }];
  db.pinnies = { holders: ['p_leader'], recordedAt: '2026-11-01T18:00:00.000Z', note: 'Handed to the leaderboard top' };
  store.set(db);
  return db;
}
const db = buildDb();
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
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

function cardAfter(html, marker) {
  const i = html.indexOf(marker);
  assert.notEqual(i, -1, `missing ${marker}`);
  return html.slice(i, html.indexOf('</div>', i));
}

describe('pinnie custody', { concurrency: 1 }, () => {
  before(async () => { server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); });
  after(async () => { if (server) await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); });

  it('keeps custody with Amber/Kat even when a points leader is stored as the holder', () => {
    assert.equal(cfg.pinnies.custody, CUSTODY);
    assert.equal(pinnieStatus(store.get()).custody, CUSTODY);
    assert.equal(JSON.stringify(pinnieStatus(store.get())).includes('Point Leader'), false);
    assert.equal(computePoints(store.get()).p_leader.total, 10);
    const game = store.get().games[0];
    const tess = store.get().players[1];
    for (const variant of ['A', 'B']) {
      const msg = render(db, { id: 'm1', step: 'gameDay', variant }, game, tess, new Date('2026-11-08T18:00:00.000Z'));
      assert.match(msg.body, /Amber\/Kat keep team pinnies\./);
      assert.equal(msg.body.includes('Point Leader'), false);
      assert.equal(msg.body.includes('point-earner'), false);
    }
  });

  it('describes custody on the team page, captain page, and tour, and does not hand pinnies out from points', async () => {
    const dash = await request({ path: '/dashboard' });
    assert.equal(dash.status, 200);
    const pin = cardAfter(dash.body, 'Spare pinnies');
    assert.match(pin, /Amber\/Kat keep team pinnies\./);
    assert.equal(pin.includes('Point Leader'), false);
    assert.equal(dash.body.includes('point-earner'), false);
    assert.equal(dash.body.includes('Next handoff'), false);
    assert.equal(dash.body.includes('fee coverage'), false);

    const tour = await request({ path: '/demo' });
    assert.match(tour.body, /Amber\/Kat keep team pinnies\./);

    const captain = await request({ path: '/admin/pinnies', headers: { 'x-admin-token': KEY } });
    assert.equal(captain.status, 200);
    assert.match(captain.body, /Amber\/Kat keep team pinnies\./);
    assert.equal(captain.body.includes('Point Leader'), false);
    assert.equal(captain.body.includes('leaderboard'), false);
    assert.equal(captain.body.includes('handed over'), false);
    assert.equal(captain.body.includes('fee coverage'), false);

    const home = await request({ path: '/admin', headers: { 'x-admin-token': KEY } });
    assert.equal(home.body.includes('Hand the spare pinnies'), false);
    assert.match(home.body, /Amber\/Kat keep them/);

    const before = store.get().pinnies.holders.slice();
    const posted = await request({ method: 'POST', path: '/admin/pinnies', headers: { 'x-admin-token': KEY }, form: { mode: 'top', holders: 'p_tess' } });
    assert.equal(posted.status, 404);
    assert.deepEqual(store.get().pinnies.holders, before);

    const points = await request({ path: '/admin/points', headers: { 'x-admin-token': KEY } });
    assert.equal(points.status, 200);
    assert.match(points.body, /Point Leader/);
    assert.equal(points.body.includes('fee coverage'), false);
    assert.equal(points.body.includes('fees are covered'), false);
  });
});
