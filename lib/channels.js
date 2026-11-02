// Pluggable delivery channels. LOCAL MODE: nothing leaves this machine.
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const C = cfg.channels;

const email = {
  name: 'email',
  enabled: () => C.email.enabled,
  send(msg, { outboxFile } = {}) {
    if (cfg.demo && C.email.mode !== 'local-outbox') throw new Error('DEMO mode: outbound email is disabled.');
    if (C.email.mode !== 'local-outbox') throw new Error('Real email sending is not implemented (would use the Gmail API as ' + cfg.teamAccount.email + ').');
    const file = path.resolve(__dirname, '..', outboxFile || C.email.outboxFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `=== ${msg.sentAt}  [${msg.step}/${msg.variant}] email\nFrom: ${cfg.teamAccount.displayName} <${cfg.teamAccount.email}>\nTo: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.body}\n\n`);
    return { delivery: 'local-outbox' };
  },
};

// SMS via Twilio — designed in, switched OFF. To enable: set channels.sms.enabled = true,
// provide TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / from number, `npm i twilio`, and implement below.
const sms = {
  name: 'sms',
  enabled: () => !cfg.demo && C.sms.enabled && !!process.env.TWILIO_ACCOUNT_SID,
  send() { throw new Error('SMS channel is disabled in this prototype.'); },
};

const channels = { email, sms };
function pickChannel(player) {
  if (player.channel === 'sms' && player.phone && sms.enabled()) return 'sms';
  return 'email';
}
module.exports = { channels, pickChannel };
