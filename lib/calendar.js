// Google Calendar sync — STUB. No network calls are made here.
//
// Model: one Calendar event per game, every active player is an attendee.
// The invite's own response <-> the app's RSVP:
//   In  <-> accepted     Out <-> declined     Maybe <-> tentative     (no reply) <-> needsAction
//
// Events are owned by the dedicated team Google account (config.teamAccount), never a personal one.
// For now planSync() only builds Calendar API v3 event payloads and writes them to
// data/calendar-plan.json. A future assistant can implement applyPlan() with googleapis:
//   events.insert / events.patch on the team calendar (sendUpdates: 'all'), storing
//   game.calendarEventId; then pullResponses() reads attendees[].responseStatus and calls
//   googleToRsvp() to update RSVPs (newest change wins, compare timestamps).
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const { localIso, fmtGame } = require('./time');
const { gameEnd, sortedGames, activePlayers, rsvpFor } = require('./team');

const PLAN_FILE = path.join(path.dirname(require('./store').FILE), 'calendar-plan.json');

const RSVP_TO_GOOGLE = { in: 'accepted', out: 'declined', maybe: 'tentative' };
const GOOGLE_TO_RSVP = { accepted: 'in', declined: 'out', tentative: 'maybe', needsAction: null };
const rsvpToGoogle = (status) => RSVP_TO_GOOGLE[status] || 'needsAction';
const googleToRsvp = (responseStatus) => GOOGLE_TO_RSVP[responseStatus] ?? null;

function buildEventPayload(db, game, baseUrl = 'http://localhost:' + cfg.port) {
  const attendees = activePlayers(db).map((p) => {
    const r = rsvpFor(db, game.id, p.id);
    return { email: p.email, displayName: p.name, responseStatus: rsvpToGoogle(r && r.status) };
  });
  return {
    gameId: game.id,
    calendarEventId: game.calendarEventId || null, // null => would be events.insert, else events.patch
    action: game.cancelled ? 'cancel' : (game.calendarEventId ? 'patch' : 'insert'),
    calendarId: cfg.teamAccount.calendarId,
    sendUpdates: 'all',
    event: {
      organizer: { email: cfg.teamAccount.email, displayName: cfg.teamAccount.displayName },
      summary: `⚽ ${cfg.teamName} game${game.opponent ? ' vs ' + game.opponent : ''}`,
      location: [game.location, game.address].filter(Boolean).join(', '),
      description: `RSVP right here (Yes = In, No = Out, Maybe = Maybe) or on your Llamas page.\n${game.notes || ''}\nDashboard: ${baseUrl}/`.trim(),
      start: { dateTime: localIso(game.startsAt), timeZone: cfg.timezone },
      end: { dateTime: localIso(gameEnd(game)), timeZone: cfg.timezone },
      attendees,
      guestsCanSeeOtherGuests: true,
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 24 * 60 }, { method: 'popup', minutes: 90 }] },
      extendedProperties: { private: { llamasGameId: game.id } },
      status: game.cancelled ? 'cancelled' : 'confirmed',
    },
    humanTime: fmtGame(game.startsAt),
  };
}

function planSync(db, { now = new Date(), includePast = false } = {}) {
  const games = sortedGames(db).filter((g) => includePast || gameEnd(g) > now);
  const plan = { generatedAt: now.toISOString(), timezone: cfg.timezone, organizerAccount: cfg.teamAccount.email, calendarId: cfg.teamAccount.calendarId, dryRun: true, note: 'Stub only — no Google Calendar API calls were made.', events: games.map((g) => buildEventPayload(db, g)) };
  fs.mkdirSync(path.dirname(PLAN_FILE), { recursive: true });
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
  return plan;
}

// Apply responses pulled from Google back onto RSVPs. Pure function over db; caller saves.
// responses: [{ gameId, email, responseStatus, at }]
function applyGoogleResponses(db, responses, setRsvp) {
  let changed = 0;
  for (const r of responses) {
    const p = db.players.find((x) => x.email && x.email.toLowerCase() === String(r.email).toLowerCase());
    const status = googleToRsvp(r.responseStatus);
    if (!p || !status) continue;
    const cur = rsvpFor(db, r.gameId, p.id);
    if (cur && cur.status === status) continue;
    if (cur && r.at && new Date(cur.updatedAt) > new Date(r.at)) continue; // app change is newer
    setRsvp(p.id, r.gameId, status, r.at || new Date().toISOString(), 'google');
    changed++;
  }
  return changed;
}

async function applyPlan() { if (cfg.demo) throw new Error('DEMO mode: Google Calendar is disabled.'); throw new Error('Not implemented: Google Calendar sync is a stub. See lib/calendar.js header.'); }

module.exports = { PLAN_FILE, rsvpToGoogle, googleToRsvp, buildEventPayload, planSync, applyGoogleResponses, applyPlan };
