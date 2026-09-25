// Capture the README screenshots with headless Chrome over the DevTools
// protocol (Node 22 has WebSocket built in, so no extra dependency).
//   BASE_URL=http://localhost:5610 CHROME=google-chrome node scripts/screenshots.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:5610';
const PORT = Number(process.env.CDP_PORT ?? 5619);
const OUT = path.resolve('docs/screenshots');
const W = 1440;
const H = 900;
mkdirSync(OUT, { recursive: true });

const profile = mkdtempSync(path.join(tmpdir(), 'ro-shots-'));
const chrome = spawn(process.env.CHROME ?? 'google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--disable-gpu', `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTarget() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('chrome did not start');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) listeners.forEach((l) => l(msg));
  };
  const ready = new Promise((r) => { ws.onopen = r; });
  return {
    ready,
    send: (method, params = {}) => new Promise((resolve, reject) => { id += 1; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }),
    once: (method) => new Promise((resolve) => { const l = (m) => { if (m.method === method) { listeners.splice(listeners.indexOf(l), 1); resolve(m.params); } }; listeners.push(l); }),
    close: () => ws.close(),
  };
}

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'receipts-demo' }) });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return res.headers.get('set-cookie').split(';')[0].split('=')[1];
}

async function api(token, p) {
  return (await fetch(`${BASE}${p}`, { headers: { cookie: `ro_session=${token}` } })).json();
}

const token = await login('lia@example.com');
const review = await api(token, '/api/review');
const pngSuggested = review.rows.find((r) => r.stage === 'suggested' && r.mime === 'image/png' && r.payee === 'Golden Mill Flour')
  ?? review.rows.find((r) => r.stage === 'suggested' && r.mime === 'image/png') ?? review.rows[0];
const proposal = review.rows.find((r) => r.proposal_run_id) ?? review.rows[0];
const tree = await api(token, '/api/files/tree');
const dairy = tree.folders.find((f) => f.path === '/Suppliers/Dairy');

const shots = [
  { name: '01-overview', url: '/' },
  { name: '02-review', url: `/review?file=${pngSuggested.file_id}` },
  { name: '03-review-reprocess-diff', url: `/review?stage=needs_decision&file=${proposal.file_id}` },
  { name: '04-files', url: `/files?folder=${dairy.id}`, click: 'tbody tr.row:nth-child(2)' },
  { name: '05-duplicates', url: '/duplicates' },
  { name: '06-bills', url: '/bills' },
  { name: '07-payments', url: '/payments' },
  { name: '08-operations', url: '/operations?state=open', click: 'tbody tr.row:nth-child(1)' },
  { name: '09-status', url: '/status' },
  { name: '10-settings-people', url: '/settings', click: '[role=tab]:nth-child(4)' },
  { name: '11-dark-review', url: `/review?file=${pngSuggested.file_id}`, dark: true },
  { name: '12-login', url: '/login', anonymous: true },
];

const c = connect(await cdpTarget());
await c.ready;
await c.send('Page.enable');
await c.send('Network.enable');
await c.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const only = process.argv[2];
for (const s of shots) {
  if (only && !s.name.includes(only)) continue;
  await c.send('Network.clearBrowserCookies');
  if (!s.anonymous) await c.send('Network.setCookie', { name: 'ro_session', value: token, url: BASE });
  await c.send('Network.setCookie', { name: 'ro_theme', value: s.dark ? 'dark' : 'light', url: BASE });
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s.dark ? 'dark' : 'light' }] });
  const loaded = c.once('Page.loadEventFired');
  await c.send('Page.navigate', { url: `${BASE}${s.url}` });
  await loaded;
  await sleep(2500);
  if (s.click) {
    await c.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(s.click)})?.click()` });
    await sleep(2000);
  }
  const { data } = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
  writeFileSync(path.join(OUT, `${s.name}.png`), Buffer.from(data, 'base64'));
  console.log(`saved ${s.name}.png`);
}

c.close();
chrome.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
