# Changelog

## v0.3.0 (2026-06-28, current)

### Features
- **`cdog drain`** — graceful detach: let claude finish its current turn before going idle, no Esc interrupt
- **`cdog prune`** — log retention: trim cdog op-logs by per-line ISO timestamp, clean up stale tmp/corrupt files
- **`cdog --version` / `-v`** — print version from package.json
- **Passive update check** — daily-cached npm registry version check; network refresh on `start`/`restart`/`init` only, instant cached hint on all other commands, 1.5s timeout, silent offline, disable via `CDOG_NO_UPDATE_CHECK=1`
- **Config field `env`** — inject environment variables into the launched claude process
- **`abort_work` defaults to true** — `cdog stop` now aborts the in-progress turn by default

### Improvements
- **Stop mechanism redesign**: Esc×2 + C-u clear input + pane verification (Stop hook doesn't fire on user interrupt — confirmed against Claude Code docs). Confirms claude actually went idle before setting `waiting`
- **`isClaudeWorking` more robust**: two independent signals (`… (` timer format + any spinner char) instead of pinning a single spinner character, supporting Claude Code's spinner rotation
- **`cdog log --err` fix**: `grep [ERROR]` the whole file then `tail -n N` — returns the last N errors across the entire log (previously filtered within the last N lines only, yielding few/no matches for sparse errors)
- **`detectLiveness` perf**: one `ps -A` call (~40ms, down from ~180ms) replacing recursive `pgrep` + `ps`
- **Lock optimization**: panewatcher reduced from 2 reads + 2 writes to 1 read + 1 write per token change, less contention
- **Drop fsync**: state.json write `~6ms→0.36ms` (17x), atomicity guaranteed by temp+rename
- **UserPromptSubmit hook**: auto-sets `running` on every prompt submission, no more manual status guessing
- **Detached observe path**: detached agents still record truthful claude_status from hooks, preventing state.json drift
- **stop/restart/kick status discipline**: no more lying about state, no stale status flags

### Documentation
- Bilingual README full rewrite (two-pillar positioning: watchdog + process manager)
- npm badges (version/downloads/license)
- cdog SKILL.md synced
- prune/drain/stop.abort_work/env/log_retention all documented

### Compatibility
- Fully backward-compatible config (new fields have defaults)
- No breaking changes

---

## v0.2.x

### v0.2.3 (2026-06-24)
- Docs overhaul: two-pillar positioning (watchdog + process manager), skill sync

### v0.2.2
- Docs overhaul (reverted, folded into v0.2.3)

### v0.2.1
- Cross-platform click-to-open terminal support

### v0.2.0
- **Stall detection**: nudge after 5min of no real activity
- **Two-hit rate_limit confirmation**: first hit records timestamp, second triggers breakToShell
- **`per_watch_duration`**: max wall-clock duration per work session
- **Recursive liveness detection**: walks process tree for claude
- **Proactive compact**: auto `/compact` when pane tokens exceed threshold
- **Reference equality fix**: reload state.json after claude status changes

### v0.1.1
- **Quota nudge auto-recover**: auto-send "continue" after rate_limit/timeout
- **breakToShell refactor**: unified interrupt path
- **Fatal error types**: model_not_found / authentication_failed → stop agent immediately

## v0.1.0

- Initial release
- Basic agent management (start/stop/restart)
- cdog state machine (watching/detached/failed)
- tmux session management
- Hook event handling (Stop/StopFailure/SessionStart/SessionEnd)
- Auto-nudge (send "continue" after Stop)
