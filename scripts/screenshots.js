// Phone-size screenshots (390x844) with headless Chrome via playwright-core.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'db.json'), 'utf8'));
const out = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(out, { recursive: true });
const B = cfg.baseUrl;
const player = db.players.find((p) => p.name === 'Sample Sam');
const injured = db.players.find((p) => p.name === 'Stand-in Stella');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const shots = [
    ['01-dashboard.png', `${B}/`],
    ['02-player-page.png', `${B}/p/${player.token}`],
    ['03-player-on-injury-reserve.png', `${B}/p/${injured.token}`],
    ['04-captain-home.png', `${B}/admin?key=${db.settings.adminToken}`],
    ['05-team-health.png', `${B}/admin/health`],
    ['06-outbox-oct25-practice-run.png', `${B}/admin/outbox?view=sim`],
    ['07-outbox-live.png', `${B}/admin/outbox`],
    ['08-calendar-preview.png', `${B}/admin/calendar`],
    ['09-game-attendance.png', `${B}/admin/games/g_oct18`],
    ['10-inbox.png', `${B}/admin/inbox`],
  ];
  for (const [file, url] of shots) {
    await page.goto(url, { waitUntil: 'networkidle' });
    if (file.startsWith('10')) await page.evaluate(() => { const d = document.querySelectorAll('details.msg'); [d.length - 1, d.length - 6].forEach((i) => d[i] && (d[i].open = true)); });
    if (file.startsWith('06')) await page.evaluate(() => document.querySelectorAll('details.msg')[0] && (document.querySelectorAll('details.msg')[0].open = true));
    await page.screenshot({ path: path.join(out, file), fullPage: true });
    console.log(path.join(out, file));
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
