// Measure: links every sent message to what the player did next.
const cfg = require('../config');
const MIN = 60000;

// For each sent message: did she respond (RSVP change, or check-in for check-in prompts)
// before the next message to her about the same game (or kickoff)? How fast?
function messageOutcomes(db) {
  const sent = (db.messages || []).filter((m) => m.status === 'sent' && !m.kind);
  const byKey = {};
  for (const m of sent) (byKey[m.playerId + '|' + m.gameId] ||= []).push(m);
  for (const k in byKey) byKey[k].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  const games = Object.fromEntries(db.games.map((g) => [g.id, g]));
  const rsvpIdx = {};
  for (const r of db.rsvps) rsvpIdx[r.playerId + '|' + r.gameId] = r;
  const out = [];
  for (const k in byKey) {
    const list = byKey[k];
    list.forEach((m, i) => {
      const g = games[m.gameId]; if (!g) return;
      const t0 = new Date(m.sentAt);
      const next = list[i + 1] ? new Date(list[i + 1].sentAt) : null;
      const step = cfg.automation.steps.find((s) => s.key === m.step) || {};
      let at = null;
      if (step.goal === 'checkin') {
        const c = db.checkins.find((c) => c.gameId === m.gameId && c.playerId === m.playerId);
        if (c && new Date(c.at) > t0 && new Date(c.at) - t0 < 72 * 60 * MIN) at = new Date(c.at);
      } else if (step.goal === 'rsvp') {
        const cutoff = Math.min(next ? next.getTime() : Infinity, new Date(g.startsAt).getTime());
        const r = rsvpIdx[k];
        const h = r && r.history.find((h) => new Date(h.at) > t0 && new Date(h.at) <= cutoff);
        if (h) at = new Date(h.at);
      }
      out.push({ msg: m, goal: step.goal, responded: !!at, minutes: at ? Math.round((at - t0) / MIN) : null });
    });
  }
  return out;
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : Math.round((s[h - 1] + s[h]) / 2); };

// Per step & variant: sends, replies, reply rate, median minutes to reply, winner.
function variantStats(db, outcomes = messageOutcomes(db)) {
  const ab = cfg.automation.abTest;
  const res = {};
  for (const step of cfg.automation.steps) {
    const vs = {};
    for (const v of ['A', 'B']) vs[v] = { sends: 0, replies: 0, minutes: [] };
    for (const o of outcomes) if (o.msg.step === step.key && vs[o.msg.variant]) {
      vs[o.msg.variant].sends++; if (o.responded) { vs[o.msg.variant].replies++; vs[o.msg.variant].minutes.push(o.minutes); }
    }
    for (const v in vs) { const x = vs[v]; x.rate = x.sends ? x.replies / x.sends : null; x.smoothed = (x.replies + 1) / (x.sends + 2); x.medianMinutes = median(x.minutes); delete x.minutes; }
    const ready = Object.values(vs).every((x) => x.sends >= ab.minSendsPerVariant);
    let winner = null;
    if (step.goal !== 'none' && ready) {
      const [a, b] = [vs.A.smoothed, vs.B.smoothed];
      if (Math.abs(a - b) >= ab.minLiftToCallWinner) winner = a > b ? 'A' : 'B';
    }
    res[step.key] = { step, variants: vs, ready, winner };
  }
  return res;
}

module.exports = { messageOutcomes, variantStats, median };
