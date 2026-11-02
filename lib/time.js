const cfg = require('../config');
const TZ = cfg.timezone;

function parts(date, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday);
  return { year: +o.year, month: +o.month, day: +o.day, hour: +o.hour, minute: +o.minute, second: +o.second, dow: wd };
}

// Wall-clock time in tz -> UTC Date (handles DST).
function zonedToUtc(y, m, d, h = 0, mi = 0, s = 0, ms = 0, tz = TZ) {
  const target = Date.UTC(y, m - 1, d, h, mi, s, ms);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(guess), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, ms);
    guess += target - asUtc;
  }
  return new Date(guess);
}

function localDate(date) { const p = parts(new Date(date)); return { y: p.year, m: p.month, d: p.day, dow: p.dow }; }
function shiftDay({ y, m, d }, n) { const t = new Date(Date.UTC(y, m - 1, d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; }

// RSVP windows relative to a game (MT): Thursday-before deadline, and the "day before".
function rsvpWindows(startsAt) {
  const g = localDate(startsAt);
  const back = ((g.dow - 4 + 7) % 7) || 7; // days back to Thursday
  const thu = shiftDay(g, -back);
  const sat = shiftDay(g, -1);
  return {
    thursdayEnd: zonedToUtc(thu.y, thu.m, thu.d, 23, 59, 59, 999),
    dayBeforeStart: zonedToUtc(sat.y, sat.m, sat.d, 0, 0, 0),
    dayBeforeEnd: zonedToUtc(sat.y, sat.m, sat.d, 23, 59, 59, 999),
  };
}

const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });
const fmtDay = (d) => fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(d));
const fmtTime = (d) => fmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(d)) + ' MT';
const fmtGame = (d) => `${fmtDay(d)} · ${fmtTime(d)}`;
const fmtStamp = (d) => d ? fmt({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(d)) + ' MT' : '';
const fmtDate = (s) => { if (!s) return ''; const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }); };

// For <input type=date/time> values in MT
function toLocalInputs(d) {
  const p = parts(new Date(d)); const z = (n) => String(n).padStart(2, '0');
  return { date: `${p.year}-${z(p.month)}-${z(p.day)}`, time: `${z(p.hour)}:${z(p.minute)}` };
}
function fromLocalInputs(date, time) {
  const [y, m, d] = date.split('-').map(Number); const [h, mi] = (time || '00:00').split(':').map(Number);
  return zonedToUtc(y, m, d, h, mi);
}
// Local wall time ISO without offset, e.g. for Google Calendar with timeZone field
function localIso(d) { const p = parts(new Date(d)); const z = (n) => String(n).padStart(2, '0'); return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}:00`; }
function todayLocalStr() { return toLocalInputs(new Date()).date; }

function minuteOfDay(d) { const p = parts(new Date(d)); return p.hour * 60 + p.minute; }
function atLocalTime(dateObj, minutes) { const { y, m, d } = dateObj; return zonedToUtc(y, m, d, Math.floor(minutes / 60), minutes % 60); }
module.exports = { localDate, shiftDay, minuteOfDay, atLocalTime, TZ, parts, zonedToUtc, rsvpWindows, fmtDay, fmtTime, fmtGame, fmtStamp, fmtDate, toLocalInputs, fromLocalInputs, localIso, todayLocalStr };
