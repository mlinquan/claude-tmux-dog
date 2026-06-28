# claude-tmux-dog (`cdog`)

<p align="center"><img src="assets/avator_dog_500.png" width="500" alt="cdog"></p>

> [![npm version](https://img.shields.io/npm/v/claude-tmux-dog.svg?logo=npm)](https://www.npmjs.com/package/claude-tmux-dog)
> [![npm downloads](https://img.shields.io/npm/dm/claude-tmux-dog.svg?logo=npm)](https://www.npmjs.com/package/claude-tmux-dog)
> [![license](https://img.shields.io/npm/l/claude-tmux-dog.svg)](https://github.com/SnowAIGirl/claude-tmux-dog/blob/main/LICENSE)
> [![GitHub](https://img.shields.io/badge/GitHub-SnowAIGirl%2Fclaude--tmux--dog-blue?logo=github)](https://github.com/SnowAIGirl/claude-tmux-dog)
>
> English | [中文](README_CN.md)

**24/7 unattended Claude agents + tmux-native message bus.**

cdog does two things:

1. **24/7 unattended operation** — Hook-driven lifecycle management + dual-layer context defense keeps a Claude Code agent running autonomously for days or weeks
2. **tmux-native message bus** — Each agent runs in its own tmux session; `cdog message send` injects text into the pane — that's all you need for cross-agent communication

No message broker, no external daemon framework — tmux IS the bus.

***

## Why cdog

### Pillar 1 — 24/7 Unattended Operation

cdog turns Claude Code into an autonomous agent that runs for days without human intervention:

- **Auto-nudge** — Every time Claude stops (fires `Stop` hook), cdog automatically sends "continue" (or your custom prompt) to keep it working
- **Auto-recovery** — On recoverable API errors (rate limit, timeout, overloaded), cdog breaks to shell, checks token usage, and either runs `/compact` or nudges
- **Proactive compaction** — Pane watcher monitors `↑ tokens` in the TUI and compacts at 80% *before* errors happen
- **Quota-aware** — Detects `AccountQuotaExceeded` with reset time, breaks to shell, and schedules a nudge after the reset
- **Auto-shutdown** — Set `per_watch_duration: "7d"` and cdog will mark the agent `completed` after 7 days, kill watchers, but keep the tmux session alive (context preserved)
- **Suspend on fatal** — Fatal errors (model offline, auth, billing) suspend the agent (stop monitoring, keep tmux/claude alive) for you to inspect, then `cdog restart` resumes. Recoverable errors never hard-fail: they self-heal via claude's retry or are probed by the `stall_timeout` health-check (default 5m)

**How it works:** Claude Code hooks (`Stop` / `StopFailure` / `SessionStart` / `SessionEnd`) push events to cdog. No polling, no timers, no filesystem watchers — pure event-driven lifecycle management.

### Pillar 2 — tmux-Native Message Bus

Each agent runs in its own tmux session. `cdog message send` injects text directly into the pane — that's all you need for cross-agent communication:

```bash
# Agent snow asks agent hermes about progress
cdog message send --to hermes --message "What's the progress on port-map?" --from "snow-agent"

# Agent hermes replies
cdog message send --to snow-agent --message "Backend is done, 3 files merged" --from "hermes"
```

Output in hermes's pane:

```
snow-agent: What's the progress on port-map?
```

**Reply chains** — Use `--reply-method` to tell the recipient how to respond:

```bash
cdog message send --to hermes \
  --message "Check what bugs are left" \
  --from "snow-agent" \
  --reply-method "cdog message send --to snow-agent --message 'Found N' --from hermes"
```

Output:

```
snow-agent: Check what bugs are left
Reply Method: cdog message send --to snow-agent --message 'Found N' --from hermes
```

No message broker. No external daemon. tmux IS the bus.

***

## Quick Start

```bash
# Install
npm install claude-tmux-dog -g

# One-time setup (wires hooks into ~/.claude/settings.json)
cdog init

# Create a config
cat > cdog.json << 'EOF'
{
  "name": "my-agent",
  "cwd": "/path/to/project",
  "md": "task.md",
  "watchdog": {
    "auto_nudge_stop": true,
    "per_watch_duration": "7d",
    "max_tokens": "1m"
  }
}
EOF

# Start
cdog start

# Check status
cdog status

# View logs
cdog log
```

That's it — your agent is now running 24/7 in a tmux session, auto-nudging on stops, auto-recovering from errors, auto-compacting before context overflows.

***

## How It Works

1. **`cdog start`** reads `cdog.json`, spawns `claude` inside a detached tmux session with a UUID `--session-id`, and starts two watcher subprocesses (pane + log)
2. **Hooks push events** — `Stop` / `StopFailure` / `SessionStart` / `SessionEnd` hooks call `cdog notify <json>`
3. **cdog dispatches**:
   - `Stop` → auto-nudge (if enabled)
   - `StopFailure` → classify error → auto-recover (if recoverable) or stop (if fatal)
   - `SessionStart` → mark `running`
   - `SessionEnd` → mark `stopped`/`failed`
4. **Dual-layer watchers**:
   - **Pane watcher** (proactive): monitors `↑ tokens`, compacts at 80%
   - **Log watcher** (reactive): tails debug log, triggers recovery on API error threshold
5. **`cdog stop`** flips cdog to `detached` and (by default) Esc-aborts the in-progress turn; **`cdog drain`** detaches without interrupting. Neither kills claude — detached cdog still records status from hooks (observe-only). **`cdog delete`** is the only command that kills the tmux session

***

## What cdog Automates For You

| Feature               | What it does                                               | Why it matters                                  |
| --------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| **Auto-nudge**        | Sends prompt on every Stop hook                            | Agent keeps working without human nudging       |
| **Auto-recovery**     | Breaks to shell + compact-or-nudge on API errors           | Recovers from transient failures automatically  |
| **Proactive compact** | Monitors tokens, compacts at 80%                           | Prevents API errors before they happen          |
| **Quota scheduling**  | Detects reset time, schedules nudge after quota resets     | No wasted retries while quota is zero           |
| **Stall detection**   | No real activity for `stall_timeout` (default 5m) → nudge  | Breaks stuck loops + 5xx health-check           |
| **Auto-shutdown**     | Marks `completed` after N days, kills watchers, keeps tmux | Long-running tasks eventually stop nudging      |
| **Message bus**       | Send text to any agent's pane                              | Cross-agent coordination without infrastructure |

***

## Configuration

### Minimal `cdog.json`

```json
{
  "name": "my-agent",
  "cwd": "/path/to/project"
}
```

### Full `cdog.json`

```json
{
  "name": "snow-agent",
  "cwd": "/path/to/projects/snow-agent",
  "md": "snow-agent.md",
  "args": ["--dangerously-skip-permissions"],
  "log": "./logs/claude-debug.log",
  "log_file": "./logs/cdog.log",
  "model": "claude-sonnet-4-6",
  "timeformat": "YYYY-MM-DD HH:mm:ss",
  "timeout": 10000,
  "watchdog": {
    "prompt": "continue",
    "per_watch_duration": "7d",
    "max_tokens": "1m",
    "auto_nudge_stop": true,
    "auto_restart": true,
    "stall_timeout": "5m",
    "api_error_auto_compact": {
      "threshold": 3,
      "rate_limit_confirm_minutes": 10
    },
    "pane_watcher": {
      "compact_ratio": 0.8,
      "interval": 30
    }
  },
  "notify": {
    "enabled": true,
    "lang": "default",
    "sound": true,
    "sound_on": {
      "agent-started": true,
      "agent-failed": true,
      "agent-recovered": true,
      "api-error": false,
      "compact": false,
      "max-run-reached": true,
      "nudge": false,
      "task-completed": true
    },
    "open_on_click": true,
    "terminal": "Terminal",
    "command": null,
    "command_timeout": 30,
    "on": {
      "agent-started": true,
      "agent-failed": true,
      "agent-recovered": true,
      "api-error": true,
      "compact": true,
      "max-run-reached": true,
      "nudge": true,
      "task-completed": true
    }
  }
}
```

### Key Fields

| Field      | Required | Description                                                                                                                                                                                    |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | ✓        | Agent name (unique, cannot be `all`)                                                                                                                                                           |
| `cwd`      | ✓        | Working directory (tmux session created here)                                                                                                                                                  |
| `md`       | <br />   | Task markdown file(s) piped to claude on start                                                                                                                                                 |
| `args`     | <br />   | Extra CLI flags for claude                                                                                                                                                                     |
| `env`      | <br />   | Env vars injected into the launched claude process, e.g. `{"DISABLE_TELEMETRY": "1", "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY": "1"}`. Prefixed as `K=V` before `claude` (applies to claude only). |
| `log`      | <br />   | Claude debug log path (default: `<cwd>/logs/claude-debug.log`)                                                                                                                                 |
| `log_file` | <br />   | cdog operation log path                                                                                                                                                                        |
| `watchdog` | <br />   | Auto-management policy                                                                                                                                                                         |
| `notify`   | <br />   | Desktop notification settings                                                                                                                                                                  |
| `stop`     | <br />   | `cdog stop` behavior                                                                                                                                                                           |

### Stop Configuration

| Field        | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abort_work` | `true`  | On `cdog stop`, when claude is actively working (running/pending), send a single **Esc** to abort the in-progress turn and set status to `waiting` — the claude **process stays alive** (suspend, don't exit). Esc is used instead of `Ctrl+C` so the process can't be accidentally exited; `Ctrl+C` stays reserved for the recovery flow. No-op when claude is idle or the tmux session is gone. Default `true` (`stop` means halt); set `false` to detach without interrupting the current turn. |

```json
{
  "name": "my-agent",
  "cwd": ".",
  "stop": { "abort_work": true }
}
```

### Watchdog Configuration

| Field                    | Default      | Description                                                                                                    |
| ------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------- |
| `prompt`                 | `"continue"` | Text sent on each nudge                                                                                        |
| `per_watch_duration`     | <br />       | Monitor duration (e.g. `"7d"`, `"4h"`). After this, agent marked `completed`, watchers killed, tmux kept alive |
| `max_tokens`             | `200000`     | Max context tokens (`200000`, `"200k"`, `"1m"`)                                                                |
| `auto_nudge_stop`        | `false`      | Auto-send prompt on Stop hook                                                                                  |
| `auto_restart`           | `true`       | Auto-recover on recoverable StopFailure; fatal errors suspend (keep tmux, wait for `cdog restart`)             |
| `stall_timeout`          | `"5m"`       | No real activity (stream/tool) for this long → nudge. Doubles as the 5xx/overloaded health-check interval      |
| `stall_cooldown`         | `"10m"`      | Cooldown after stall-triggered nudge                                                                           |
| `api_error_auto_compact` | <br />       | Log watcher config (always enabled)                                                                            |
| `pane_watcher`           | <br />       | Pane watcher config (always enabled)                                                                           |

### Log Retention & Update Check

| Field / Env                    | Default | Description                                                                                                                                                                                |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `log_retention` (config)       | `"7d"`  | cdog trims its **own** op-log to this window on `cdog start` and `cdog prune` (by per-line timestamp). claude's debug log is left to claude. `"0"`/`"off"` disables.                       |
| `CDOG_NO_UPDATE_CHECK=1` (env) | off     | cdog checks the npm registry for a newer version once per day (cached in `~/.cdog/update-check.json`) and prints a non-blocking hint to stderr. Set this env to mute. Never auto-installs. |

***

## Recovery Details

cdog has three recovery paths, all sharing the same `breakToShell` + `compactOrNudge` logic:

### 1. Hook-Driven (StopFailure)

When Claude Code hits an API error, it fires `StopFailure` hook → cdog:

1. Classifies error: `fatal` / `timeout` / `provider` / `rate_limit` / `unknown`
2. If recoverable: types `cdog-recover` marker, sends Ctrl-C, checks marker survived, then runs `compactOrNudge`
3. Compact decision: reads `last_up_tokens` from state → `/compact` if ≥ 80%, else nudge

### 2. Log-Watcher-Driven (API Error Threshold)

Log watcher tails the debug log, counts consecutive `[ERROR] API error` lines per kind:

| Kind         | Threshold | Action                                                 |
| ------------ | --------- | ------------------------------------------------------ |
| `fatal`      | immediate | Stop agent (auth failure, model not found)             |
| `timeout`    | 6         | Compact-or-nudge                                       |
| `provider`   | never     | Let claude retry (model overloaded, 503)               |
| `rate_limit` | never     | Break to shell + scheduled nudge if reset time present |
| `unknown`    | 3         | Compact-or-nudge                                       |

**Fast-path:** if pane watcher recorded `last_up_tokens ≥ 70%`, threshold → 1.

### 3. Pane-Watcher-Driven (Proactive Compaction)

Monitors `↑ tokens` in the TUI. When tokens reach 80% of `max_tokens`:

```
↑ 165k tokens (82% of 200k)
↓
send /compact
↓ (wait for PostCompact hook)
PostCompact fires → send prompt nudge
```

### Marker Safety

All three paths use the `cdog-recover` marker technique:

```
1. Type "cdog-recover" (no Enter — stays on input line)
2. Send C-c
3. Check if marker survived in pane capture
   ├─ Marker survived → C-c took effect, clear with C-u
   └─ Marker lost → C-c cleared input line, safe to proceed
```

This prevents C-c from killing the wrong process.

***

## Commands

| Command                                                                        | Description                                                                                    |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `cdog start [config\|all]`                                                     | Start agent(s). Auto-runs `cdog init` if hooks missing                                         |
| `cdog stop <name\|all>`                                                        | Detach cdog + Esc-abort in-progress turn (default). Claude → `waiting`, stays alive            |
| `cdog drain <name\|all>`                                                       | Detach cdog **without interrupting** — current turn finishes, then idles                       |
| `cdog restart <name\|all>`                                                     | Re-watch detached agent. Respawns watchers; kicks if idle                                      |
| `cdog delete <name\|all>`                                                      | Kill tmux session + remove from state                                                          |
| `cdog status [name]`                                                           | pm2-style table or detail view                                                                 |
| `cdog log [name] [--all\|--cdog\|--claude] [--err]`                            | Tail logs. `--err` = last N `[ERROR]` lines across whole log                                   |
| `cdog message send --to <name> --message <text> [--from F] [--reply-method R]` | Send message to agent                                                                          |
| `cdog nudge <name\|all> [text]`                                                | Send prompt + Enter                                                                            |
| `cdog compact <name>`                                                          | Manually trigger compact-or-nudge                                                              |
| `cdog auto-nudge <enable\|disable> <name\|all>`                                | Toggle auto-nudge (persistent)                                                                 |
| `cdog prune [name\|all]`                                                       | Trim cdog's own op-log to `log_retention` (default 7d) + clean `~/.cdog`. Auto-runs on `start` |
| `cdog init`                                                                    | Install hooks into `~/.claude/settings.json`                                                   |
| `cdog --version` / `-v`                                                        | Print version                                                                                  |

### Dual-Track Status

cdog tracks two independent statuses:

- **claude** (hook-driven): `running` / `waiting` / `pending` / `failed` / `completed` / `stopped` — `UserPromptSubmit`→`running` (turn start), `Stop`→`running`/`waiting`, `StopFailure`→`failed`, `SessionEnd`→`stopped`/`failed`
- **cdog** (command-driven): `watching` / `detached`

`watching` = cdog auto-nudges/recovers. `detached` = hands-off (no nudge/recover) but still records claude status from hooks (observe-only). `cdog stop`/`drain` → detached; `cdog delete` kills tmux.

***

## Message Relaying

```bash
# Simple message
cdog message send --to snow-agent --message "Keep going" --from "human"
# Output: human: Keep going

# With reply method
cdog message send --to hermes --message "How's progress?" --from "snow-agent" \
  --reply-method "cdog message send --to snow-agent --message '50% done' --from hermes"
# Output:
# snow-agent: How's progress?
# Reply Method: cdog message send --to snow-agent --message '50% done' --from hermes
```

Formatting is purely concatenative — cdog never modifies the text.

***

## Desktop Notifications

Optional macOS Notification Center alerts:

```json
"notify": {
  "enabled": true,
  "lang": "default",
  "sound": true,
  "open_on_click": true,
  "terminal": "Terminal",
  "on": {
    "agent-failed": true,
    "task-completed": true
  }
}
```

- `enabled`: Master switch. `false` (default) → no notifications at all. `true` → each event fires unless turned off in `on`.
- `sound`: Master sound switch. `false` (default) → silent. `true` → each event plays sound unless muted in `sound_on` (chatty events `api-error`/`nudge`/`compact` default to silent).
- `sound_on`: Per-event sound override. `true` → always play, `false` → never play, unlisted → follow `sound` default (chatty events silent). Example: `"sound_on": { "nudge": true, "agent-failed": false }`.
- `on`: Per-event notification override. `true` → notify, `false` → skip, unlisted → notify (all on by default).
- `command`: Shell command run alongside each enabled notification (webhook / chat client / your script). Context via env (`CDOG_AGENT`/`CDOG_EVENT`/`CDOG_TITLE`/`CDOG_MESSAGE`), never interpolated into the command string. See [Custom notify command](#custom-notify-command) below for examples.
- `command_timeout`: Seconds before a running `command` is killed. Default 30.
- `open_on_click`: Click notification → open/focus tmux session
- `lang`: `"default"` (English) or `"zh"` (Chinese)
- `terminal`: Terminal app for click-to-open (macOS: `"Terminal"`, `"iTerm2"`, `"Ghostty"`, etc.; Linux: `"gnome-terminal"`, `"konsole"`, etc.)

**Notification events** (set in `on`; unlisted default to `true`):

| Event             | Fires when                                                                | Sound\*    |
| ----------------- | ------------------------------------------------------------------------- | ---------- |
| `agent-started`   | Agent launched via `cdog start`                                           | ✅          |
| `agent-failed`    | Fatal error → agent suspended (model offline / auth / billing)            | ✅          |
| `agent-recovered` | Agent recovered after a StopFailure / quota reset / compact               | ✅          |
| `api-error`       | Any `[ERROR] API error` line in claude's debug log                        | ❌ (chatty) |
| `compact`         | Context compacted (proactive 80%, auto-recover, or manual `cdog compact`) | ❌ (chatty) |
| `max-run-reached` | `per_watch_duration` reached → agent marked `completed`                   | ✅          |
| `nudge`           | Agent nudged (Stop hook auto-nudge, stall health-check, quota reset)      | ❌ (chatty) |
| `task-completed`  | Agent finished its task                                                   | ✅          |

\* Sound defaults below assume master `sound: true`. `sound_on` overrides per event (see config table). Chatty events (`api-error`/`nudge`/`compact`) default to silent so a 24/7 agent doesn't beep all night; set them `true` in `sound_on` if you want them audible.

### Custom notify command

`notify.command` runs a shell command alongside each enabled notification — fan
events out to a chat client, webhook, or your own script. It runs via `sh -c`, so
inline commands and script paths both work. Context is passed as **env vars**
(preferred) and positional args, never interpolated into the command string, so
message text can't break the command:

- ENV: `CDOG_AGENT` `CDOG_EVENT` `CDOG_TITLE` `CDOG_MESSAGE`
- ARGS: `$1`=agent `$2`=event `$3`=title `$4`=message

Best-effort: a failing or timing-out command (default 30s, override with
`command_timeout`) is logged and never breaks cdog.

```jsonc
"notify": {
  "enabled": true,
  "on": { "agent-failed": true, "task-completed": true },
  "command": "curl -s \"https://api.telegram.org/bot$TG_TOKEN/sendMessage\" -d chat_id=\"$TG_CHAT\" -d text=\"[$CDOG_AGENT] $CDOG_EVENT: $CDOG_MESSAGE\""
}
```

```jsonc
// Send to a chat client via a natural-language command
"notify": {
  "enabled": true,
  "command": "hermes chat -q \"send \\\"$CDOG_MESSAGE\\\" to my telegram\" -Q"
}
```

```jsonc
// Route to a specific chat/user id
"notify": {
  "enabled": true,
  "command": "openclaw channel send --target 123456 --message \"$CDOG_MESSAGE\""
}
```

```jsonc
// Or just run a script (passing the same env + args)
"notify": {
  "enabled": true,
  "command": "/Users/me/cdog-on-event.sh"
}
```

***

## Caveats

- **tmux required** — cdog manages sessions inside tmux
- **macOS notifications** — Interactive notifications use macOS Notification Center. Linux falls back to plain notify-send
- **Hook-based** — Hooks must be installed via `cdog init`. Without them, auto-nudge/recover won't work
- **Watcher subprocesses** — `cdog start` spawns pane watcher + log watcher as detached children. They're killed on stop/delete/restart via process-group signaling
- **No circuit breaker** — Recoverable errors (5xx, overloaded, timeout, unknown) no longer hard-fail after N retries. They self-heal via claude's own retry, get `/compact`'d on context-full, or are probed by the `stall_timeout` health-check (default 5m). Only fatal errors (model offline / auth / billing) suspend the agent

***

## Build from Source

```bash
npm install
npm run build      # tsc -> dist/
npm run dev        # run via tsx without building
```

***

## Skill Integration

This repo includes a skill at `skills/cdog/`. When `claude-tmux-dog` is installed globally, any AI agent can load this skill to manage cdog agents without leaving the conversation.

***

## Author

[SnowAIGirl](https://github.com/SnowAIGirl) & [LinQuan](https://github.com/mlinquan)

## License

[MIT](LICENSE)
