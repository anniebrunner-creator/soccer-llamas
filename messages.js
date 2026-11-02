// Copy for every automatic message. Two variants (A/B) per step; the app splits sends
// evenly, then automatically favors whichever gets more replies.
// Placeholders: {name} {date} {time} {location} {address} {map} {inLink} {outLink} {maybeLink}
// {pageLink} {pauseLink} {count} {need} {target} {min} {deadline} {pinnies} {gameCard}
// {leaderboard} {llamaOfWeek} {result} {present} {keeper}
const footer = '\n\nYour page: {pageLink}\nToo many messages? Pause them: {pauseLink}\n— Soccer Llamas 🦙';
const tap = '\n\n👍 In: {inLink}\n🤔 Maybe: {maybeLink}\n👎 Out: {outLink}';
const sig = '\n\n— Soccer Llamas 🦙 (automatic reply from the team inbox)';
const replies = {
  in: { A: "Yay, {first}! You're In for {game}. 🦙⚽ See you there!{extras}" + sig },
  out: {
    A: "Totally get it, {first}, we'll miss you! Can you make {nextGame}? Tap here to say yes: {nextInLink}{extras}" + sig,
    B: "No worries at all, {first}. You're marked Out for {game}. If {nextGame} works for you, one tap: {nextInLink} 🦙{extras}" + sig,
  },
  conflict: {
    A: "{reasonLine} You're marked Out for {game}, no stress. We'll miss you! Can you make {nextGame}? Tap to say yes: {nextInLink}{extras}" + sig,
    B: "{reasonLine} Got you down as Out for {game}. The herd will save you a spot for {nextGame}. Say yes here: {nextInLink}{extras}" + sig,
  },
  maybe: {
    A: "Thanks, {first}! You're a Maybe for {game}. If you can lock in a yes by Thursday night, that's +3 Llama Points 🦙\n👍 In: {inLink}\n👎 Out: {outLink}{extras}" + sig,
    B: "Fingers crossed, {first}! We have {count} in for {game}. One tap when you know (yes by Thursday = +3 points):\n👍 In: {inLink}\n👎 Out: {outLink}{extras}" + sig,
  },
  injury: {
    A: "So sorry about your {part}, {first}, heal up! 💛 You're on the IR list{returnText} and we'll skip game nudges until you're back. Come cheer if you can; game-day help still earns Llama Points.{extras}" + sig,
    B: "Oh no, {first}! Sending get-well llama vibes for your {part}. 🦙💛 You're on injury reserve{returnText}, so no game nudges until you're cleared. Sideline cheering (and helping with pinnies) still counts for points!{extras}" + sig,
  },
  late: { A: "No problem, {first}, we'll save you a spot! Kickoff is {time} at {location}. Drive safe! 🦙{extras}" + sig },
  friend: { A: "Love it, {first}! The more llamas the better. 🙌 Have {friend} reply here with her name and number (or text the captain). Once she plays, you get +10 Llama Points.{extras}" + sig },
  question: { A: "Hi {first}!{extras}\n\nAre you in for {game}? 👍 {inLink}  ·  👎 {outLink}" + sig },
  pause: { A: "Done, {first}. Messages are paused until {until}. You can still answer anytime on your page: {pageLink}\nTurn them back on here: {pauseLink}" + sig },
  other: {
    A: "Thanks for the note, {first}! Quick check: are you playing {game}?\n👍 In: {inLink}\n🤔 Maybe: {maybeLink}\n👎 Out: {outLink}{extras}" + sig,
    B: "Hi {first}! 🦙 We're counting llamas for {game}. One tap:\n👍 In: {inLink}\n🤔 Maybe: {maybeLink}\n👎 Out: {outLink}{extras}" + sig,
  },
  unknown: { A: "Hi there! Thanks for reaching out to the Soccer Llamas 🦙⚽\n\nWant to join or sub? We're a women's 8v8 team playing Sunday mornings in Arvada and Lakewood. Reply with your name and phone number, and our captain will get in touch. Our next game is {game} at {location}." + sig },
  irOther: { A: "Thanks, {first}! 💛 No rush. Heal up first. When you're cleared to play, one tap takes you off injury reserve: {clearLink}\nNeed more time? Update your return date here: {pageLink}{extras}" + sig },
  // add-on lines
  friendLine: "\n\nAnd yes, bring your friend! Have {friend} reply here. Once she plays you get +10 Llama Points. 🙌",
  lateLine: "\n\nRunning late is fine, we'll save you a spot!",
  sensitiveLine: "\n\nI've also passed this along to our captain so a real human can follow up. 💛",
};

module.exports = {
  replies,
  invite: {
    A: { subject: '⚽ Llamas play {date} at {time}', body: 'Hi {name}! Game on {date} at {time}, {location}.\nAre you in? One tap:' + tap + '\n\nAnswer by Thursday night for +3 Llama Points.' + footer },
    B: { subject: '🦙 Are you in for Sunday, {name}?', body: 'Hey {name} — the herd gathers {date} at {time} ({location}). {count} llamas are in so far.\nTap one:' + tap + '\n\n+3 Llama Points for answering by Thursday 11:59 pm!' + footer },
  },
  wedNudge: {
    A: { subject: 'Quick one: are you playing {date}?', body: 'Hi {name}, we have {count} in for {date}. Can you let us know?' + tap + footer },
    B: { subject: '+3 Llama Points waiting for you 🦙', body: '{name}, grab +3 Llama Points — just answer by Thursday night! {count} in so far for {date}.' + tap + footer },
  },
  thuLastChance: {
    A: { subject: 'Last chance for +3 points tonight', body: 'Hi {name}! Answer by {deadline} tonight to earn +3 Llama Points. We have {count} in for {date}.' + tap + footer },
    B: { subject: '⏰ Tonight: help us count llamas', body: '{name}, we need {min} to play and {count} are in. A quick answer by {deadline} helps a lot (and earns +3).' + tap + footer },
  },
  friAsk: {
    A: { subject: 'Can you play {date}? We have {count}', body: 'Hi {name}! We have {count} for {date} at {time} and want {target} for a comfy bench. Could you play?' + tap + footer },
    B: { subject: '🙏 A couple more llamas needed', body: '{name}, {need} more players would give us a full bench on {date}. Subs get +5 Llama Points when we\'re short!' + tap + footer },
  },
  satUrgent: {
    A: { subject: '🚨 We are short for tomorrow', body: 'Hi {name} — only {count} in for tomorrow ({date} {time}). We need {min} to play. Can you come or bring a friend?' + tap + footer },
    B: { subject: '🚨 SOS: {need} players needed tomorrow', body: '{name}, we\'re {need} short of {min} for tomorrow. Subbing in earns +5 Llama Points, bringing a new player +10!' + tap + footer },
  },
  keeperAlert: {
    A: { subject: '🧤 We need a keeper tomorrow', body: 'Hi {name}, no keeper is signed up for {date}. Could you take a half in goal?' + tap + footer },
    B: { subject: '🧤 Keeper wanted (+5 points!)', body: '{name}, be our hero in goal on {date} — +5 Llama Points when we\'re short a keeper.' + tap + footer },
  },
  gameDay: {
    A: { subject: 'Today {time}: {location}', body: 'See you today, {name}! {time} at {location}, {address}.\nMap: {map}\nSpare pinnies: {pinnies}. Game card: {gameCard}.\n{count} llamas in.' + footer },
    B: { subject: '🦙 Game day! {time} at {location}', body: 'Lace up, {name}! Kickoff {time} at {location} ({address}).\nDirections: {map}\nPinnies: {pinnies} · Game card: {gameCard}' + footer },
  },
  checkinPrompt: {
    A: { subject: 'Did you play today? Tap to check in', body: 'Thanks for coming, {name}! Tap to mark yourself present (+2 Llama Points): {pageLink}' + footer },
    B: { subject: '✅ One tap to log your game', body: '{name}, log today\'s game and keep your +2 points: {pageLink}' + footer },
  },
  // Sent once, the day after a player's expected return date passes (not A/B tested).
  irCheck: {
    A: { subject: '🦙 Ready to come back, {name}?', body: 'Hi {name}! Your expected return date ({returnDate}) has passed. How are you feeling? 💛\n\nCleared to play? Tap here: {clearLink}\nNeed more time? Update your return date: {pageLink}\n\nNo rush — heal up first. The herd misses you!' + footer },
  },
  recap: {
    A: { subject: 'Recap: {result}', body: 'Hi {name}! Result: {result}. {present} llamas played.\nLlama of the Week: {llamaOfWeek} 🏅\n\nTop 5:\n{leaderboard}' + footer },
    B: { subject: '🦙 Weekly herd report', body: '{present} llamas showed up — {result}!\n🏅 Llama of the Week: {llamaOfWeek}\n\nLeaderboard:\n{leaderboard}\n\nThanks, {name}!' + footer },
  },
};
