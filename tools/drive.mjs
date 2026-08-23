#!/usr/bin/env node
// Headless QA driver (zero dependencies, Node >= 22 for global WebSocket).
// Serves the repo, opens the game in headless Chrome via CDP, collects console
// output and page errors, optionally evaluates a scenario script in the page,
// and saves a screenshot.
//
//   node tools/drive.mjs [--time 5] [--shot out.png] [--eval scenario.js]
//                        [--port 8123] [--allow-errors]
//
// The scenario file body is evaluated in the page (async, awaited). It can use
// window.DAM = {game, emit} and should return a JSON-serializable summary.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
}
const flag = (name) => args.includes('--' + name);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(opt('port', '8123'), 10);
const TIME = parseFloat(opt('time', '5'));
const SHOT = opt('shot', null);
const EVAL = opt('eval', null);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// watchdog: never hang forever; report which phase stalled
let phase = 'start';
const note = (p) => { phase = p; if (flag('verbose')) console.error('… ' + p); };
setTimeout(() => {
  console.error(`WATCHDOG: stalled during "${phase}" — aborting`);
  try { chrome && chrome.kill(); } catch {}
  try { server && server.kill(); } catch {}
  process.exit(2);
}, (TIME + 60) * 1000);

// --- static server -----------------------------------------------------
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore',
});

// --- chrome ------------------------------------------------------------
// Fresh profile per run: a persisted profile keeps the versioned service
// worker, which then serves the PREVIOUS deploy from cache — correct for
// players, fatal for QA (you test stale code without noticing).
const profile = mkdtempSync(path.join(tmpdir(), 'dam-builder-qa-'));
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} });

const WIDTH = parseInt(opt('width', '1280'), 10);
const HEIGHT = parseInt(opt('height', '800'), 10);
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', '--no-first-run',
  `--user-data-dir=${profile}`, `--window-size=${WIDTH},${HEIGHT}`,
  '--hide-scrollbars', '--disable-gpu', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  chrome.on('exit', () => reject(new Error('chrome exited early\n' + buf)));
  setTimeout(() => reject(new Error('no devtools endpoint\n' + buf)), 15000);
});

// --- minimal CDP client --------------------------------------------------
note('ws-connect');
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let msgId = 0;
const pending = new Map();
const eventHandlers = [];
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method) {
    for (const h of eventHandlers) h(msg);
  }
};
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
function onEvent(method, sessionId, fn) {
  eventHandlers.push((m) => { if (m.method === method && m.sessionId === sessionId) fn(m.params); });
}

// --- open page -----------------------------------------------------------
note('create-target');
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);

const logs = [];
let errorCount = 0;
onEvent('Runtime.consoleAPICalled', sessionId, (p) => {
  const text = p.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
  logs.push(`[${p.type}] ${text}`);
  if (p.type === 'error') errorCount++;
});
onEvent('Runtime.exceptionThrown', sessionId, (p) => {
  const d = p.exceptionDetails;
  logs.push(`[EXCEPTION] ${d.text} ${(d.exception && d.exception.description) || ''} at ${d.url || ''}:${d.lineNumber || ''}`);
  errorCount++;
});

note('navigate');
const loaded = new Promise((r) => onEvent('Page.loadEventFired', sessionId, r));
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` }, sessionId);
await Promise.race([loaded, sleep(6000).then(() => console.error('WARN: load event timeout, continuing'))]);
note('after-load');
await sleep(600);

// --- scenario -----------------------------------------------------------
const PRE = opt('pre', null); // JS statement(s) evaluated before the --eval file
if (PRE) await send('Runtime.evaluate', { expression: PRE }, sessionId);
if (EVAL) {
  const src = readFileSync(EVAL, 'utf8');
  const res = await send('Runtime.evaluate', {
    expression: `(async () => {\n${src}\n})()`,
    awaitPromise: true, returnByValue: true, timeout: 120000,
  }, sessionId);
  if (res.exceptionDetails) {
    logs.push(`[SCENARIO EXCEPTION] ${(res.exceptionDetails.exception && res.exceptionDetails.exception.description) || res.exceptionDetails.text}`);
    errorCount++;
  } else {
    console.log('SCENARIO RESULT:', JSON.stringify(res.result.value, null, 2));
  }
}

await sleep(TIME * 1000);

if (SHOT) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(SHOT, Buffer.from(data, 'base64'));
  console.log('screenshot:', SHOT);
}

console.log('--- console ---');
for (const l of logs) console.log(l);
console.log('--- end ---');
console.log(`errors: ${errorCount}`);

ws.close();
chrome.kill();
server.kill();
process.exit(errorCount > 0 && !flag('allow-errors') ? 1 : 0);
