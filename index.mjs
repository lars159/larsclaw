#!/usr/bin/env node
// larsclaw – tiny OpenClaw-style assistant: WhatsApp + Copilot CLI + MEMORY.md + heartbeats
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const MEMORY_FILE = path.join(ROOT, 'MEMORY.md');
const HISTORY_FILE = path.join(DATA, 'history.json');
const BEATS_FILE = path.join(DATA, 'heartbeats.json');

// ---------- config ----------
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const env = process.env;
const MODEL = env.COPILOT_MODEL || '';
const ALLOWED = (env.ALLOWED_NUMBERS || '').split(',').map((s) => s.trim().replace(/\D/g, '')).filter(Boolean);
const TRIGGER = env.TRIGGER || '@bot';
const HISTORY_LIMIT = Number(env.HISTORY_LIMIT || 20);
const TIMEOUT = Number(env.COPILOT_TIMEOUT_MS || 120000);
const ALLOW_TOOLS = env.ALLOW_TOOLS === 'true';
const ALLOW_URLS = env.ALLOW_URLS !== 'false'; // web access (fetch pages) without shell/file access
const MIN_BEAT_MS = 60_000;

fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, '# Memory\n');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

// ---------- memory ----------
const readMemory = () => fs.readFileSync(MEMORY_FILE, 'utf8');
const addMemory = (fact) => fs.appendFileSync(MEMORY_FILE, `- ${fact}\n`);
function forget(text) {
  const lines = readMemory().split('\n');
  const kept = lines.filter((l) => !l.toLowerCase().includes(text.toLowerCase()) || l.startsWith('#'));
  fs.writeFileSync(MEMORY_FILE, kept.join('\n'));
  return lines.length - kept.length;
}

// ---------- history ----------
const history = readJson(HISTORY_FILE, {});
function pushHistory(chat, role, text) {
  const h = (history[chat] ||= []);
  h.push({ role, text });
  if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
  writeJson(HISTORY_FILE, history);
}

// ---------- copilot ----------
function askCopilot(prompt) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--silent'];
    if (MODEL) args.push('--model', MODEL);
    if (ALLOW_TOOLS) args.push('--allow-all-tools');
    if (ALLOW_URLS) args.push('--allow-all-urls');
    const p = spawn('copilot', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Copilot timed out')); }, TIMEOUT);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`Cannot run copilot: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out.trim());
      const msg = (err || out).trim();
      reject(new Error(/auth|login/i.test(msg) ? 'Copilot not logged in. Run `copilot` and `/login`.' : msg || `copilot exited ${code}`));
    });
  });
}

const SYSTEM = `You are larsclaw, a concise personal assistant replying in a chat app.
Answer in short plain text.
To save a durable fact about the user, add a separate line: REMEMBER: <fact>
To schedule a recurring task (heartbeat), add a separate line: HEARTBEAT: <interval like 30m, 2h, 1d> | <prompt to run each time>`;

function buildPrompt(chat, { heartbeat = false } = {}) {
  const convo = (history[chat] || []).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
  const note = heartbeat ? '\n(This is an automatic scheduled run, not a live user message.)' : '';
  return `${SYSTEM}${note}\n\n## Memory\n${readMemory()}\n\n## Conversation\n${convo}\nAssistant:`;
}

// ---------- heartbeats ----------
let beats = readJson(BEATS_FILE, []); // { id, chat, everyMs, prompt }
const timers = new Map();
const senders = new Map(); // chat -> send fn (set by channel)
let sendFor = (chat, text) => (chat.startsWith('cli') ? console.log(`\n[heartbeat] ${text}\n`) : senders.get('wa')?.(chat, text));

function parseInterval(s) {
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(s.trim());
  if (!m) return null;
  const ms = Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase()];
  return ms >= MIN_BEAT_MS ? ms : null;
}
const fmtMs = (ms) => (ms % 864e5 === 0 ? `${ms / 864e5}d` : ms % 36e5 === 0 ? `${ms / 36e5}h` : `${Math.round(ms / 6e4)}m`);

function schedule(b) {
  clearInterval(timers.get(b.id));
  timers.set(b.id, setInterval(() => runBeat(b), b.everyMs));
}
async function runBeat(b) {
  try {
    const task = `[Scheduled task] ${b.prompt}`;
    const prompt = buildPrompt(b.chat, { heartbeat: true }).replace(/Assistant:$/, `User: ${task}\nAssistant:`);
    const reply = await enqueue(b.chat, () => askCopilot(prompt));
    const clean = postProcess(reply, b.chat);
    pushHistory(b.chat, 'user', task);
    pushHistory(b.chat, 'assistant', clean);
    log('>>', `${b.chat} (heartbeat #${b.id})`, clean);
    await sendFor(b.chat, `⏰ ${clean}`);
  } catch (e) {
    log('!!', b.chat, `heartbeat #${b.id} failed: ${e.message}`);
    await sendFor(b.chat, `⏰ Heartbeat ${b.id} failed: ${e.message}`);
  }
}
function addBeat(chat, everyMs, prompt) {
  const id = String(Math.max(0, ...beats.map((b) => Number(b.id))) + 1);
  const b = { id, chat, everyMs, prompt };
  beats.push(b);
  writeJson(BEATS_FILE, beats);
  schedule(b);
  return b;
}
function removeBeat(chat, id) {
  const b = beats.find((x) => x.id === id && x.chat === chat);
  if (!b) return false;
  clearInterval(timers.get(id));
  timers.delete(id);
  beats = beats.filter((x) => x !== b);
  writeJson(BEATS_FILE, beats);
  return true;
}

// ---------- per-chat queue ----------
const queues = new Map();
function enqueue(chat, fn) {
  const next = (queues.get(chat) || Promise.resolve()).then(fn, fn);
  queues.set(chat, next.catch(() => {}));
  return next;
}

// ---------- reply post-processing (REMEMBER / HEARTBEAT directives) ----------
function postProcess(reply, chat) {
  const out = [];
  for (const line of reply.split('\n')) {
    let m;
    if ((m = line.match(/^\s*REMEMBER:\s*(.+)$/i))) addMemory(m[1].trim());
    else if ((m = line.match(/^\s*HEARTBEAT:\s*(\S+)\s*\|\s*(.+)$/i))) {
      const ms = parseInterval(m[1]);
      if (ms) {
        const b = addBeat(chat, ms, m[2].trim());
        out.push(`✅ Heartbeat #${b.id} every ${fmtMs(ms)}: ${b.prompt}`);
      } else out.push(`⚠️ Invalid heartbeat interval "${m[1]}" (min 1m, e.g. 30m, 2h, 1d).`);
    } else out.push(line);
  }
  return out.join('\n').trim() || '👍';
}

// ---------- command + message pipeline ----------
const HELP = `Commands:
/memory – show memory
/forget <text> – delete memory lines containing text
/reset – clear this chat's history
/heartbeat <interval> <task> – run task repeatedly (e.g. /heartbeat 1h summarize my day)
/heartbeats – list heartbeats
/stop <id> – delete a heartbeat
Or just ask in plain language: "every morning remind me to ..."`;

async function handle(chat, text) {
  const t = text.trim();
  if (t.startsWith('/')) {
    const [cmd, ...rest] = t.split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd.toLowerCase()) {
      case '/help': return HELP;
      case '/memory': return readMemory();
      case '/forget': return arg ? `Removed ${forget(arg)} line(s).` : 'Usage: /forget <text>';
      case '/reset': delete history[chat]; writeJson(HISTORY_FILE, history); return 'History cleared.';
      case '/heartbeats': {
        const mine = beats.filter((b) => b.chat === chat);
        return mine.length ? mine.map((b) => `#${b.id} every ${fmtMs(b.everyMs)}: ${b.prompt}`).join('\n') : 'No heartbeats.';
      }
      case '/stop': return removeBeat(chat, rest[0]) ? `Stopped #${rest[0]}.` : 'No such heartbeat.';
      case '/heartbeat': {
        const ms = parseInterval(rest[0] || '');
        if (!ms || rest.length < 2) return 'Usage: /heartbeat <interval ≥1m, e.g. 30m|2h|1d> <task>';
        const b = addBeat(chat, ms, rest.slice(1).join(' '));
        return `✅ Heartbeat #${b.id} every ${fmtMs(ms)}: ${b.prompt}`;
      }
    }
  }
  return enqueue(chat, async () => {
    pushHistory(chat, 'user', t);
    const reply = postProcess(await askCopilot(buildPrompt(chat)), chat);
    pushHistory(chat, 'assistant', reply);
    return reply;
  });
}
const ts = () => new Date().toLocaleTimeString();
const log = (dir, chat, text) => console.log(`[${ts()}] ${dir} ${chat}: ${String(text).replace(/\n/g, '\n    ')}`);
async function safeHandle(chat, text) {
  log('<<', chat, text);
  const reply = await handle(chat, text).catch((e) => `⚠️ ${e.message}`);
  log('>>', chat, reply);
  return reply;
}

// ---------- terminal channel ----------
function startCli() {
  const chat = 'cli';
  console.log('larsclaw CLI – /help for commands, Ctrl+C to quit');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    if (line.trim()) await safeHandle(chat, line);
    rl.prompt();
  });
}

// ---------- WhatsApp channel ----------
async function startWhatsApp() {
  if (!ALLOWED.length) {
    console.error('Set ALLOWED_NUMBERS (comma-separated, digits only) to use WhatsApp.');
    process.exit(1);
  }
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import('@whiskeysockets/baileys');
  const { default: qrcode } = await import('qrcode-terminal');
  const { default: pino } = await import('pino');
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA, 'auth'));

  const connect = () => {
    const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) qrcode.generate(qr, { small: true });
      if (connection === 'open') console.log('WhatsApp connected.');
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.error('Logged out. Delete data/auth and restart to re-pair.');
          process.exit(1);
        }
        setTimeout(connect, 3000);
      }
    });
    senders.set('wa', async (jid, text) => {
      for (let i = 0; i < text.length; i += 4000) await sock.sendMessage(jid, { text: text.slice(i, i + 4000) });
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast') continue;
        const isGroup = jid.endsWith('@g.us');
        const sender = (isGroup ? msg.key.participant : jid) || '';
        const number = sender.split('@')[0].split(':')[0].replace(/\D/g, '');
        const fromMe = msg.key.fromMe;
        // allow messaging yourself ("Message yourself" chat); otherwise ignore own messages
        if (fromMe && isGroup) continue;
        if (!fromMe && !ALLOWED.includes(number)) continue;
        let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!text) continue;
        if (isGroup) {
          if (!text.toLowerCase().startsWith(TRIGGER.toLowerCase())) continue;
          text = text.slice(TRIGGER.length).trim();
        }
        if (fromMe && text.startsWith('⏰')) continue; // our own heartbeat output
        await sock.sendPresenceUpdate('composing', jid).catch(() => {});
        const reply = await safeHandle(jid, text);
        if (fromMe && reply === text) continue;
        await senders.get('wa')(jid, reply);
      }
    });
  };
  connect();
}

// ---------- hot deploy: `--watch` supervises a child and restarts it on file changes ----------
function supervise() {
  const args = process.argv.slice(1).filter((a) => a !== '--watch');
  let child, timer;
  const start = () => {
    child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', (code, sig) => {
      if (!child.restarting && sig !== 'SIGTERM') process.exit(code ?? 0);
    });
  };
  const restart = (file) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`[${new Date().toLocaleTimeString()}] ♻️  ${file} changed, restarting...`);
      const old = child;
      old.restarting = true;
      old.once('exit', start);
      old.kill('SIGTERM');
    }, 300);
  };
  for (const f of ['index.mjs', '.env']) {
    try { fs.watch(path.join(ROOT, f), () => restart(f)); } catch {}
  }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); process.exit(0); });
  start();
}

// ---------- main ----------
if (process.argv.includes('--watch')) { supervise(); await new Promise(() => {}); }
for (const b of beats) schedule(b);
if (process.argv.includes('--cli')) startCli();
else startWhatsApp();
