const { id } = require('./store');

// Optional note on an Out RSVP ("why I can't make it").
// Points, reminders, injury reserve, and outbound messages never read this field.
// A blank note is stored as null. Leaving Out (In or Maybe) clears it so a stale
// note cannot linger. History records status only — never the note text.
const DECLINE_REASON_MAX = 500;

function normalizeDeclineReason(raw) {
  if (raw == null) return { ok: true, value: null };
  const text = String(raw).replace(/\u0000/g, '').trim();
  if (!text) return { ok: true, value: null };
  if (text.length > DECLINE_REASON_MAX) return { ok: false, error: `Please keep that note under ${DECLINE_REASON_MAX} characters, or leave it blank.` };
  return { ok: true, value: text };
}

// Honest copy. Demo mode has no private captain login (the demo key is public),
// so the note must not be described as a private channel there.
function declinePrivacyCopy(demo) {
  const shared = 'Leaving this blank is completely fine and does not change your points, reminders, or injury reserve. Please don’t include health details.';
  if (demo) return `Demo only: a note you save can show on the captain attendance page. Anyone can open that page with the public demo captain key — it is not a private login. Everyone here is made up, so don’t type real information. ${shared}`;
  return `Shown on your page and the captain attendance page for this game. Other players and the public team page do not get this note. Anyone with the captain link can read it, so keep that link private. ${shared}`;
}

function clearDeclineReason(r) {
  if (!r) return;
  r.declineReason = null;
  r.declineReasonAt = null;
}

function setRsvp(db, playerId, gameId, status, at = new Date().toISOString(), source = 'app') {
  let r = db.rsvps.find((x) => x.gameId === gameId && x.playerId === playerId);
  if (!r) {
    r = { id: id('r'), playerId, gameId, status, firstAt: at, updatedAt: at, history: [], noShow: false, toldTeam: false, declineReason: null, declineReasonAt: null };
    db.rsvps.push(r);
  }
  r.status = status; r.updatedAt = at; r.history.push({ status, at, source });
  if (status !== 'in') { r.noShow = false; }
  if (status !== 'out') clearDeclineReason(r);
  return r;
}

// Edit or clear the note without a new RSVP history entry and without touching points fields.
function updateDeclineReason(rsvp, raw, at = new Date().toISOString()) {
  if (!rsvp || rsvp.status !== 'out') return { ok: false, error: 'You can add a note only when you’re marked Out.' };
  const norm = normalizeDeclineReason(raw);
  if (!norm.ok) return norm;
  rsvp.declineReason = norm.value;
  rsvp.declineReasonAt = norm.value ? at : null;
  return { ok: true, value: norm.value };
}
function checkIn(db, playerId, gameId, at = new Date().toISOString(), by = 'self') {
  if (db.checkins.find((c) => c.gameId === gameId && c.playerId === playerId)) return;
  db.checkins.push({ id: id('c'), playerId, gameId, at, by });
  const r = db.rsvps.find((x) => x.gameId === gameId && x.playerId === playerId);
  if (r) r.noShow = false;
}
module.exports = { setRsvp, checkIn, DECLINE_REASON_MAX, normalizeDeclineReason, declinePrivacyCopy, updateDeclineReason, clearDeclineReason };
