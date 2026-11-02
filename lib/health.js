// Team health: the Measure / Analyze / Control part of the loop.
const cfg = require('../config');
const T = require('./time');
const team = require('./team');
const { statusAt } = require('./points');
const { messageOutcomes, variantStats, median } = require('./analytics');

function gameStats(db, g) {
  const start = new Date(g.startsAt);
  const w = T.rsvpWindows(g.startsAt);
  const roster = team.roster(db).filter((p) => !team.isInjuredAt(db, p.id, start));
  let byThu = 0, responded = 0;
  for (const p of roster) {
    const r = team.rsvpFor(db, g.id, p.id);
    const hist = (r && r.history) || [];
    if (hist.some((h) => cfg.rsvpBonusStatuses.includes(h.status) && new Date(h.at) <= w.thursdayEnd)) byThu++;
    if (hist.some((h) => new Date(h.at) < start)) responded++;
  }
  const rs = db.rsvps.filter((r) => r.gameId === g.id);
  const saidIn = rs.filter((r) => statusAt(r, start) === 'in');
  const present = db.checkins.filter((c) => c.gameId === g.id).length;
  const showed = saidIn.filter((r) => team.checkinFor(db, g.id, r.playerId)).length;
  const noShows = saidIn.filter((r) => !team.checkinFor(db, g.id, r.playerId) && !r.toldTeam).length;
  return { game: g, rosterSize: roster.length, byThuRate: roster.length ? byThu / roster.length : null, responseRate: roster.length ? responded / roster.length : null, inAtKickoff: saidIn.length, present, showUpRate: saidIn.length ? showed / saidIn.length : null, noShowRate: saidIn.length ? noShows / saidIn.length : null, result: g.result };
}

// Individuals (XmR) control chart: limits = mean ± 2.66 × average moving range.
function controlChart(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const mr = values.slice(1).map((v, i) => Math.abs(v - values[i]));
  const mrBar = mr.reduce((a, b) => a + b, 0) / mr.length;
  const ucl = mean + 2.66 * mrBar, lcl = Math.max(0, mean - 2.66 * mrBar);
  return { mean, ucl, lcl, flags: values.map((v) => v > ucl || v < lcl) };
}

const pct = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
const avg = (a) => { const b = a.filter((x) => x != null); return b.length ? b.reduce((s, x) => s + x, 0) / b.length : null; };

function report(db, now = new Date()) {
  const past = team.pastGames(db, now).filter((g) => !g.cancelled).reverse(); // oldest first
  const games = past.map((g) => gameStats(db, g));
  const chart = controlChart(games.map((x) => x.present));
  const outcomes = messageOutcomes(db);
  const vstats = variantStats(db, outcomes);
  const totals = {
    byThuRate: avg(games.map((x) => x.byThuRate)), responseRate: avg(games.map((x) => x.responseRate)),
    avgIn: avg(games.map((x) => x.inAtKickoff)), avgPresent: avg(games.map((x) => x.present)),
    showUpRate: avg(games.map((x) => x.showUpRate)), noShowRate: avg(games.map((x) => x.noShowRate)),
    record: ['W', 'L', 'T'].map((k) => games.filter((x) => x.result && x.result.outcome === k).length),
  };
  // Send-hour analysis (when do replies come fastest?)
  const byHour = {};
  for (const o of outcomes) if (o.goal === 'rsvp') { const h = T.parts(new Date(o.msg.sentAt)).hour; const b = (byHour[h] ||= { sends: 0, replies: 0 }); b.sends++; if (o.responded) b.replies++; }
  return { games, chart, vstats, totals, byHour, working: whatsWorking(games, vstats, byHour, chart, db) };
}

function whatsWorking(games, vstats, byHour, chart, db) {
  const out = [];
  const nudges = Object.values(vstats).filter((v) => v.step.goal === 'rsvp' && v.variants.A.sends + v.variants.B.sends > 0);
  for (const v of nudges) {
    const { A, B } = v.variants;
    if (v.winner) {
      const w = v.variants[v.winner], l = v.variants[v.winner === 'A' ? 'B' : 'A'];
      out.push(`✅ ${v.step.label}: version ${v.winner} ("${require('../messages')[v.step.key][v.winner].subject.replace(/\{\w+\}/g, '…')}") gets ${pct(w.rate)} replies vs ${pct(l.rate)}. The app now sends it most of the time.`);
    } else if (A.sends + B.sends > 0) {
      const lead = (A.rate ?? 0) >= (B.rate ?? 0) ? 'A' : 'B';
      out.push(`🧪 ${v.step.label}: still testing (${A.sends}+${B.sends} sent, need ${cfg.automation.abTest.minSendsPerVariant} each). Version ${lead} is ahead so far.`);
    }
  }
  const hours = Object.entries(byHour).filter(([, b]) => b.sends >= 5).map(([h, b]) => ({ h: +h, rate: b.replies / b.sends }));
  if (hours.length > 1) {
    hours.sort((a, b) => b.rate - a.rate);
    const fmtH = (h) => `${((h + 11) % 12) + 1} ${h < 12 ? 'am' : 'pm'}`;
    out.push(`⏰ Messages sent around ${fmtH(hours[0].h)} get the most replies (${pct(hours[0].rate)}). Each player's nudges shift toward the time she usually answers.`);
  }
  if (games.length >= 4) {
    const half = Math.floor(games.length / 2);
    const a = avg(games.slice(0, half).map((x) => x.present)), b = avg(games.slice(half).map((x) => x.present));
    out.push(b >= a ? `📈 Attendance is ${b > a ? 'up' : 'steady'}: ${b.toFixed(1)} per game lately vs ${a.toFixed(1)} earlier.` : `📉 Attendance slipped: ${b.toFixed(1)} per game lately vs ${a.toFixed(1)} earlier. Biggest lever: fewer no-shows (see below).`);
    const ns = avg(games.slice(half).map((x) => x.noShowRate));
    if (ns != null && ns > 0.1) out.push(`⚠️ ${pct(ns)} of "In" players didn't show recently. The game-day reminder and the −3 no-show rule are aimed at this.`);
    const wins = games.filter((x) => x.result && x.result.outcome === 'W'), other = games.filter((x) => x.result && x.result.outcome !== 'W');
    if (wins.length && other.length) out.push(`⚽ We average ${avg(wins.map((x) => x.present)).toFixed(1)} players in wins vs ${avg(other.map((x) => x.present)).toFixed(1)} in ties/losses. More llamas means fresher legs.`);
  }
  if (chart) chart.flags.forEach((f, i) => { if (f) out.push(`🔎 ${T.fmtDay(games[i].game.startsAt)} was unusual (${games[i].present} players, outside the normal range). Worth asking what happened.`); });
  if (db.standings && db.standings.length >= 2) { const s = db.standings; const d = s[s.length - 1].place - s[0].place; out.push(d < 0 ? `🏆 We climbed ${-d} place${d === -1 ? '' : 's'} in the division (now #${s[s.length - 1].place} of ${s[s.length - 1].of}).` : d > 0 ? `🏔️ We dropped ${d} place${d === 1 ? '' : 's'} (now #${s[s.length - 1].place} of ${s[s.length - 1].of}). Goal: back to the middle or top.` : `➖ Division place unchanged (#${s[s.length - 1].place}).`); }
  return out;
}

// Inline SVG chart (no libraries)
function chartSvg(games, chart) {
  if (!chart) return '<p class="muted">Need at least 2 past games.</p>';
  const W = 360, Hh = 190, pl = 28, pr = 10, pt = 12, pb = 34;
  const vals = games.map((x) => x.present);
  const maxY = Math.max(14, Math.ceil(chart.ucl) + 1, ...vals);
  const x = (i) => pl + (games.length === 1 ? 0 : (i * (W - pl - pr)) / (games.length - 1));
  const y = (v) => pt + (1 - v / maxY) * (Hh - pt - pb);
  const line = (v, color, dash, label) => `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="${color}" stroke-width="1.5" ${dash ? 'stroke-dasharray="5 4"' : ''}/><text x="${W - pr}" y="${y(v) - 3}" font-size="9" text-anchor="end" fill="${color}">${label}</text>`;
  let s = `<svg viewBox="0 0 ${W} ${Hh}" width="100%" role="img" aria-label="Attendance control chart" style="background:#fff;border-radius:12px">`;
  for (let v = 0; v <= maxY; v += 2) s += `<text x="${pl - 6}" y="${y(v) + 3}" font-size="9" text-anchor="end" fill="#999">${v}</text><line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="#f0ede4"/>`;
  s += `<rect x="${pl}" y="${y(cfg.roster.minPlayers)}" width="${W - pl - pr}" height="${y(0) - y(cfg.roster.minPlayers)}" fill="#ffe5e5" opacity=".55"/>`;
  s += line(chart.ucl, '#888', true, 'upper ' + chart.ucl.toFixed(1)) + line(chart.mean, '#1f9d55', false, 'avg ' + chart.mean.toFixed(1)) + line(chart.lcl, '#888', true, 'lower ' + chart.lcl.toFixed(1));
  s += `<polyline fill="none" stroke="#1d1b26" stroke-width="2" points="${vals.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>`;
  vals.forEach((v, i) => {
    const r = games[i].result; const c = chart.flags[i] ? '#d64545' : v < cfg.roster.minPlayers ? '#e8a317' : '#e4ff1a';
    s += `<circle cx="${x(i)}" cy="${y(v)}" r="6" fill="${c}" stroke="#1d1b26" stroke-width="1.5"/><text x="${x(i)}" y="${Hh - 20}" font-size="9" text-anchor="middle">${T.fmtDay(games[i].game.startsAt).replace(/^\w+, /, '')}</text><text x="${x(i)}" y="${Hh - 8}" font-size="10" font-weight="700" text-anchor="middle" fill="${r && r.outcome === 'W' ? '#1f9d55' : r && r.outcome === 'L' ? '#d64545' : '#666'}">${r && r.outcome ? r.outcome + ' ' + r.us + '-' + r.them : ''}</text>`;
  });
  return s + '</svg>';
}

module.exports = { report, gameStats, controlChart, chartSvg, pct };
