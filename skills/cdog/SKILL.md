---
name: cdog
description: Manage Claude Code background agents with cdog (claude-tmux-dog). Start/stop/restart a cdog agent, check status, view logs, send messages, nudge agents to continue working, compact agent context. Dual-layer context defense (pane watcher + log watcher) auto-compacts before API errors. Use when user mentions "cdog", "claude-tmux-dog", "tmux agent", "background agent", or asks to start/stop/manage a long-running Claude Code session.
---

# cdog — Claude Code Process Manager

`cdog` manages Claude Code sessions in detached tmux sessions. Uses Claude Code's Hook mechanism for event-driven lifecycle management, plus background watcher daemons for autonomous context defense and API error recovery.

## Quick Reference

| Command | Description |
| --- | --- |
| `cdog start [config_path]` | Start an agent (default: `./cdog.json`). Auto-runs `cdog init` if hooks missing |
| `cdog start all` | Start every agent that has a `config_path` recorded |
| `cdog stop <name\|all>` | Detach cdog (stop watching); **claude keeps running**. Kills watchers |
| `cdog restart <name\|all>` | Re-watch a detached agent (never kills claude). Respawns watchers |
| `cdog delete <name\|all>` | Kill tmux session + remove from state. Kills watchers |
| `cdog status [name]` | pm2-style table, or detail for one agent |
| `cdog log [name] [options]` | Tail cdog logs |
| `cdog nudge <name\|all> [text]` | Send prompt + Enter to an agent |
| `cdog compact <name>` | Manually trigger compact-or-nudge: C-c → read tokens → /compact or nudge |
| `cdog auto-nudge <enable\|disable> <name\|all>` | Toggle auto-nudge in config (persistent) |
| `cdog message send --to <name> --message <text> [--from F]` | Send a message to an agent |
| `cdog init` | Install `~/.cdog/` and wire hooks into `~/.claude/settings.json` |

## Common Workflows

### 1. Start a background agent

```bash
# Assuming cdog.json is in project root
cdog start

# Or specify config:
cdog start ./path/to/cdog.json
```

A `cdog.json` looks like:

```json
{
  "name": "my-agent",
  "cwd": "/path/to/project",
  "md": "task.md",
  "args": ["--dangerously-skip-permissions"],
  "model": "claude-sonnet-4-6",
  "log": "./logs/claude-debug.log",
  "watchdog": {
    "auto_nudge_stop": true,
    "auto_restart": true,
    "max_run": "7d",
    "max_tokens": "1m",
    "api_error_auto_compact": {
      "threshold": 3
    },
    "pane_watcher": {
      "compact_ratio": 0.8
    }
  }
}
```

### 2. Check agent status

```bash
cdog status              # pm2-style table of all agents
cdog status my-agent     # detailed view of one agent
```

The table shows:
- **name** — agent name
- **session** — first 8 chars of session UUID
- **status** — cdog status (`watching` / `detached`)
- **claude** — claude process status (`running` / `waiting` / `failed` / `completed` / `stopped` / `failed!`)
- **auto-nudge** — whether auto-nudge is on or off
- **context** — `↑ tokens / max_tokens pct%` (from pane watcher)
- **nudge** — nudge count
- **↺** — restart count
- **uptime** — human-readable uptime
- **started_at** — start timestamp

### 3. Nudge an agent (send "continue")

```bash
cdog nudge my-agent                     # sends "continue" (or config's prompt)
cdog nudge my-agent "keep going"        # sends "keep going"
cdog nudge all                          # nudge every agent
```

Use when:
- An agent has gone idle and needs a kick
- You want to give it new direction
- The watchdog auto_nudge_stop didn't fire

### 4. Compact an agent's context

```bash
cdog compact my-agent                   # C-c → read last_up_tokens → /compact or nudge
```

This runs the same compact-or-nudge flow used by the auto-recovery:
1. Sends `cdog-recover` marker + C-c to break to shell (safely — checks marker survived)
2. Reads `last_up_tokens` from state (recorded by pane watcher)
3. If `upTokens >= max_tokens * 0.8` → `/compact` (context likely full)
4. If `upTokens < 0.8` or unknown → sends prompt (nudge — safer default)

No `/context` command needed — the pane watcher continuously records token data.

Use when:
- An agent is slowing down due to large context
- API errors are piling up (timeouts, unknown errors)
- You want to manually reclaim context space

### 5. Send a message to an agent

```bash
cdog message send --to my-agent --message "Check if there are any new issues" --from "human"
```

The message is typed into the agent's tmux pane followed by Enter. If `--from` is set, it's prefixed as `from: message`.

### 6. Toggle auto-nudge

```bash
cdog auto-nudge enable snow-agent     # turn on auto-nudge (persistent)
cdog auto-nudge disable snow-agent    # turn off auto-nudge
cdog auto-nudge disable all           # turn off for every agent
```

This updates the agent's `cdog.json` config file directly (persistent across restarts) and also updates state for immediate effect. The `auto` column in `cdog status` reflects the current state.

Use when:
- You want to pause auto-nudging temporarily (e.g. agent is in a delicate operation)
- You want to re-enable after pausing
- You're debugging and don't want cdog to interfere

### 7. View logs

```bash
cdog log                    # follow all agents' cdog logs (requires log_file in config)
cdog log my-agent           # follow one agent's cdog log
cdog log my-agent --no-follow --lines 100   # snapshot last 100 lines
cdog log my-agent --claude-log              # tail the claude debug log
cdog log --all --no-follow                  # snapshot all agents
```

### 8. Stop / restart / delete

```bash
cdog stop my-agent          # detach cdog — claude keeps running untouched
cdog restart my-agent       # re-attach cdog — never kills claude
cdog delete my-agent        # kill tmux session + remove from state permanently
cdog stop all               # stop watching all agents
```

### 9. Init (one-time setup)

```bash
cdog init
```

Copies hooks to `~/.cdog/hooks/` and wires them into `~/.claude/settings.json`.

## Dual-Track Status

cdog tracks **two independent statuses** per agent:

| Track | Values | Driven by |
| --- | --- | --- |
| **claude** | `running` / `waiting` / `failed` / `completed` / `stopped` | Hook events |
| **cdog** | `watching` / `detached` | Commands (`stop` / `restart`) |

- `watching` — cdog listens to hooks: auto-nudges on Stop, auto-recovers on recoverable failures
- `detached` — cdog ignores ALL hook events; claude keeps running untouched in tmux

`cdog stop` does **not** kill claude — it just flips to `detached`.
`cdog delete` IS the only command that kills the tmux/claude session.

## Watchdog Auto-Management

Configured in `cdog.json`:

- `auto_nudge_stop: true` — on Stop hook, auto-send "continue" so it keeps working
- `auto_restart: true` — on recoverable StopFailure (rate_limit, overloaded, timeout), auto-run breakToShell + compactOrNudge (compact if context ≥ 80%, else nudge). Circuit breaker trips after 3 failures in 5 min
- `max_run: "7d"` — stores deadline timestamp; on SessionEnd, if deadline passed, marks `completed` and kills tmux
- `max_tokens: "1m"` — max context tokens (accepts `200000`, `"200k"`, `"1m"`). Shared by pane_watcher and api_error_auto_compact
- `api_error_auto_compact` — log watcher: tails claude debug log, classifies API errors (`fatal`/`timeout`/`provider`/`rate_limit`/`unknown`), triggers compact-or-nudge on threshold. `fatal` (model_not_found etc.) stops agent immediately. Always enabled
- `pane_watcher` — proactive: monitors `↑ tokens` in tmux pane via `pipe-pane`, compacts at 80% before errors happen. Always enabled

## Dual-Layer Context Defense

cdog always spawns two detached watcher subprocesses on `cdog start` (always on — no opt-in needed):

1. **Pane watcher** (proactive, primary defense): uses `tmux pipe-pane` to stream pane output, parses `↑ X.Yk tokens` from claude's TUI status line, compacts at 80% of `max_tokens` *before* API errors happen. Falls back to `capture-pane` polling every 15s if `pipe-pane` is unavailable. No C-c needed — claude is idle when checked.

2. **Log watcher** (reactive, secondary defense): `tail -f` the claude debug log (always passed via `--debug-file`), classifies `[ERROR] API error` lines by type (`fatal`/`timeout`/`provider`/`rate_limit`/`unknown`), triggers compact-or-nudge when the per-kind threshold is reached. `fatal` errors (model_not_found, authentication_failed) stop the agent immediately. Uses marker safety (`cdog-stop` → C-c → check marker) to avoid killing the wrong process.

**Compact decision:** reads `last_up_tokens` from state (recorded by pane watcher). If `upTokens >= max_tokens * 0.8` → `/compact`. Otherwise → nudge. No `/context` command needed — instant decision based on token data.

**Compact completion detection:** uses Claude Code's `PostCompact` hook (event-driven, no hardcoded delays). When cdog sends `/compact`, it sets `compact_in_progress` in state. The `PostCompact` hook fires when claude finishes compacting → cdog sends the pending nudge prompt. This works whether compact takes 1 second ("Not enough messages") or 5 minutes.

**State sharing:** the pane watcher persists `last_up_tokens` to state. On the first API error, the log watcher reads it — if tokens were ≥ 70% of max, it acts immediately (threshold → 1) instead of waiting for 3-6 errors.

Both watchers are killed on `cdog stop` / `cdog delete` and respawned on `cdog restart`.

## Project Config (`cdog.json`) Reference

```json
{
  "name": "agent-name",                 // required — unique agent identifier
  "cwd": "/path/to/project",            // required — working directory
  "md": "task.md",                      // task markdown piped into claude on start (supports comma-separated or array for multiple files)
  "args": ["--dangerously-skip-permissions"],  // extra CLI args
  "log": "./logs/claude-debug.log",     // claude debug log path
  "log_file": "./logs/cdog.log",        // cdog operation log path
  "model": "claude-sonnet-4-6",         // model label (display only)
  "env": { "KEY": "VALUE" },            // env vars for claude process
  "timeout": 10000,                     // stop/restart wait ms
  "timeformat": "YYYY-MM-DD HH:mm:ss",  // display timestamp format
  "watchdog": {
    "prompt": "continue",               // nudge text (default "continue")
    "max_run": "7d",                    // auto-stop after duration (supports "1d4h")
    "max_tokens": "1m",                 // max context tokens (200000 / "200k" / "1m")
    "auto_nudge_stop": true,            // auto-nudge on Stop hook
    "auto_restart": true,               // auto-recover on StopFailure
    "api_error_auto_compact": {         // log watcher (reactive)
      "threshold": 3,                  // consecutive unknown errors → act
      "prompt": "continue"             // nudge text when context is OK
    },
    "pane_watcher": {                   // pane watcher (proactive)
      "max_tokens": "1m",              // override watchdog.max_tokens (rarely needed)
      "compact_ratio": 0.8,            // compact at 80% of max_tokens
      "interval": 30,                 // poll interval (fallback mode only)
      "prompt": "continue"             // text sent after /compact
    }
  }
}
```

## Notes

- `all` is a reserved word — no agent may be named `all`
- `cdog init` is a one-time setup; it backs up the existing `~/.claude/settings.json` first
- `cdog start` auto-runs `cdog init` if hooks are missing (hooks can get reset by claude updates)
- If `cdog` is not installed globally, run from the repo: `cd /path/to/claude-tmux-dog && npm run dev -- <cmd>` (tsx) or `node dist/cli.js <cmd>`