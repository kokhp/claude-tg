# claude-tg — Claude Code CLI to Telegram Bridge

Control Claude Code CLI from your phone via Telegram — approve permissions, answer interactive questions, reply to idle sessions, and send files.

If you run Claude CLI and step away from your machine, it stalls whenever it needs tool permission or asks a question. This bridge sends everything to Telegram so you can keep Claude working remotely.

```
  Claude CLI (any terminal)          Daemon (background)
  ┌─────────────────────┐           ┌─────────────────────┐
  │ PermissionRequest   │──HTTP──>  │ Telegram Bot        │──> Your Phone
  │ hook (blocking)     │<─────────│ HTTP Server (:7483) │<── (Telegram App)
  └─────────────────────┘           └─────────────────────┘

  Notification hook ──async HTTP──> Daemon ──> Telegram alert
                                             <── You reply with text
                                   Daemon ──> Types into terminal via osascript
```

Uses Claude Code's native [hooks system](https://docs.anthropic.com/en/docs/claude-code/hooks) — installs into `~/.claude/settings.json` and applies to all Claude instances automatically. No PTY wrappers or hacks.

## Features

- **Remote permission approval** — Allow, Deny, or Always Allow tool calls from Telegram inline buttons
- **Interactive questions** — When Claude uses `AskUserQuestion`, you see the actual options as Telegram buttons — pick answers, type custom responses, review a summary, then confirm or redo
- **Rich context** — Each message shows the session number, project name, original task, what Claude was doing, and the exact tool/command
- **Multi-session support** — Sessions are labeled #1, #2, #3... and persist as long as the terminal is open
- **Idle notifications** — Get alerted when Claude is waiting for your input, with its last message shown
- **Reply from Telegram** — Swipe-reply to a notification to send text input to the correct terminal (macOS)
- **Concurrent session routing** — Reply-to targets a specific session; auto-routes when only one is idle
- **Send messages & files** — Tell Claude "send this to my telegram" and it sends text, images, videos, documents, audio
- **Smart file handling** — Images display as photos, videos play inline, audio streams — not just generic document attachments
- **Graceful fallback** — If the daemon isn't running, hooks exit silently and Claude shows the normal local dialog

## Install

```bash
npm install -g claude-tg
```

## Setup

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 2. Run Setup

```bash
claude-tg setup
```

This will:
- Ask for your bot token (validates it against the Telegram API)
- Capture your chat ID (send `/start` to your bot when prompted)
- Install hooks into `~/.claude/settings.json` (merges with existing config)
- Save config to `~/.claude-telegram-bridge/config.json`
- Send a test message to your Telegram

### 3. Start the Daemon

```bash
claude-tg daemon start
```

That's it. Use `claude` as normal — permission prompts and questions now go to Telegram.

## Usage

### Permission Requests

When Claude needs tool permission, you get a Telegram message:

```
📋  #2 my-project
━━━━━━━━━━━━━━━━━━━━
📝 Task: implement user authentication with JWT
💭 Doing: Let me install the jsonwebtoken package...

🔧 Bash
npm install jsonwebtoken

[Allow]  [Deny]  [Always Allow]
```

- **Allow** — permits this one tool call
- **Deny** — blocks the tool call
- **Always Allow** — permits and adds a rule so future calls of this type don't ask

### Interactive Questions

When Claude asks you questions (via `AskUserQuestion`), you see the actual options as buttons:

```
💬  #2 my-project — Claude has a question
━━━━━━━━━━━━━━━━━━━━
📝 Task: build a web app

❓ [1/2] Which auth approach?

• NextAuth.js: Built-in Next.js auth solution
• Clerk: Managed auth service
• Supabase Auth: Open-source auth

[NextAuth.js]  [Clerk]
[Supabase Auth]  [✏️ Custom]
```

- Tap an option to select it and move to the next question
- Tap **Custom** to type a free-text answer
- For multi-select questions, tap multiple options then **Next**
- After all questions, review your answers and tap **Confirm** or **Redo**

Your answers are automatically injected into the terminal via keystrokes.

### Idle Notifications

When Claude finishes and waits for input:

```
⏳  #2 my-project — Claude is idle
━━━━━━━━━━━━━━━━━━━━
📝 Task: implement user authentication with JWT
💬 Claude said:
I've set up the JWT middleware. What would you like me to work on next?

↩️ Reply to this message to send input
```

**Swipe-reply** to this message in Telegram with your next instruction — it gets typed into the correct terminal and submitted.

### Multiple Sessions

Each Claude session gets a persistent label (#1, #2, #3...) that lasts as long as the terminal stays open. When multiple sessions are idle and you send a plain message, the bot asks you to reply to a specific notification:

```
Multiple sessions are waiting. Reply to a specific notification message to choose:

  #1 saas-factory
  #3 ml-pipeline
```

If only one session is idle, your text is auto-routed.

### Sending Messages & Files

Tell Claude "send this to my telegram" or "send this file to my telegram". It uses these commands:

```bash
# Send a text message
claude-tg send "Here's the summary you asked for..."

# Send a file (images, videos, audio, documents)
claude-tg send-file ./screenshot.png "Latest UI"
claude-tg send-file ./demo.mp4 "Feature demo"
claude-tg send-file ./report.pdf "Monthly report"

# Pipe content from stdin
echo "hello" | claude-tg send -
```

These work independently of the daemon — they hit the Telegram API directly.

Files are sent using the correct Telegram method based on type:
| Extension | Sent as |
|---|---|
| `.jpg` `.jpeg` `.png` `.webp` | Photo (with preview) |
| `.mp4` `.mov` `.avi` `.mkv` `.webm` | Video (plays inline) |
| `.gif` | Animation |
| `.mp3` `.ogg` `.wav` `.flac` `.m4a` `.aac` | Audio (streams) |
| Everything else | Document |

For long text (>4096 chars), `claude-tg send` automatically sends it as a `.md` document.

### Bot Commands

- `/status` — list active sessions, pending permissions, and pending questions
- `/start` — register chat ID (used during setup)

## CLI Reference

```
claude-tg setup              # Interactive setup
claude-tg daemon start       # Start background daemon
claude-tg daemon stop        # Stop daemon
claude-tg daemon status      # Check daemon status + pending requests
claude-tg daemon logs        # Tail daemon logs
claude-tg send <text>        # Send text message (use "-" for stdin)
claude-tg send-file <path>   # Send a file (optional caption as 2nd arg)
claude-tg uninstall          # Remove hooks from ~/.claude/settings.json
```

## How It Works

### Hooks

Claude Code supports [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) — shell commands that run in response to lifecycle events. Two hooks are installed:

**PermissionRequest** (blocking) — Fires when Claude needs tool permission. The hook:
1. Reads the hook input from stdin (session ID, tool name, tool input, transcript path)
2. Detects the parent Claude process's TTY (for reply routing)
3. POSTs to the local daemon
4. Blocks until the daemon responds (which waits for your Telegram tap)
5. Returns the decision as JSON to stdout

When `AskUserQuestion` is the tool, the daemon shows the actual questions as Telegram buttons instead of Allow/Deny. After you answer, it allows the tool and injects your selections into the terminal.

**Notification** (async) — Fires on `idle_prompt` and `elicitation_dialog`. The hook:
1. Reads the hook input from stdin
2. Detects the parent TTY
3. Fire-and-forget POST to the daemon
4. Exits immediately

### Daemon

A single background process on `localhost:7483`. Runs a Telegram bot (via telegraf) and an HTTP server.

- `POST /api/permission` — Holds the HTTP connection open until you respond on Telegram
- `POST /api/notify` — Sends an alert and stores the session for reply routing
- `GET /api/health` — Health check with pending count

### Session Tracking

Sessions are tracked by their `session_id` from Claude Code. Each session's TTY path is detected by walking the process tree. Sessions persist as long as the TTY has active processes — they don't expire on a timer.

### Reply Injection (macOS)

When you reply to a notification from Telegram, the daemon uses `osascript` to type your text into the correct terminal:

- **iTerm2** — Uses `write text` on the session matched by TTY path. Works without bringing the window to front.
- **Terminal.app** — Finds the tab by TTY, focuses it, then uses System Events to keystroke the text + press Return.

For interactive questions, the daemon injects the answer sequence using keyboard navigation (arrow keys, space, tab, enter).

### Graceful Degradation

If the daemon is not running:
- Hook scripts detect the connection failure and `exit 0` with no output
- Claude Code falls through to the normal local permission dialog
- Zero disruption — you just don't get Telegram notifications

## Project Structure

```
claude-tg/
├── bin/
│   └── claude-tg              # CLI entry point
├── src/
│   ├── config.js              # Read/write ~/.claude-telegram-bridge/config.json
│   ├── daemon.js              # Telegram bot + HTTP server + Telegraph + session tracking
│   ├── setup.js               # Interactive setup + hook installation
│   └── hooks/
│       ├── permission-request.js   # Blocking PermissionRequest hook
│       ├── stop.js                 # Stop notification hook
│       └── notification.js         # Async Notification hook
├── package.json
└── README.md
```

**Config directory:** `~/.claude-telegram-bridge/`
- `config.json` — bot token, chat ID, port
- `daemon.pid` — PID of running daemon
- `daemon.log` — daemon logs

## Limitations

- **Reply from Telegram** requires macOS with Terminal.app or iTerm2. On Linux or other terminals, you'll see notifications but need to respond in the terminal.
- **Interactive question injection** uses AppleScript keystrokes — requires the terminal to be accessible (not locked screen).
- **Session labels reset** when the daemon restarts (#1, #2... start over).
- **30-minute timeout** on permission requests. If you don't respond, the hook exits and Claude shows the local dialog.

## Uninstalling

```bash
claude-tg daemon stop
claude-tg uninstall
npm uninstall -g claude-tg
rm -rf ~/.claude-telegram-bridge
```

## License

MIT
