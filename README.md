# larsclaw

A super simple OpenClaw-style personal assistant in a single file (`index.mjs`).
WhatsApp in → GitHub Copilot CLI as the brain → reply out. Includes a markdown memory file and scheduled "heartbeat" tasks.

## Requirements
- Node.js ≥ 20
- [GitHub Copilot CLI](https://github.com/github/copilot-cli) installed and logged in (`npm i -g @github/copilot`, run `copilot`, then `/login`)
- An active Copilot subscription

## Setup
```bash
npm install
echo "ALLOWED_NUMBERS=46701234567" > .env   # your number, digits only, with country code
node index.mjs                                # scan the QR: WhatsApp → Linked devices
```
The WhatsApp session is stored in `data/auth`, so you only scan once.

## Modes
| Command | What it does |
|---|---|
| `node index.mjs` | WhatsApp mode |
| `node index.mjs --cli` | Terminal chat, no WhatsApp (for testing) |
| `npm run dev` / `--watch` | Hot deploy: restarts when `index.mjs` or `.env` changes |

All messages in (`<<`) and out (`>>`) are logged to the console.

## Chat commands
| Command | Description |
|---|---|
| `/help` | List commands |
| `/memory` | Show memory |
| `/forget <text>` | Delete memory lines containing text |
| `/reset` | Clear this chat's history |
| `/heartbeat <interval> <task>` | Run a task repeatedly, e.g. `/heartbeat 1h summarize the news` (min 1m; `m`, `h`, `d`) |
| `/heartbeats` | List heartbeats |
| `/stop <id>` | Delete a heartbeat |

You can also ask in plain language ("every morning check the weather in Oslo"); the model creates the heartbeat itself.

## Memory
`MEMORY.md` is plain markdown, read on every message and editable by hand. The model saves facts by replying with a `REMEMBER: <fact>` line, which is stripped from the reply and appended to the file. It is git-ignored.

## Heartbeats
Scheduled prompts saved in `data/heartbeats.json`. They survive restarts and send their result (prefixed with ⏰) to the chat that created them.

## Configuration
Set via environment variables or `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `ALLOWED_NUMBERS` | *(required)* | Comma-separated numbers allowed to use the bot |
| `COPILOT_MODEL` | CLI default | Passed as `--model` |
| `TRIGGER` | `@bot` | Prefix required in group chats (DMs always answer) |
| `HISTORY_LIMIT` | `20` | Messages kept per chat |
| `COPILOT_TIMEOUT_MS` | `120000` | Kill runaway Copilot runs |
| `ALLOW_URLS` | `true` | Let Copilot fetch web pages (`--allow-all-urls`) |
| `ALLOW_TOOLS` | `false` | Let Copilot run shell/file tools (`--allow-all-tools`) – dangerous |

## Security
- Always set `ALLOWED_NUMBERS`, otherwise anyone who can message the linked number uses your Copilot quota.
- Keep `ALLOW_TOOLS=false` unless you fully trust every allowed sender.
- `data/auth/` gives access to your WhatsApp account; `data/`, `.env` and `MEMORY.md` are git-ignored.
- Baileys is an unofficial WhatsApp client; consider a secondary number.

## Files
```
index.mjs      # everything
package.json
MEMORY.md      # long-term memory (auto-created)
data/          # WhatsApp session, chat history, heartbeats
.env           # optional config
```
