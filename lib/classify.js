// Reply classifier: rules first (always available, safe), optional LLM behind a flag.
const cfg = require('../config');
const T = require('./time');

const INTENTS = ['in', 'out', 'maybe', 'injury', 'conflict', 'late', 'friend', 'question', 'pause', 'other'];

// Strip quoted history / signatures so we classify only what she wrote.
function cleanBody(body) {
  const lines = String(body || '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^On .+wrote:\s*$/i.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^From: .+/i.test(l) && out.length) break;
    if (/^--\s*$/.test(l) || /^Sent from my (iPhone|Android|phone)/i.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

const PART = '(ankle|knee|hamstring|calf|groin|achilles|shoulder|wrist|back|hip|foot|toe|quad|acl|mcl|meniscus|elbow|neck|ribs?|hand|finger|hammy|concussion)';
const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, couple: 2, 'couple of': 2, few: 3 };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function addDaysStr(base, n) { const [y, m, d] = base.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }
function parseReturn(text, today) {
  let m = text.match(/\b(?:out|back|off|sidelined|resting|rest)\b[^.!?\n]{0,30}?\b(\d+|an?|one|two|three|four|five|six|eight|couple(?: of)?|few)\s+(day|week|month)s?/i)
    || text.match(/\b(\d+|an?|one|two|three|four|five|six|eight|couple(?: of)?|few)\s+(day|week|month)s?\b[^.!?\n]{0,20}\b(?:out|off|recovery|to heal)/i);
  if (m) { const n = isNaN(m[1]) ? NUM[m[1].toLowerCase()] || 1 : Number(m[1]); const unit = m[2].toLowerCase(); return addDaysStr(today, n * (unit === 'day' ? 1 : unit === 'week' ? 7 : 30)); }
  m = text.match(/\b(?:back|return|returning|cleared|until|by|ready)\b[^.!?\n]{0,25}?\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})/i);
  if (m) { const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1; let y = Number(today.slice(0, 4)); const s = (yy) => `${yy}-${String(mo).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; if (s(y) < today) y++; return s(y); }
  m = text.match(/\b(?:back|return|cleared|until|by)\b[^.!?\n]{0,15}?\b(\d{1,2})\/(\d{1,2})\b/i);
  if (m) { let y = Number(today.slice(0, 4)); const s = (yy) => `${yy}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; if (s(y) < today) y++; return s(y); }
  return null;
}
function parseInjury(text) {
  let m = text.match(new RegExp(`\\b(sprain(?:ed)?|twist(?:ed)?|tweak(?:ed)?|pull(?:ed)?|hurt|injur(?:ed)?|tore|torn|broke(?:n)?|bruised|strain(?:ed)?|rolled|jammed)\\s+(?:my\\s+|a\\s+)?((?:left|right)\\s+)?${PART}`, 'i'));
  if (m) return { text: `${m[1].toLowerCase()} ${(m[2] || '').toLowerCase()}${m[3].toLowerCase()}`.replace(/\s+/g, ' '), part: m[3].toLowerCase() };
  m = text.match(new RegExp(`\\b(?:my\\s+)?((?:left|right)\\s+)?${PART}\\b[^.!?\\n]{0,20}\\b(sprain|strain|injur|hurt|tear|swollen|sore|is killing)`, 'i'));
  if (m) return { text: `${(m[1] || '').toLowerCase()}${m[2].toLowerCase()} injury`, part: m[2].toLowerCase() };
  m = text.match(new RegExp(`\\b${PART}\\b`, 'i'));
  if (m) return { text: `${m[1].toLowerCase()} injury`, part: m[1].toLowerCase() };
  return { text: '', part: null };
}
function parseFriend(text) {
  const m = text.match(/\b(?:friend|coworker|co-worker|sister|neighbou?r|roommate|cousin)\s+(?:named\s+|called\s+)?([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/) || text.match(/\bher name is ([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/) || text.match(/\b([A-Z][a-z]+) (?:wants|would love|could|can) (?:to )?(?:play|sub|join)/);
  const bad = ['She', 'Her', 'And', 'But', 'Also', 'Sunday', 'Can', 'I'];
  return m && !bad.includes(m[1]) ? m[1] : null;
}
function findGame(text, games, now) {
  const upcoming = games.filter((g) => !g.cancelled && new Date(g.startsAt) > now).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  for (const g of upcoming) {
    const p = T.parts(new Date(g.startsAt)); const mon = MONTHS[p.month - 1];
    const re = new RegExp(`\\b(${mon}[a-z]*\\.?\\s+${p.day}(st|nd|rd|th)?\\b|${p.month}/${p.day}\\b)`, 'i');
    if (re.test(text)) return g;
  }
  if (/\bnext (week|sunday)\b/i.test(text) && upcoming[1]) return upcoming[1];
  return upcoming[0] || null;
}

function classifyRules(subject, body, { games = [], now = new Date() } = {}) {
  const text = cleanBody(body);
  const all = `${String(subject || '').replace(/^(re|fwd?):\s*/gi, '')}\n${text}`;
  const t = text.toLowerCase();
  const has = (re) => re.test(t);
  const today = T.toLocalInputs(now).date;
  const f = {
    pause: has(/\b(unsubscribe|stop (sending|emailing|messaging)|take me off|too many (e-?mails|messages|texts)|pause (the |my )?(messages|emails)|less emails|fewer emails)\b/),
    injury: has(new RegExp(`\\b(injur|hurt|sprain|strain|torn\\b|tore\\b|pulled|broke|fracture|concussion|surgery|physical therap|on crutches|${PART.slice(1, -1)})`)) && !has(/\b(not|isn'?t|wasn'?t) (hurt|injured)\b/),
    sick: has(/\b(sick|flu|a cold|covid|fever|migraine|stomach bug|throwing up|under the weather)\b/),
    family: has(/\b(family|kid'?s?|daughter|son'?s|son\b|wedding|funeral|birthday|out of town|travel(l)?ing|vacation|work(ing)? (that|this|sunday)|on call|my shift|in-laws|babysit)\b/),
    late: has(/\b(running late|be late|bit late|little late|few (minutes|min) late|late\b.*\b(sunday|kickoff|game)|after kickoff|traffic)\b/),
    friend: has(/\b(bring(ing)?|brings) (a |my )?(friend|coworker|co-worker|sister|neighbou?r|roommate|cousin|sub)\b|\bfriend (who|that)? ?(wants|would like|could|can|is looking)\b|\b(wants|would love) to (sub|join|play)\b|\bher name is\b/),
    in: has(/\b(i'?m in\b|count me in|i'?ll be there|see you (sunday|there)|i can (make it|play|come)|yes\b|yep\b|yeah\b|definitely in|in!)/),
    out: has(/\b(i'?m out\b|can'?t (make|come|play|do)|cannot (make|come|play)|won'?t (be able|make|be there)|not (able|going) to make|count me out|have to miss|will miss|gonna miss|i'?ll miss|no can do)\b/),
    maybe: has(/\b(maybe|not sure|might\b|tbd|possibly|depends|tentative|50\/50|fingers crossed)\b/),
    qTime: has(/\b(what time|when is|when'?s|kickoff|start time|what'?s the time)\b/) && t.includes('?') || has(/\bwhat time\b/),
    qLocation: has(/\b(where|which field|what field|address|which park|location|parking|directions)\b/) && t.includes('?'),
    qFees: has(/\b(fees?|dues|owe|pay(ment)?|paid|venmo|zelle|how much|charged|refund|money|reminder about)\b/),
    sensitive: has(/\b(already paid|charged twice|double charged|refund|unfair|not fair|upset|angry|furious|frustrat|disappointed|ridiculous|quit(ting)?|leaving the team|harass|uncomfortable|unsafe|rude|disrespect|complain)\b/) || (t.match(/[?!]{2,}/g) || []).length >= 1 && has(/\b(paid|fee|why)\b/),
  };
  const questions = [f.qTime && 'time', f.qLocation && 'location', f.qFees && 'fees'].filter(Boolean);
  let primary, rsvp = null;
  if (f.pause) primary = 'pause';
  else if (f.injury && !f.in) { primary = 'injury'; rsvp = 'out'; }
  else if ((f.sick || f.family) && (f.out || !f.in && !f.maybe)) { primary = 'conflict'; rsvp = 'out'; }
  else if (f.late && !f.out) { primary = 'late'; rsvp = 'in'; }
  else if (f.out) { primary = 'out'; rsvp = 'out'; }
  else if (f.maybe) { primary = 'maybe'; rsvp = 'maybe'; }
  else if (f.in) { primary = 'in'; rsvp = 'in'; }
  else if (f.friend) primary = 'friend';
  else if (questions.length) primary = 'question';
  else primary = 'other';
  const game = findGame(all, games, now);
  const inj = f.injury ? parseInjury(text) : { text: '', part: null };
  return {
    method: 'rules', intent: primary, rsvp, gameId: game ? game.id : null,
    flags: { friend: f.friend, late: f.late && primary !== 'late', sick: f.sick, family: f.family },
    injury: primary === 'injury' ? { text: inj.text, part: inj.part, expectedReturn: parseReturn(text, today), dateInjured: today } : null,
    friendName: f.friend ? parseFriend(text) : null,
    questions, sensitive: f.sensitive, cleaned: text,
    confidence: primary === 'other' ? 0.3 : 0.8,
  };
}

// Optional LLM pass (off by default). Any error, timeout or invalid output -> rules result.
async function classify(subject, body, ctx = {}) {
  const rules = classifyRules(subject, body, ctx);
  const L = cfg.inbound.llm; const key = process.env[L.apiKeyEnv];
  if (cfg.demo || !L.enabled || !key) return rules;
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), L.timeoutMs);
    const prompt = `Classify a soccer team member's email reply. Return JSON only: {"intent": one of ${JSON.stringify(INTENTS)}, "rsvp": "in"|"out"|"maybe"|null, "injury_text": string|null, "expected_return": "YYYY-MM-DD"|null, "friend_name": string|null, "questions": subset of ["time","location","fees"], "sensitive": boolean}. Today is ${T.toLocalInputs(ctx.now || new Date()).date}.\n\nSubject: ${subject}\n\n${rules.cleaned.slice(0, 2000)}`;
    const r = await fetch(L.endpoint, { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: L.model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }) });
    clearTimeout(to);
    const j = JSON.parse((await r.json()).choices[0].message.content);
    if (!INTENTS.includes(j.intent)) return rules;
    const ok = (v, list) => (list.includes(v) ? v : null);
    return { ...rules, method: 'llm', intent: j.intent, rsvp: ok(j.rsvp, ['in', 'out', 'maybe']) ?? rules.rsvp,
      injury: j.intent === 'injury' ? { text: String(j.injury_text || rules.injury?.text || '').slice(0, 80), part: rules.injury?.part || null, expectedReturn: /^\d{4}-\d{2}-\d{2}$/.test(j.expected_return || '') ? j.expected_return : rules.injury?.expectedReturn || null, dateInjured: rules.injury?.dateInjured || T.toLocalInputs(new Date()).date } : null,
      friendName: j.friend_name ? String(j.friend_name).slice(0, 40) : rules.friendName,
      questions: Array.isArray(j.questions) ? j.questions.filter((q) => ['time', 'location', 'fees'].includes(q)) : rules.questions,
      sensitive: !!j.sensitive || rules.sensitive, // safety flags are OR'ed, never removed by the LLM
      confidence: 0.9 };
  } catch (e) { return { ...rules, llmError: e.message }; }
}

// Never auto-reply to these.
function shouldIgnore(email) {
  const h = Object.fromEntries(Object.entries(email.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const from = String(email.from || '').toLowerCase();
  if (from === cfg.teamAccount.email.toLowerCase()) return 'sent by the team account (loop protection)';
  if (/(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?)@|@(.*\.)?(noreply|mailer)\./.test(from) || /^(no-?reply|mailer-daemon|postmaster)/.test(from)) return 'no-reply / system sender';
  if (h['auto-submitted'] && h['auto-submitted'] !== 'no') return 'auto-generated (Auto-Submitted header)';
  if (h['x-autoreply'] || h['x-autorespond'] || h['x-auto-response-suppress']) return 'auto-reply header';
  if (/^(bulk|list|junk)$/i.test(h['precedence'] || '')) return 'bulk / mailing list';
  if (h['list-id'] || h['list-unsubscribe']) return 'mailing list';
  if (/\b(out of (the )?office|automatic reply|auto-?reply|autoreply|away from (my )?(e-?mail|desk)|vacation (reply|responder))\b/i.test(email.subject || '')) return 'out-of-office / auto-reply';
  return null;
}

module.exports = { classify, classifyRules, shouldIgnore, cleanBody, parseReturn, parseInjury, INTENTS };
