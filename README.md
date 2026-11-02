> **Deploy on Render:** see [DEPLOY.md](DEPLOY.md) — Web Service, Node, build `npm install`, start `npm start`, env `DEMO=1` (captain key `demo-captain`).

# 🦙⚽ Soccer Llamas — team app (local prototype)

A small, mobile-first web app for a women's adult soccer team: RSVPs, self check-in,
Llama Points, injury reserve, automatic weekly messages that learn what works, and a
Team health page. **Local prototype only:** nothing is emailed, texted or put on a calendar.
All players and history are fake sample data.

---

## Part 1 — Captain's guide (no tech needed)

**You need two things:** the **captain link** (your key to the captain pages) and the
login for the **team email account** (`llamas.soccer.team@gmail.com`).

**Your pages** (open the captain link, then tap the big buttons):

| Button | What it's for |
|---|---|
| **Home** | Next game at a glance, the **To-do** list, and the **Automatic messages ON/OFF** switch. |
| **Games** | Add or change a game. After a game: enter the **score** and fix **who came**. |
| **Players** | Copy a player's personal link to send her. Add a new player (and who brought her). |
| **Fees & cards** | Tap **Paid today** when money arrives. Set each player-card status. |
| **Give points** | For things only you see: subbing or keeping when we're short, game-day help, bringing a new player. |
| **Pinnies** | Shows who should hold the spare pinnies (the top 2). Tap the button after you hand them over. |
| **Injuries** | Injury reserve. Players usually add themselves. |
| **Team health** | How we're doing: answers by Thursday, players per game, no-shows, which messages work. |
| **Outbox** | Every automatic message, with the reason any were skipped. |
| **Calendar preview** | The calendar invites the app would send. |
| **Settings** | Change the captain's name. Make a new captain link when you hand over. |

**A normal week happens on its own.** The app sends the invite Monday evening, a nudge Wednesday,
a "last chance for +3" Thursday, asks Maybes and subs on Friday if we have fewer than 11,
sends an SOS Saturday if we have fewer than 8 (and a keeper alert if no keeper is in), a
game-day reminder with the map, a "tap to check in" after the game, and a Monday recap.
It never messages anyone who said Out, is on injury reserve, or has paused messages.
It sends nothing between 9 pm and 8 am, and no more than 6 messages per player per week.

**Your only regular job:** after each game, open **Home → To do**. Mark anyone who said In but
didn't come (✅ Came / ❌ No-show / Told us), and enter the score. Now and then, type our
division place on **Team health**.

**Handing the team to a new captain:**
1. **Settings** → type the new captain's name → **Save name**.
2. **Settings** → **Make a new captain link** → send it to the new captain. The old link stops working right away.
3. Give her the login for the team email account. That's all she needs.

**Replies answer themselves.** When a player replies to the team email, the app reads it, updates
her answer (In / Out / Maybe), puts her on injury reserve if she's hurt, pauses messages if she asks, notes a
friend she's bringing, answers questions about time, place and fees, and sends a short, kind reply. You
never have to approve anything. Once a day (7:30 pm) you get an **FYI email** listing anything upset, about money, or from
someone new, so a real person can follow up. Everything is listed on **Inbox**, which has its own ON/OFF switch.
When a friend actually plays, tap **She played: +10** on Inbox.

**Something wrong?** Flip **Automatic messages** to **OFF** on Home. Nothing gets sent until you turn it back on.

**Players** just bookmark their personal link: tap In / Maybe / Out, tap "I'm here" at the game,
put themselves on injury reserve, see their own points, and pause messages if they want.

---

## Part 2 — Technical setup

**Requirements:** Node.js 18+ (tested on 20). Dependencies: `express`, plus `playwright-core` for screenshots (dev only).

```bash
cd /workspace/llamas-app
npm install
npm run seed -- --force    # fake players + ~6 weeks of simulated history (~30 s). Prints all links.
npm start                  # http://localhost:3000 (binds 127.0.0.1); also starts the scheduler
npm run simulate           # practice run of the Oct 25 week on a COPY of the data -> data/simulation/
npm run screenshots        # phone-size PNGs into screenshots/ (uses /usr/bin/google-chrome)
```

- Captain link (default key): `http://localhost:3000/admin?key=llama-admin-dev`. Set `ADMIN_TOKEN` before the first seed, or reset it in Settings.
- Player links: `/p/<token>` (listed in `data/seed-output.txt` and on Captain → Players).
- Env: `PORT`, `INBOUND_MODE`, `CAPTAIN_EMAIL`, `LLAMAS_LLM`, `LLM_API_KEY`, `LLM_ENDPOINT`, `LLM_MODEL`, `ADMIN_TOKEN`, `BASE_URL` (used in message links), `TEAM_GOOGLE_ACCOUNT`, `TEAM_CALENDAR_ID`, `LLAMAS_DB`, `NO_SCHEDULER=1`.
- JSON API for an AI assistant: `GET /api/summary` with header `x-admin-token: <key>`.

### Layout
```
config.js            all rules: points, 8/11 thresholds, quiet hours, cap, cadence, A/B settings, channels, team account
messages.js          copy for every automatic message (A and B versions)
server.js            dashboard + player pages + one-tap links + pause page
routes/admin.js      captain pages     routes/api.js   JSON summary
lib/points.js        Llama Points, computed from raw data every time (nothing stored)
lib/automation.js    the weekly flow engine (audiences, skips, quiet hours, cap, A/B, send-time learning)
lib/scheduler.js     once-a-minute heartbeat + catch-up on restart
lib/analytics.js     links each message to the reply that followed (rate, time to reply)
lib/health.js        Team health metrics, XmR control chart, "What's working"
lib/calendar.js      Google Calendar stub: builds event payloads -> data/calendar-plan.json
lib/channels.js      email (local outbox) + SMS (Twilio, disabled)
lib/sim.js           fake player behavior for seeding history and practice runs
lib/inbound.js       team-inbox reply handling (match, apply, auto-reply, FYI digest)
lib/classify.js      rules classifier + optional LLM + ignore rules
fixtures/inbox/      example inbound emails (local mode)
data/db.json         the database (JSON, atomic writes)   data/outbox.log   local "sent" email log
```

### Llama Points (config.js → `points`)
RSVP (In or Out) by Thursday 11:59 pm MT before the game +3 · on the day before +1 · said In and checked in +2 ·
said In, no-show, didn't tell anyone −3 (only when the captain marks a no-show) · sub/keeper when short (captain) +5 ·
fees paid within 7 days, no reminder +5 · paid after a reminder +2 · player card before being asked +5 ·
brought a new player +10 · game-day help +2. The public board shows the top 5 with a score above 0. Nobody is ranked at the
bottom. Each player sees her own total and breakdown on her page. Spare pinnies go to the top `pinnies.holders` (2).
An RSVP counts by its first In/Out answer. In/Out "at kickoff" uses the answer as of game start.

### Automatic messages (the improvement loop)
- **Define:** the goal is more players at every game (≥ 8 to play, 11 for a comfy bench) and a climb back up the B division.
- **Measure:** every message is logged in `db.messages` (step, A/B variant, channel, planned and sent time, skip reason). RSVP history keeps every change with its time, source (page / email link / google) and message id. Check-ins are kept with their time.
- **Analyze:** Team health shows answered-by-Thursday rate, response rate, average said-In and present, show-up and no-show rates, reply rate and median reply time by message and variant, replies by send hour, results (W/L/T and score) next to attendance, and division standing. The weekly attendance **XmR control chart** (mean ± 2.66 × average moving range) flags unusual weeks.
- **Improve:** each nudge has A/B copy. Variants split evenly until each has `abTest.minSendsPerVariant` (10) sends. After that the better one (smoothed reply rate, needing a lift of at least 5 points to be called the winner) goes out about 90% of the time, with 10% still exploring. **Send-time learning:** for steps marked `learn`, a player's message moves toward the median time she usually answers, within ±2 h, never into quiet hours and never past the step's deadline.
- **Control:** the kill switch, quiet hours (21:00–08:00 MT; anything due in quiet hours waits until 08:00), a 6-per-7-days cap per player, a pause link in every message, and a re-check at send time. If she has answered, been injured, or we now have enough players, the message is skipped and the reason is logged.
- **Injury reserve:** injured players are skipped by every step. The day after her expected return date, she gets one "Ready to come back?" message (`irCheckTime`). Its link opens a confirm page, and a single button clears her.
- **Catch-up:** each step is stored in `db.jobRuns` once it runs, so it never runs twice. On startup the scheduler runs immediately. Any step whose time passed while the server was off still runs if it's inside its window (until kickoff or ~20 h). After that it's recorded as "missed". Queued messages past their `latestAt` are skipped.

### Inbound replies (lib/inbound.js, lib/classify.js)
- **Source:** locally, `fixtures/inbox/*.json` (polled every 2 min; 12 examples ship) plus the captain **Inbox → paste a test email** form. In production (`INBOUND_MODE=gmail-api`), `pollGmail()` would list unread mail on `llamas.soccer.team@gmail.com` via the Gmail API (OAuth) and reply in-thread. That part is a documented stub.
- **Pipeline:** dedupe by Message-ID → safety filter (never answer the team's own mail, no-reply/system senders, `Auto-Submitted`, `X-Autoreply`, `Precedence: bulk/list`, `List-Id`/`List-Unsubscribe`, or "out of office"/"automatic reply" subjects) → match the sender to a player by email (unknown → "want to join or sub?" reply + captain FYI) → classify → apply → reply.
- **Classifier:** rules first. Quoted text and signatures are stripped. Intents: in, out, maybe, injury (pulls out the injury and the expected return, e.g. "out 3 weeks", "back Nov 8", "11/8"), sick/family conflict, running late, bringing a friend (pending +10 referral; the captain confirms), question (time / location / fees, answered from data, including her own fee status), pause, other. An optional LLM pass (`LLAMAS_LLM=1`, `LLM_API_KEY`, OpenAI-compatible endpoint) is off by default. Any error, timeout or invalid output falls back to rules, and safety flags (sensitive) can only be added, never removed.
- **Updates applied automatically:** RSVP (history source `email-reply` with the inbound id), IR entry, pause (14 days), pending referral. Each one is logged on the inbound record next to the original email.
- **Replies:** warm, short, no guilt, from the team account. Out/conflict replies offer a one-tap "yes" for the next game. Maybe replies push for a yes by Thursday (+3). Injured players get a get-well note and IR confirmation. Copy and A/B variants are in `messages.js` → `replies`. Team health tracks whether a reply turned an Out/Maybe into an In later ("came around"), and the variant with the better conversion is favored after `inbound.abMinSends`.
- **Safety:** at most 1 auto-reply per thread per 24 h (later emails still update data). Quiet hours queue replies until 08:00 MT. The Inbox has its own kill switch (OFF = emails wait, untouched), and the global switch also exists. Sensitive or money emails still get a kind reply **and** go into the captain's daily FYI digest (an FYI, not an approval). Locally, every reply is written only to the Outbox.

### Channels
- **Email:** `channels.email.mode = 'local-outbox'` appends to `data/outbox.log` and marks the message sent. Real mode would send through the Gmail API as the team account (not implemented).
- **SMS (Twilio):** the interface is in place (`lib/channels.js`) but disabled. Rough cost: US SMS is about $0.008 per segment, plus carrier fees, about $1–2 per month for a number, and A2P 10DLC registration (a one-time brand/campaign fee of roughly $20, plus a few dollars a month). At ~15 players × 5 texts × 10 weeks, that's under $10 per season plus the fixed fees. Check Twilio's current pricing.

### Calendar (stub)
`lib/calendar.js` → `planSync(db)` writes one Google Calendar API v3 event per upcoming game to `data/calendar-plan.json`. Each event is organized by `config.teamAccount.email`, has every active player as an attendee, uses times with `timeZone: America/Denver`, and stores `extendedProperties.private.llamasGameId`. Mapping: In↔`accepted`, Out↔`declined`, Maybe↔`tentative`, none↔`needsAction`. `applyGoogleResponses()` maps invite replies back to RSVPs (the newer change wins). `applyPlan()` is where real `events.insert/patch` (with `sendUpdates: 'all'`) would go. It currently throws. No API calls are made.

### Limitations
- Not deployed anywhere. Email, SMS and Calendar are stubs. All people and history are fake. The scoring formula, sample results and standings are simulated.
- Personal links and the captain link are bearer secrets: anyone with the link can act as that person. Reset them from Captain → Players / Settings.
- One-tap email links record on a GET request. Some corporate email scanners "click" links, so a production version should use a confirm step or signed single-use links.
- JSON-file store: fine for one process and one team. Use SQLite or Postgres for real use. Run only **one** instance, or messages could go out twice.
- Check-in is honor-system. Points are recomputed on every page view (fine at this size).
- The rules classifier is keyword-based. Unusual phrasing falls to "unclear", which gets an In/Out question. Sarcasm or mixed messages can be misread. Auto-replies are unsupervised by design, so watch the Inbox log during the first weeks.
- With only ~6 weeks of data, A/B "winners" are not statistically strong. The rule is deliberately simple.

### Deploying for real (what it would take)
1. **Always-on host** (the scheduler must keep running): a small VPS (e.g. Oracle Cloud Always Free VM, Hetzner/DigitalOcean ~$4–6 per month), or Railway, Render (paid instance) or Fly.io with one machine set to never stop. Free tiers that sleep when idle (e.g. Render free web services) **would miss scheduled sends**. Alternatively, keep a free host plus an external cron (GitHub Actions, cron-job.org or Cloud Scheduler) calling the protected `POST /api/tick` endpoint (captain key) every few minutes. The catch-up logic makes this safe. Check current free-tier terms.
2. **Persistent database:** SQLite on a persistent disk/volume with nightly backups, or managed Postgres (Neon or Supabase free tiers). Keep `messages`, `jobRuns` and RSVP history: they are the measurement data.
3. **HTTPS + a real `BASE_URL`**, a strong `ADMIN_TOKEN`, and process supervision (systemd or pm2, `/healthz` for uptime checks).
4. **Team Google account (email + calendar):** use the dedicated team Gmail `llamas.soccer.team@gmail.com`. The captain owns its password and 2-step verification.
   - **Recommended: OAuth with that account.** Create a Google Cloud project, enable the Gmail API and the Google Calendar API, configure the OAuth consent screen (External; publish it to "In production" so refresh tokens don't expire after 7 days; an unverified app is OK for the team's own use and shows a warning once), and create an OAuth client. Sign in **once as the team account** to grant `calendar.events`, `gmail.send` and `gmail.modify` (to read replies and mark them processed). Store the refresh token as a server secret (never in the repo). Events are created on the team account's calendar with players as attendees, so the invites and replies (Yes/No/Maybe) belong to the team account.
   - **Service account:** works for calendar data, but a plain Gmail account can't use domain-wide delegation. Without Google Workspace, a service account can't send invitations or email *as* the team Gmail. Use it only if the team moves to Workspace.
   - **Hand-over:** because everything is authorized by the team account, a new captain only needs the Gmail login (and the captain link). If the password is changed, re-run the one-time sign-in to get a fresh refresh token.
5. Turn on `channels.email.mode: 'gmail-api'` after implementing it, and keep the kill switch OFF until a test week looks right in the Outbox.

---

## Part 3 — Demo mode (public click-around demo)

`DEMO=1` runs a demo with made-up players:
- A banner on every page: "Demo with made-up players. Nothing here is real and no messages are sent."
- Outbound email, SMS, Gmail polling, the LLM classifier and Google Calendar are hard-disabled, whatever the other settings say. The scheduler and inbox still run, but only into the local Outbox.
- `/` is a landing page with three big buttons. `/dashboard` is the team dashboard, `/demo/player` opens a sample player (Faux Fran) and `/demo/captain` signs in with the demo-only captain key (`demo-captain`). The dev/real captain key doesn't work on the demo, and the demo key doesn't work on the dev instance.
- Visitors can change anything. **Captain → Home → Reset demo data** restores the starting sample. Every night at 03:00 MT the demo re-seeds itself in the background (fresh dates). Making new player/captain links is disabled in the demo.
- No real teammate data is used. Don't import contact lists into the demo.

Run it as a separate instance with its own data (already set up in `/workspace/llamas-demo/`):
```bash
/workspace/llamas-demo/run-demo.sh      # port 3100, data in /workspace/llamas-demo/data, auto-restart loop
/workspace/llamas-demo/run-tunnel.sh    # Cloudflare quick tunnel to 127.0.0.1:3100, writes public-url.txt
```
Quick tunnel (no account): `cloudflared tunnel --protocol http2 --url http://127.0.0.1:3100`. It needs outbound TCP/UDP port 7844 to Cloudflare. The URL is random and changes every time the tunnel restarts.
