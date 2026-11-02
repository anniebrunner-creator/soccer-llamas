const cfg = require('../config');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mapLink = (addr) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;
const chips = (players, cls = '') => players.length ? players.map((p) => `<span class="chip ${cls} ${p.canKeep ? 'k' : ''}">${esc(p.name)}</span>`).join('') : '<span class="muted small">nobody yet</span>';
const statusWord = { in: 'In', out: 'Out', maybe: 'Maybe' };

function layout({ title, body, nav = '', flash = '', captain = '' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(cfg.teamName)}</title><link rel="stylesheet" href="/style.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🦙</text></svg>"></head>
<body>${cfg.demo ? '<div class="demo-banner"><a href="/" style="text-decoration:none">🧪 Demo with made-up players. Nothing here is real and no messages are sent.</a></div>' : ''}<header class="top"><a class="brand" href="/"><span class="logo">🦙</span><span><small>⚽ Fall 2026</small><b>${esc(cfg.teamName)}</b></span></a>${nav}</header>
<main>${flash ? `<div class="flash">${esc(flash)}</div>` : ''}${body}
<div class="foot">${captain ? `Captain: ${esc(captain)} · ` : ''}Spit happens. Show up anyway. 🦙</div></main></body></html>`;
}

function adminNav(active) {
  const items = [['/admin', 'Home'], ['/admin/games', 'Games'], ['/admin/players', 'Players'], ['/admin/money', 'Fees & cards'], ['/admin/points', 'Give points'], ['/admin/pinnies', 'Pinnies'], ['/admin/injuries', 'Injuries'], ['/admin/health', 'Team health'], ['/admin/inbox', 'Inbox'], ['/admin/outbox', 'Outbox'], ['/admin/calendar', 'Calendar preview'], ['/admin/settings', 'Settings']];
  return `<nav class="sub">${items.map(([h, l]) => `<a href="${h}" class="${h === active ? 'on' : ''}">${l}</a>`).join('')}<a href="/dashboard">Team page</a></nav>`;
}

const help = (text) => `<p class="hint" style="font-size:14px;margin:0 0 12px">💡 ${text}</p>`;

module.exports = { esc, mapLink, chips, statusWord, layout, adminNav, help };
