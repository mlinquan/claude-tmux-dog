# claude-tmux-dog (`cdog`)

<p align="center"><img src="assets/avator_dog_500.png" width="500" alt="cdog"></p>

> [![GitHub](https://img.shields.io/badge/GitHub-SnowAIGirl%2Fclaude--tmux--dog-blue?logo=github)](https://github.com/SnowAIGirl/claude-tmux-dog)
> English | [中文](README_CN.md)

A Claude Code process manager and inter-agent message bus. Starts long-running Claude Code agents inside tmux sessions, driven by Claude Code's **Hook** mechanism for event-driven lifecycle management. Spawns background **watcher daemons** for autonomous context defense and API error recovery. Built-in **message relay** lets agents talk to each other across sessions — no message broker, no external daemon framework needed. Runs 24/7 unattended with auto-nudge, auto-recovery, and dual-layer context compaction.

## Key Advantages

| # | Advantage | Detail |
|---|-----------|--------|
| 1 | **Zero-polling** | Claude Code hooks (`Stop` / `StopFailure` / `SessionStart` / `SessionEnd`) push events to cdog. No loop, no timer, no filesystem watcher |
| 2 | **Dual-track status** | Independent statuses for the Claude process (hook-driven: `running` / `waiting` / `pending` / `failed` / `completed`) and cdog monitoring (command-driven: `watching` / `detached`). `cdog stop` never kills the process |
| 3 | **Auto-nudge** | On every `Stop` hook, auto-send a configurable prompt (e.g. `"continue"`) so the agent keeps working autonomously — like a hands-free loop |
| 4 | **Auto-recovery** | On recoverable `StopFailure` (rate limit, overloaded, timeout, server error), runs a **cdog-recover** flow: Ctrl-C + `compactOrNudge` (compact if context ≥ 80%, else nudge). Circuit breaker trips after 3 failures in 5 minutes |
| 5 | **Dual-layer context defense** | **Pane watcher** (proactive): monitors `↑ tokens` in the tmux pane via `pipe-pane`, compacts at 80% before errors happen. **Log watcher** (reactive): tails the claude debug log, classifies API errors by type, triggers compact-or-nudge on threshold. Compact completion detected via `PostCompact` hook — no hardcoded delays |
| 6 | **API error classification** | Errors are classified as `fatal` / `timeout` / `provider` / `rate_limit` / `unknown` with per-kind thresholds. `fatal` (model offline, auth failure) stops the agent immediately. `overloaded_error` → provider (not context). Provider errors never compact — they let claude retry. Rate limit with reset time → breakToShell + scheduled nudge |
| 7 | **State sharing** | Pane watcher records `last_up_tokens` to state; log watcher reads it on the first API error for a fast-path (threshold → 1 if tokens ≥ 70% of max) |
| 8 | **Message relaying** | `cdog message send` sends arbitrary text to a running agent's tmux pane, with optional `--from` attribution and `--reply-method` for building reply chains |
| 9 | **Auto-shutdown** | `per_watch_duration` stores a deadline timestamp; each start/restart resets it. When reached (checked on `Stop`/`SessionEnd` hooks), the agent is marked `completed`, watchers killed, but **tmux is kept alive** (claude context preserved, no more nudging). No cron, no at — passive check on hook event |
| 10 | **Auto-init** | `cdog start` auto-runs `cdog init` if hooks are missing from `~/.claude/settings.json` (hooks can get reset by claude updates) |
| 11 | **Isolated tmux sessions** | Each agent gets its own tmux session, fully separated. tmux requires no daemonization — it survives parent process exit |
| 12 | **Built-in logging** | Optional agent-level operation logs and Claude debug logs, tailable via `cdog log` — merge cdog+claude (`--all`), pick one (`--cdog`/`--claude`), filter `[ERROR]` (`--err`) |
| 13 | **Bulk operations** | `cdog start/stop/restart/delete all` — one command acts on every registered agent. A single failure doesn't halt the rest |
|14 | **Desktop notifications** | Optional macOS Notification Center alerts with sounds (English or Chinese) for agent-started, failed, recovered, API-error, circuit-breaker, max-run-reached, nudge, and task-completed events |

## How it works

1. **cdog start** reads `cdog.json`, spawns `claude` inside a detached tmux session, and injects a UUID `--session-id`. If hooks are missing from `~/.claude/settings.json`, it auto-runs `cdog init` first
2. **Hooks push to cdog** — every time Claude fires `Stop`, `StopFailure`, `SessionStart`, or `SessionEnd`, the hook shell script calls `cdog notify <json>`
3. **cdog dispatches** — `Stop` → auto-nudge (if enabled); `StopFailure` → auto-recover (if enabled); `SessionStart` → mark `running`; `SessionEnd` → mark `stopped`/`failed`
4. **Dual-layer watchers** — `cdog start` also spawns two detached watcher subprocesses:
   - **Pane watcher** (proactive): uses `tmux pipe-pane` to stream pane output, parses `↑ X.Yk tokens` from claude's TUI status line, and compacts at 80% of `max_tokens` *before* errors happen. Falls back to `capture-pane` polling every 15s if `pipe-pane` is unavailable
   - **Log watcher** (reactive): `tail -f` the claude debug log, classifies `[ERROR] API error` lines by type, and triggers compact-or-nudge when the per-kind threshold is reached
5. **Command separation** — `cdog stop` does not kill Claude; it flips cdog to `detached` and ignores all hooks. `cdog restart` flips back to `watching`. Only `cdog delete` kills the tmux session
6. **Recovery flow** — on recoverable error, cdog types a `cdog-recover` marker, sends Ctrl-C, checks if the marker survived, then runs `compactOrNudge` (reads `last_up_tokens` from state → `/compact` if ≥ 80% of max, otherwise sends prompt nudge)

## Installation

```bash
# from npm
npm install claude-tmux-dog -g
# or
pnpm install claude-tmux-dog -g
# or
yarn global add claude-tmux-dog

# one-time setup: create ~/.cdog/ and wire hooks into ~/.claude/settings.json
cdog init
```

`cdog init` copies hook scripts to `~/.cdog/hooks/` and wires `Stop` / `StopFailure` / `SessionStart` / `SessionEnd` / `PreCompact` / `PostCompact` hook config into `~/.claude/settings.json` (a `.cdog.bak` backup is written first).

## Project config (`cdog.json`)

Place one in your project root:

```json
{
  "name": "snow-agent",
  "cwd": "/Users/linquan/works/snow-agent",
  "md": "snow-agent.md",
  "args": ["--dangerously-skip-permissions"],
  "log": "./logs/claude-debug.log",
  "log_file": "./logs/cdog.log",
  "model": "glm-5.2",
  "timeformat": "YYYY-MM-DD HH:mm:ss",
  "timeout": 10000,
  "watchdog": {
    "prompt": "continue",
    "per_watch_duration": "7d",
    "max_tokens": "1m",
    "auto_nudge_stop": true,
    "auto_restart": true,
    "api_error_auto_compact": {
      "threshold": 3,
      "rate_limit_confirm_minutes": 10
    },
    "pane_watcher": {
      "compact_ratio": 0.8,
      "interval": 30
    }
  }
}
```

| Key | Required | Description |
|-----|----------|-------------|
| `name` | ✓ | Agent name, unique identifier. May not be `all` |
| `cwd` | ✓ | Working directory; tmux session is created here |
| `md` | | Task markdown file(s). Accepts a string, comma-separated string, or array. Relative to `cwd` or absolute. cdog runs `cat <md...> \| claude` |
| `args` | | Extra CLI flags appended to the claude command |
| `log` | | Claude debug log path (relative to `cwd`). Appends `--debug-file <path>` |
| `log_file` | | cdog's own operation log path. If unset, cdog writes no operation log |
| `model` | | Human-readable label shown in `cdog status` |
| `timeformat` | | Display time format via dayjs tokens. Default `YYYY-MM-DD HH:mm:ss` |
| `timeout` | | Stop/restart wait timeout in milliseconds |
| `watchdog` | | Auto-management policy (see below) |
| `notify` | | Desktop notification settings (see below) |

### Watchdog configuration

```json
"watchdog": {
  "prompt": "continue",
  "per_watch_duration": "7d",
  "max_tokens": "1m",
  "auto_nudge_stop": true,
  "auto_restart": true,
  "api_error_auto_compact": {
      "threshold": 3,
      "rate_limit_confirm_minutes": 10
    },
  "pane_watcher": {
    "compact_ratio": 0.8,
    "interval": 30
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `prompt` | `"continue"` | Text sent on each nudge (auto_nudge_stop, compact recovery, quota nudge) |
| `per_watch_duration` | | Monitor duration (e.g. `"7d"` / `"4h"` / `"1d4h"`). Each start/restart resets the deadline; when reached (checked on Stop/SessionEnd hooks), the agent is marked `completed`, watchers killed, but **tmux is kept alive** (claude context preserved) |
| `max_tokens` | `200000` | Max context tokens for the model. Accepts number or human string: `200000`, `"200k"`, `"1m"`. Shared by pane_watcher (compact at 80%) and api_error_auto_compact (fast-path at 70%) |
| `auto_nudge_stop` | `false` | On Stop hook, auto-send `prompt` + Enter to keep agent working |
| `auto_restart` | `true` | On recoverable StopFailure, auto-run the cdog-recover flow |
| `stall_timeout` | `"5m"` | Stall detection: if no real activity (tool_dispatch / API REQUEST / Stream started) for this long, breakToShell + nudge. Before nudging, cross-checks the pane watcher's recent token activity — if Claude is still producing output, the nudge is suppressed (guards against false stalls when the debug-log tail goes blind, e.g. after log rotation) |
| `stall_cooldown` | `"10m"` | Cooldown after a stall-triggered nudge before another can fire (prevents nudge loops) |
| `api_error_auto_compact` | | Log watcher config (see below). Always enabled |
| `pane_watcher` | | Pane watcher config (see below). Always enabled |

#### `api_error_auto_compact` — log watcher (reactive)

Tails the claude debug log for `[ERROR] API error` lines, classifies them, and triggers compact-or-nudge when the per-kind threshold is reached. Always enabled — cdog always passes `--debug-file` to claude, so a log file always exists.

| Key | Default | Description |
|-----|---------|-------------|
| `threshold` | `3` | Consecutive `unknown` API errors before triggering. `timeout` uses `max(threshold * 2, 6)` |
| `rate_limit_confirm_minutes` | `10` | rate_limit two-hit confirmation window (minutes). First rate_limit records a timestamp + nudge; if a second fires within this window → real quota exceeded → schedule nudge at reset_time + 30s |

**Compact decision:** reads `last_up_tokens` from state (recorded by pane watcher). If `upTokens >= max_tokens * 0.8` → `/compact`. Otherwise → nudge. No `/context` command needed — instant decision based on token data.

**API error classification** (per-kind thresholds):

| Kind | Matches | Threshold | Action |
|------|---------|-----------|--------|
| `fatal` | `model_not_found`, `authentication_failed`, `billing_error`, `oauth_org_not_allowed` | immediate | **Stop agent** — C-c (marker technique) → mark `failed` → kill tmux → kill watchers → notify |
| `timeout` | `timed out`, `524`, `TTFB`, `no response headers` | `max(threshold * 2, 6)` | C-c → breakToShell → compact-or-nudge |
| `provider` | `503`, `upstream error`, `no available channel`, `new_api_error`, `Concurrent limit exceeded`, `overloaded_error`, `访问量过大`, `稍后再试` | never | Let claude retry; notify on every error |
| `rate_limit` | `rate_limit`, `公平使用`, `frequency`, `429` | never | Two-hit confirmation: first records timestamp + breakToShell + nudge; second within `rate_limit_confirm_minutes` (default 10min) → schedule nudge at reset_time + 30s. Otherwise: let claude retry |
| `unknown` | (unclassified) | `threshold` (default 3) | C-c → breakToShell → compact-or-nudge |

> **Note:** `overloaded_error` in the API response means the *model* is overloaded (provider-side), NOT that the context window is full. A full context window typically shows up as `unknown` + "Request timed out", not as `overloaded_error`.

**Fast-path:** if the pane watcher has recorded `last_up_tokens ≥ 70% of max_tokens`, the log watcher reduces the threshold to 1 — the first API error likely means the large context is causing problems.

#### `pane_watcher` — proactive context compaction

Monitors the tmux pane for claude's TUI status line `↑ X.Yk tokens` and compacts *before* the context overflows and causes API errors. Uses `tmux pipe-pane` for event-driven streaming (instant updates); falls back to `capture-pane` polling every 15s if `pipe-pane` is unavailable.

| Key | Default | Description |
|-----|---------|-------------|
| `max_tokens` | `watchdog.max_tokens` | Override max tokens for the pane watcher only (rarely needed; normally set `watchdog.max_tokens` instead) |
| `compact_ratio` | `0.8` | Compact when `↑ tokens >= max_tokens * compact_ratio` (80% by default) |
| `interval` | `30` | Poll interval in seconds (fallback mode only; pipe-pane is event-driven). Note: currently hardcoded to 15s in fallback mode |

The pane watcher also persists `last_up_tokens` to state, which the log watcher reads on the first API error for the fast-path threshold.

### Notification configuration

```json
"notify": {
  "enabled": true,
  "lang": "default",
  "sound": true,
  "interactive": false,
  "ask_timeout": 30,
  "open_on_click": true,
  "on": {
    "agent-started": true,
    "agent-failed": true,
    "agent-recovered": true,
    "api-error": true,
    "circuit-breaker": true,
    "max-run-reached": true,
    "nudge": false,
    "task-completed": true
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Master switch — opt-in |
| `lang` | `"default"` | Sound language: `"default"` (English) or `"zh"` (Chinese) |
| `sound` | `false` | Play custom sound via afplay on notification |
| `interactive` | `false` | Blocks for user response when auto-action is OFF (macOS only) |
| `ask_timeout` | `30` | Seconds to wait for user action on interactive notification. On timeout, auto-executes the default action (nudge/recover) instead of skipping |
| `open_on_click` | `true` | Click notification body → open the agent's tmux session in Terminal.app (macOS only) |
| `on` | all true | Per-event enable map. Unlisted events default to true |

> **Do Not Disturb**: macOS DND suppresses notification display, but queued notifications appear after DND is turned off. cdog cannot detect DND status from Node.js — notifications are always sent regardless.

## Commands

`all` is a reserved word — no agent may be named `all`. Any command that accepts `<name|all>` works on a single agent by name, or on every agent when `all` is passed.

| Command | Description |
| --- | --- |
| `cdog start [config_path\|all]` | Start an agent from a config path (default: `./cdog.json`). Auto-runs `cdog init` if hooks are missing |
| `cdog stop <name\|all>` | **Detach** cdog — stop monitoring, Claude keeps running untouched. Kills both watchers |
| `cdog restart <name\|all>` | **Re-watch** a detached agent. Never kills the Claude process. Respawns watchers; kicks if idle |
| `cdog delete <name\|all>` | Kill the tmux session and remove the agent from state. Kills both watchers |
| `cdog status [name]` | pm2-style table or detail for one agent |
| `cdog log [name] [--all\|--cdog\|--claude] [--lines N] [--no-follow] [--err]` | Tail logs. `--all`/no flag = cdog+claude merged; `--cdog` = cdog op-logs; `--claude` = claude debug; `--err` = `[ERROR]` only |
| `cdog message send --to <name> --message <text> [--from F] [--reply-method R]` | Send text to a running agent's tmux pane |
| `cdog nudge <name\|all> [text]` | Send `prompt` + Enter. Bumps `nudge_count` |
| `cdog compact <name>` | Manually trigger compact-or-nudge: C-c → read tokens → /compact or nudge |
| `cdog auto-nudge <enable\|disable> <name\|all>` | Toggle auto-nudge in config (persistent). Updates cdog.json + state |
| `cdog notify [json]` | Internal — process a hook event (stdin or arg) |
| `cdog init` | Install `~/.cdog/` and wire hooks into `~/.claude/settings.json` |

### Dual-track status

cdog tracks two independent statuses per agent:

- **claude** (hook-driven): `running` / `waiting` / `pending` / `failed` / `completed` / `stopped`
- **cdog** (command-driven): `watching` (listen to hooks) / `detached` (ignore all hooks)

`cdog stop` does **not** kill claude — it flips cdog to `detached` so cdog stops nudging/recovering while claude keeps running. `cdog restart` flips back to `watching` without touching the process. If claude died, restart relaunches it via `--resume`; if claude is alive but idle (`claude_status != running`), restart sends one nudge kick to get it moving (mid-turn it's left alone). `cdog delete` is the only command that actually kills the tmux/claude session.

### Logging

Two separate logs:

- **cdog operation log** (`log_file` in `cdog.json`, optional): lines like `[name] | 2026-06-21T18:00:00.123Z ✓ started, session=4191ab9d`. Written only when `log_file` is configured. Timestamps are ISO-8601 on disk; `cdog log` reformats them to the agent's `timeformat` at display time.
- **claude debug log** (`log` in `cdog.json`, optional): passed to claude as `--debug-file <path>`. If not configured, defaults to `<cwd>/logs/claude-debug.log` (directory auto-created). Always passed — the log watcher needs it.

Both logs are tailable via `cdog log`. **Source** selection: `--cdog` = cdog op-logs, `--claude` = claude debug logs, `--all` (or no flag) = both merged (cdog lines get a bright-magenta `[CDOG]` tag). **Target** selection: no name / `all` = every agent; a name = that single agent. `--err` keeps only `[ERROR]` lines, `--no-follow` snapshots and exits, `--lines N` sets the count (default 50).

When tailing multiple sources, the initial burst (last N lines per source) is collected across all sources and **sorted by timestamp** before display, so `cdog log all` opens with a chronologically merged view instead of each agent's lines clumped together. In follow mode, new lines stream live after the sorted initial view.

```bash
cdog log                       # all agents, cdog + claude merged (follow)
cdog log --claude --err        # all agents, claude [ERROR] lines only
cdog log snow-agent --cdog     # one agent, cdog op-logs only
```

### Session ID

`cdog start` generates a raw UUID and passes it as `claude --session-id <uuid>`. Hooks report the same id, which cdog matches against `state.json`. The tmux session is named after the agent.

## How auto-recovery works

cdog has three recovery paths, all sharing the same `breakToShell` + `compactOrNudge` logic from `recovery.ts`:

### 1. Hook-driven recovery (StopFailure)

When Claude Code hits an API error it fires the `StopFailure` hook → `cdog notify` → cdog:

1. Finds the agent by `session_id`
2. Classifies the error type:
   - **Fatal** (`authentication_failed`, `billing_error`, `model_not_found`, `oauth_org_not_allowed`) → mark `failed`, no recovery
   - **Transient** (`rate_limit`, `overloaded`, `server_error`, `max_output_tokens`) → `breakToShell` + `compactOrNudge`
   - **Context-suspect** (`invalid_request`, `unknown`) → `breakToShell` + `compactOrNudge`, with escalation by failure count
3. If recoverable and the circuit breaker hasn't tripped: types a `cdog-recover` marker, sends Ctrl-C, waits for shell prompt, checks whether the marker survived, then runs `compactOrNudge` (reads `last_up_tokens` from state → `/compact` if ≥ 80% of max, otherwise sends prompt nudge)
4. If the tmux session is dead: spawns a new tmux session with `claude --resume <session_id>` (with `cat <md>` if configured)
5. If the error is non-recoverable or the circuit breaker trips (≥3 failures in 5 minutes), marks the agent `failed` and stops restarting

### 2. Log-watcher-driven recovery (API error threshold)

The log watcher tails the claude debug log and counts consecutive `[ERROR] API error` lines per kind. When the per-kind threshold is reached, it triggers `cdog __recover-from-errors <name>`:

```
[ERROR] API error (attempt 1/11)
↓ (count >= threshold)
breakToShell: marker → C-c → check marker → C-u
↓
read state.last_up_tokens (recorded by pane watcher)
├─ upTokens >= maxTokens * 0.8 → /compact (context likely full)
├─ upTokens < 0.8 or unknown   → nudge with prompt (safer default)
```

No `/context` command needed — the pane watcher continuously records `↑ tokens` to state, so the decision is instant.

**Per-kind thresholds:**

| Kind | Threshold | Why |
|------|-----------|-----|
| `unknown` | 3 (default) | Unclassified — check tokens then decide |
| `timeout` | 6 | Occasional timeout is normal network jitter; 6+ likely means full context |
| `provider` | never | `overloaded_error` = model busy, not context full. Let claude retry |
| `rate_limit` | never | User hit rate limit. compact won't help. Let claude retry |

**Fast-path:** if the pane watcher recorded `last_up_tokens ≥ 70% of max_tokens`, threshold → 1 (act on first error).

### 3. Pane-watcher-driven compaction (proactive)

The pane watcher monitors `↑ tokens` in the tmux pane. When tokens reach 80% of `max_tokens`, it sends `/compact` directly (no C-c needed — claude is idle). Compact completion is detected via the `PostCompact` hook — no hardcoded delays:

```
↑ 165k tokens (82% of 200k)
↓ (>= max_tokens * compact_ratio)
set compact_in_progress = true
send /compact
↓ (wait for PostCompact hook — could be 1s or 5min)
PostCompact hook fires → send prompt nudge
```

### Marker safety (C-c without killing the wrong process)

All three paths use the `cdog-recover` marker technique in `breakToShell`:

```
1. Type "cdog-recover" (no Enter — stays on input line)
2. Send C-c
3. Check if marker survived in pane capture
   ├─ marker NOT found → C-c took effect (killed claude or interrupted shell command)
   │  → C-u to clear, proceed with recovery
   ├─ marker still found → C-c didn't work, retry once
   │  └─ marker survives 2x C-c → ABORT (avoid killing wrong process)
   └─ shell prompt appeared → safe to proceed
```

This prevents C-c from killing an unrelated foreground process (e.g. if claude already exited and a shell command is running).

### Recovery flow detail (hook-driven)

```
StopFailure
↓
Classify error → fatal / transient / context-suspect
↓
(if recoverable & circuit breaker not tripped)
tmux send-keys -l "cdog-recover" (no Enter — marker stays on input line)
tmux send-keys C-c
↓
Wait for shell prompt (poll pane for $, %, #)
↓
Read tmux pane content
├─ Marker survived (C-c only cleared the error, shell line intact)
│  → C-u clears marker
│
├─ Marker lost (C-c cleared the whole shell line)
│  → C-u clears residual input
│
└─ tmux session is dead
   → tmux new-session ... claude --resume <session_id> (with cat <md>)
↓
compactOrNudge: read state.last_up_tokens
├─ upTokens >= maxTokens * 0.8 → /compact (context likely full)
├─ upTokens < 0.8 or unknown   → send prompt nudge (safer default)
```

`SessionStart` marks an agent `running`; `SessionEnd` marks it `stopped`/`failed` (ignoring `compact`/`resume`).

Hooks are optional — `start`/`stop`/`status` work without them. `cdog start` auto-runs `cdog init` if hooks are missing.

## Message relaying

Send arbitrary text to a running agent's tmux pane:

```bash
cdog message send --to snow-agent --message "继续" --from "大哥"
cdog message send --to snow-agent --message "看看进度" --from "hermes" --reply-method "notify-hermes --from snow-agent --to snow --message \"收到\""
```

Formatting is purely concatenative — cdog never modifies the text:

- With `--from` only: `from: message`
- With `--reply-method`: appends `\nReply Method: <reply-method>`
- With neither: just the raw `message`

Examples of formatted output:

```
大哥: 继续
```

```
hermes: port-map 的进度怎么样
Reply Method: cdog message send --to hermes --message "已完成后端3个文件" --from "snow-agent"
```

## Caveats

- **tmux required** — cdog manages Claude sessions inside tmux. No tmux, no cdog
- **macOS notifications only** — interactive and sound notifications use macOS Notification Center. Other platforms fall back to plain notify
- **Hook-based** — hook scripts must be installed via `cdog init`. Without hooks, auto-nudge and auto-recover do not work. `cdog start` auto-runs `cdog init` if hooks are missing
- **Watcher subprocesses** — `cdog start` spawns pane watcher + log watcher as detached child processes. Their `tail` children share the watcher's process group, so `cdog stop` / `restart` / `delete` (which signal the whole group) clean them up reliably — no orphan accumulation across restarts. Only a hard crash or `kill -9` of the watcher itself can leave orphans (check `ps aux | grep cdog`)
- **Log path fallback** — if config doesn't specify `log`, the log watcher falls back to `<cwd>/logs/claude-debug.log`. Both watchers auto-enable when a log file is available
- **Session id binding** — cdog matches hook events to agents by `session_id`. If you manually pass a duplicate `--session-id`, hook routing will be ambiguous
- **Circuit breaker** — 3 failures in 5 minutes trips the circuit breaker. The agent is marked `failed` and requires manual restart

## Build from source

```bash
npm install
npm run build      # tsc -> dist/
npm run dev        # run via tsx without building
```

## Skill Integration

This repository comes with a skill definition at `skills/cdog/`. Any AI agent can use this skill. When `claude-tmux-dog` is installed globally (`npm install claude-tmux-dog -g`) and the skill is loaded, the agent can manage background cdog agents without leaving the conversation. The skill frontmatter:

```markdown
---
name: cdog
description: Manage Claude Code background agents with cdog (claude-tmux-dog). Start/stop/restart a cdog agent, check status, view logs, send messages, nudge agents to continue working, compact agent context. Dual-layer context defense (pane watcher + log watcher) auto-compacts before API errors. Use when user mentions "cdog", "claude-tmux-dog", "tmux agent", "background agent", or asks to start/stop/manage a long-running Claude Code session.
---
```

See [skills/cdog/](/skills/cdog/) for the full skill definition file.

## Author

[SnowAIGirl](https://github.com/SnowAIGirl) & [LinQuan](https://github.com/mlinquan)

## License

[MIT](LICENSE)
