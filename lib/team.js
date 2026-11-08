// Domain helpers shared by pages, the calendar stub and the API.
const cfg = require('../config');

const gameEnd = (g) => new Date(new Date(g.startsAt).getTime() + (g.durationMin || cfg.defaultGameMinutes) * 60000);
const sortedGames = (db) => [...db.games].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
const upcomingGames = (db, now = new Date()) => sortedGames(db).filter((g) => !g.cancelled && gameEnd(g) > now);
const pastGames = (db, now = new Date()) => sortedGames(db).filter((g) => gameEnd(g) <= now).reverse();
const nextGame = (db, now) => upcomingGames(db, now)[0] || null;
const activePlayers = (db) => db.players.filter((p) => p.active !== false).sort((a, b) => a.name.localeCompare(b.name));
const rsvpFor = (db, gameId, playerId) => db.rsvps.find((r) => r.gameId === gameId && r.playerId === playerId);
const checkinFor = (db, gameId, playerId) => db.checkins.find((c) => c.gameId === gameId && c.playerId === playerId);

function headcount(db, game) {
  const res = { in: [], maybe: [], out: [], none: [] };
  for (const p of activePlayers(db)) {
    const r = rsvpFor(db, game.id, p.id);
    if (!r && p.role === 'sub') continue; // subs only show up once they answer
    res[r ? r.status : 'none'].push(p);
  }
  const n = res.in.length;
  let level, message;
  if (n < cfg.roster.minPlayers) { level = 'short'; message = `Short ${cfg.roster.minPlayers - n} for ${cfg.roster.minPlayers}v${cfg.roster.minPlayers} — call in subs!`; }
  else if (n < cfg.roster.comfyBuffer) { level = 'ok'; message = `We can play! ${cfg.roster.comfyBuffer - n} more for a comfy bench of ${cfg.roster.comfyBuffer}.`; }
  else { level = 'comfy'; message = `Comfy bench — ${n} llamas in.`; }
  const keepers = res.in.filter((p) => p.canKeep);
  const maybeKeepers = res.maybe.filter((p) => p.canKeep);
  return { ...res, level, message, keepers, maybeKeepers };
}

function checkinOpen(game, now = new Date()) {
  const s = new Date(game.startsAt).getTime();
  return !game.cancelled && now.getTime() >= s - cfg.checkin.opensMinutesBefore * 60000 && now.getTime() <= gameEnd(game).getTime() + cfg.checkin.closesHoursAfter * 3600000;
}

// Who keeps the pinnies does not depend on points or on db.pinnies.holders.
function pinnieStatus() {
  return { custody: cfg.pinnies.custody };
}

const activeInjuries = (db) => db.injuries.filter((i) => !i.cleared);
const roster = (db) => activePlayers(db).filter((p) => p.role !== 'sub');
const subs = (db) => activePlayers(db).filter((p) => p.role === 'sub');
// Injured at a moment in time (dates are MT calendar days)
function isInjuredAt(db, playerId, at) {
  const day = require('./time').toLocalInputs(at).date;
  return db.injuries.some((i) => i.playerId === playerId && i.dateInjured <= day && (!i.cleared || (i.clearedAt && new Date(i.clearedAt) > new Date(at))));
}
const isPausedAt = (p, at) => !!(p.pausedUntil && new Date(p.pausedUntil) > new Date(at) && (!p.pausedAt || new Date(p.pausedAt) <= new Date(at)));

module.exports = { gameEnd, sortedGames, upcomingGames, pastGames, nextGame, activePlayers, rsvpFor, checkinFor, headcount, checkinOpen, pinnieStatus, activeInjuries, roster, subs, isInjuredAt, isPausedAt };
