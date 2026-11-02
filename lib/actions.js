const { id } = require('./store');
function setRsvp(db, playerId, gameId, status, at = new Date().toISOString(), source = 'app') {
  let r = db.rsvps.find((x) => x.gameId === gameId && x.playerId === playerId);
  if (!r) { r = { id: id('r'), playerId, gameId, status, firstAt: at, updatedAt: at, history: [], noShow: false, toldTeam: false }; db.rsvps.push(r); }
  r.status = status; r.updatedAt = at; r.history.push({ status, at, source });
  if (status !== 'in') { r.noShow = false; }
  return r;
}
function checkIn(db, playerId, gameId, at = new Date().toISOString(), by = 'self') {
  if (db.checkins.find((c) => c.gameId === gameId && c.playerId === playerId)) return;
  db.checkins.push({ id: id('c'), playerId, gameId, at, by });
  const r = db.rsvps.find((x) => x.gameId === gameId && x.playerId === playerId);
  if (r) r.noShow = false;
}
module.exports = { setRsvp, checkIn };
