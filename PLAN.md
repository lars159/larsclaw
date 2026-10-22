# larsclaw – a super simple OpenClaw clone (Node.js, single `index.mjs`)

A tiny personal assistant: WhatsApp in → GitHub Copilot CLI as the brain → reply out, with a plain-markdown memory file.

## Goals
- **One file**: `index.mjs` (ESM, no build step).
- **WhatsApp channel** via [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) (QR-code pairing, no business API).
- **Memory file**: `MEMORY.md`, human-editable, injected into every prompt.
- **Copilot CLI backend**: spawns `copilot -p "<prompt>"` (non-interactive) – same idea as nanopielot's `agent-runner` / `copilot-auth` / `copilot-models` modules, collapsed into one file.
- Also a local **terminal REPL** mode for testing without WhatsApp.

## Requirements
- Node.js ≥ 20
- GitHub Copilot CLI installed and logged in (`npm i -g @github/copilot`, then run `copilot` once and `/login`)
- Active Copilot subscription

## Layout
```
larsclaw/
├─ index.mjs      # everything
├─ package.json   # { "type": "module", deps: baileys, qrcode-terminal, pino }
├─ MEMORY.md      # long-term memory (created on first run)
├─ data/
│  ├─ auth/       # WhatsApp session (baileys multi-file auth state)
│  └─ history.json# last N messages per chat
└─ .env           # optional config
```

## Configuration (env vars)
| Var | Default | Purpose |
|---|---|---|
| `COPILOT_MODEL` | *(CLI default)* | passed as `--model` |
| `ALLOWED_NUMBERS` | *(required for WhatsApp)* | comma-separated JIDs/numbers allowed to talk to the bot |
| `TRIGGER` | `@bot` | prefix required in group chats (DMs always answer) |
| `HISTORY_LIMIT` | `20` | messages kept per chat |
| `COPILOT_TIMEOUT_MS` | `120000` | kill runaway runs |
| `ALLOW_TOOLS` | `false` | if `true`, adds `--allow-all-tools` (shell/file access – dangerous!) |

## Design of `index.mjs`

### 1. Startup
1. Load `.env` (tiny manual parser, no dependency).
2. Ensure `MEMORY.md` and `data/` exist.
3. If `--cli` flag → start REPL; otherwise start WhatsApp.

### 2. Memory
- `MEMORY.md` is plain markdown, e.g. bullet facts about the user.
- Read fresh on every message (so manual edits apply instantly).
- The model can write to memory through a simple convention: if its reply contains a line `REMEMBER: <fact>`, the app strips that line from the reply and appends `- <fact>` to `MEMORY.md`. (Keeps the file zero-tool and safe; no need for `--allow-all-tools`.)
- Optional commands handled locally, not sent to the model: `/memory` (show), `/forget <text>` (delete matching lines), `/reset` (clear chat history).

### 3. Prompt building
```
SYSTEM: You are larsclaw, a concise personal assistant replying in WhatsApp.
Keep answers short, plain text. To save a durable fact, add a line: REMEMBER: <fact>.

## Memory
<contents of MEMORY.md>

## Conversation
User: ...
Assistant: ...
User: <new message>
```

### 4. Copilot runner
```js
import { spawn } from 'node:child_process';
function askCopilot(prompt) {
  const args = ['-p', prompt, '--silent'];
  if (MODEL) args.push('--model', MODEL);
  if (ALLOW_TOOLS) args.push('--allow-all-tools');
  // spawn('copilot', args), collect stdout, enforce timeout, reject on non-zero exit
}
```
- Serialize requests per chat with a simple promise queue to avoid overlapping runs.
- Surface auth errors clearly ("run `copilot` and `/login`").

### 5. WhatsApp channel
- `makeWASocket` with `useMultiFileAuthState('data/auth')`; print QR via `qrcode-terminal` on first run.
- Auto-reconnect unless logged out (`DisconnectReason.loggedOut`).
- On `messages.upsert` (type `notify`):
  - ignore own messages, status broadcasts, non-text
  - enforce `ALLOWED_NUMBERS`
  - in groups require `TRIGGER`
  - send "composing" presence → run pipeline → `sock.sendMessage(jid, { text })`
- Split replies > ~4000 chars.

### 6. Pipeline (shared by WhatsApp and REPL)
```
handle(chatId, text):
  if local command → run it
  history.push(user)
  reply = await askCopilot(buildPrompt(chatId))
  reply = extractAndSaveMemory(reply)
  history.push(assistant); persist
  return reply
```

## Build steps
1. `npm init -y`; set `"type": "module"`.
2. `npm i @whiskeysockets/baileys qrcode-terminal pino`
3. Write `index.mjs` following sections above (~200 lines).
4. `node index.mjs --cli` – verify Copilot round trip and memory writing.
5. `ALLOWED_NUMBERS=491701234567 node index.mjs` – scan QR (WhatsApp → Linked devices), send a message.
6. Optional: run under `pm2` / `systemd` for always-on.

## Security notes
- Always set `ALLOWED_NUMBERS`; otherwise anyone who messages the linked number can use your Copilot quota.
- Keep `ALLOW_TOOLS=false` unless you trust every allowed sender – it lets the model run shell commands.
- `data/auth/` grants access to your WhatsApp account; never commit it (add `data/` and `.env` to `.gitignore`).
- Baileys is an unofficial WhatsApp client; use a secondary number if concerned about bans.

## Possible later extras
- Scheduled tasks (`/every 1h <prompt>`), per-chat memory files, voice-note transcription, Telegram channel, MCP servers via Copilot CLI config.
