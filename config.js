// Soccer Llamas — all tunable rules live here.
const config = {
  teamName: 'Soccer Llamas',
  timezone: 'America/Denver', // games are in Colorado; all times shown in MT
  port: Number(process.env.PORT) || 3000,
  // Starting captain (admin) key, used when the database is first seeded. Override with ADMIN_TOKEN.
  // After that the key lives in the database and the captain can reset it from Settings.
  adminToken: process.env.ADMIN_TOKEN || (process.env.DEMO === '1' ? 'demo-captain' : 'llama-admin-dev'),

  // Dedicated team Google account that will own the calendar events and send invites/email.
  // The captain owns this login (NOT anyone's personal account). Local mode never sends from it.
  teamAccount: {
    email: process.env.TEAM_GOOGLE_ACCOUNT || 'llamas.soccer.team@gmail.com',
    displayName: 'Soccer Llamas',
    calendarId: process.env.TEAM_CALENDAR_ID || 'primary', // calendar on the team account
  },

  roster: {
    minPlayers: 8,     // 8v8 — below this we're short
    comfyBuffer: 11,   // nice buffer for subs
  },

  checkin: {
    opensMinutesBefore: 60, // self check-in opens 1h before kickoff
    closesHoursAfter: 72,   // ...and closes 3 days after
  },

  defaultGameMinutes: 60,
  baseUrl: process.env.BASE_URL || 'http://localhost:3000', // used in links inside messages

  // ---------- Automatic messages (the weekly flow). Times are America/Denver.
  // day = days relative to game day (Sunday game: -6 = Monday), time = 'HH:MM'.
  // fromStart / fromEnd = minutes relative to kickoff / final whistle.
  // Copy (A/B variants) lives in messages.js.
  automation: {
    onByDefault: true,
    tickSeconds: 60,                       // scheduler checks once a minute
    quietHours: { start: '21:00', end: '08:00' }, // nothing is sent in this window
    weeklyCapPerPlayer: 6,                  // max messages per player in any 7 days
    abTest: { minSendsPerVariant: 10, explore: 0.1, minLiftToCallWinner: 0.05 },
    sendTimeLearning: { enabled: true, minEvents: 3, maxShiftHours: 2 },
    irCheckTime: '18:00', // 'Ready to come back?' goes out at this time the day after expected return
    steps: [
      { key: 'invite', label: 'Game-week invite', at: { day: -6, time: '18:00' }, audience: 'roster', goal: 'rsvp', learn: true, latest: 'kickoff' },
      { key: 'wedNudge', label: 'Wednesday nudge', at: { day: -4, time: '18:00' }, audience: 'nonResponders', goal: 'rsvp', learn: true, latest: 'thursdayDeadline' },
      { key: 'thuLastChance', label: 'Thursday last chance', at: { day: -3, time: '19:00' }, audience: 'nonRespondersAndMaybes', goal: 'rsvp', latest: 'thursdayDeadline' },
      { key: 'friAsk', label: 'Friday ask (Maybes, then subs)', at: { day: -2, time: '12:00' }, when: 'belowComfy', audience: 'maybesThenSubs', goal: 'rsvp', latest: 'kickoff', subsDelayMinutes: 60 },
      { key: 'satUrgent', label: 'Saturday urgent sub call', at: { day: -1, time: '10:00' }, when: 'belowMinimum', audience: 'notOut', goal: 'rsvp', latest: 'kickoff' },
      { key: 'keeperAlert', label: 'Keeper alert', at: { day: -1, time: '10:05' }, when: 'noKeeper', audience: 'notOut', goal: 'rsvp', latest: 'kickoff' },
      { key: 'gameDay', label: 'Game-day reminder', at: { fromStart: -120 }, audience: 'ins', goal: 'none', latest: 'kickoff' },
      { key: 'checkinPrompt', label: 'Check-in prompt', at: { fromEnd: 15 }, audience: 'insNotCheckedIn', goal: 'checkin', expiresHours: 24 },
      { key: 'recap', label: 'Monday recap', at: { day: 1, time: '10:00' }, audience: 'recap', goal: 'none', learn: true, expiresHours: 30 },
    ],
  },

  // ---------- Inbound replies to the team inbox (auto-handled, no approvals)
  inbound: {
    mode: process.env.INBOUND_MODE || 'local-fixtures', // 'gmail-api' in production (polls the team account)
    fixturesDir: 'fixtures/inbox',                       // local: drop .json emails here
    pollSeconds: 120,
    maxRepliesPerThreadPerDay: 1,
    captainEmail: process.env.CAPTAIN_EMAIL || 'captain@example.com', // FYI digests go here (editable in Settings)
    fyiDigestTime: '19:30',                              // daily FYI digest to the captain (MT)
    pauseDays: 14,                                       // "too many emails" -> pause this long
    abMinSends: 8,                                       // reply copy A/B: even split until this many each
    llm: {                                               // OPTIONAL classifier; rules are always the fallback
      enabled: process.env.LLAMAS_LLM === '1',
      endpoint: process.env.LLM_ENDPOINT || 'https://api.openai.com/v1/chat/completions',
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      apiKeyEnv: 'LLM_API_KEY',
      timeoutMs: 8000,
    },
  },

  channels: {
    email: { enabled: true, mode: 'local-outbox', outboxFile: process.env.OUTBOX_FILE || 'data/outbox.log' }, // mode 'gmail-api' = future real sending
    sms: { enabled: false, provider: 'twilio', from: '+1XXXXXXXXXX' }, // pluggable, OFF; see README for cost
  },

  pinnies: {
    holders: 2,       // how many top point-earners hold spares (set 3 if you like)
    sparesEach: 2,
  },

  leaderboardSize: 5, // public top-N; we never rank the bottom

  // Llama Points. Edit values here; everything is recomputed from raw data.
  points: {
    rsvpByThursday:   { pts: 3,  label: 'RSVP by Thursday 11:59 pm' },
    rsvpSaturday:     { pts: 1,  label: 'RSVP the day before' },
    showedUp:         { pts: 2,  label: 'Said In and showed up' },
    noShow:           { pts: -3, label: "Said In, no-show, didn't tell anyone" },
    subOrKeeper:      { pts: 5,  label: 'Subbed / kept goal when we were short' },
    feesOnTime:       { pts: 5,  label: 'Paid fees within a week' },
    feesAfterReminder:{ pts: 2,  label: 'Paid fees after a reminder' },
    playerCardEarly:  { pts: 5,  label: 'Got player card before being asked' },
    referral:         { pts: 10, label: 'Brought in a new player' },
    gameDayHelp:      { pts: 2,  label: 'Game-day help (pinnies, nets, game card)' },
  },
  // Which first responses count toward the early-RSVP bonus ("maybe" doesn't help planning).
  rsvpBonusStatuses: ['in', 'out'],
  feeOnTimeDays: 7,
};

// ---------- DEMO MODE (DEMO=1): public click-around demo with made-up players.
// Hard-disables every outbound path no matter what the settings above say.
config.demo = process.env.DEMO === '1';
if (config.demo) {
  config.channels.email.mode = 'local-outbox';  // only the local Outbox file
  config.channels.sms.enabled = false;
  config.inbound.mode = 'local-fixtures';       // never polls Gmail
  config.inbound.llm.enabled = false;           // no external AI calls
  config.checkin.opensMinutesBefore = 7 * 24 * 60; // let visitors try "I'm here" anytime in the game week
  config.demoResetTime = process.env.DEMO_RESET_TIME || '03:00'; // nightly reset (America/Denver)
}
module.exports = config;
