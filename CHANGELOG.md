# Changelog

## v0.5.0 (2026-06-29)

### Breaking (behavior)
- **Circuit breaker removed.** Recoverable StopFailures (5xx, overloaded, timeout, unknown, rate_limit) no longer mark the agent `failed` after N retries. They self-heal via claude's own retry, get `/compact`'d on context-full, or are probed by the 5-min stall health-check. Only fatal errors (model offline / auth / billing) suspend the agent.
- **Fatal = suspend, not kill.** `handleFatalError` no longer `kill-session`s the tmux session — it marks `failed` + `detached` (stops monitoring) and leaves tmux/claude alive for inspection. `cdog restart` resumes. `markFailed` now sets `cdog_status='detached'` everywhere, fixing a latent issue where a `failed` agent was still nudged/compacted by watchers.

### Bug Fixes
- **5xx no longer mis-routed to nudge loop.** `521`/`500`/`502` etc. are now classified as `provider` (previously fell to `unknown` → 3-count → breakToShell+nudge mid-storm, fighting claude's own retry). `provider` errors are left to claude's retry + the 5-min health-check.
- **5-min stall health-check catches sustained failures.** The stall watchdog now resets only on real success (`Stream started` / `tool_dispatch_start`), NOT on bare `[API REQUEST]` (which fires mid-storm before a 429/5xx). So a 5xx storm — only `[API REQUEST]`, never a stream — lets the 5-min timer fire and probe once, then re-arm. Each 5-min window → at most one probe.

### Improvements
- **Context-full → forced /compact.** A StopFailure whose message says "context window limit" (often mislabeled `max_output_tokens`) forces `/compact` instead of nudging — `last_up_tokens` is null in that state, so the token% heuristic used to mis-decide "nudge" and re-fail into the (now-removed) breaker.
- **Faster C-c settle.** `breakToShell` waits for claude to actually stop working (~150–450ms) instead of polling a fixed 5s for a shell prompt that never appears in claude's TUI.
- **Per-event sound (`sound_on`).** New `notify.sound_on` overrides sound per event. Master `sound: false` → silent; `sound: true` → each event plays unless muted, with chatty events (`api-error`/`nudge`/`compact`) defaulting to silent so a 24/7 agent doesn't beep all night. `sound_on: { <event>: true/false }` overrides either way.
- **`compact` notification event.** Auto/manual compacts now fire the `compact` event (with a dedicated sound) instead of the legacy `circuit-breaker` name. `circuit-breaker` is kept in the type for backward compat but no longer triggered.
- **`cdog restart` auto-inits hooks.** restart now self-checks hook config (like `cdog start` always did) and auto-installs any missing/incomplete hooks. Covers agents created by older cdog versions that didn't install all 7 hooks (e.g. `UserPromptSubmit`) — without it, a nudged agent stayed `waiting` because no hook fired to set it `running`.

---

## v0.4.1 (2026-06-28)

### Bug Fixes
- **Context-full no longer fails the agent**: a StopFailure whose message says "context window limit" (claude often mislabels it `error=max_output_tokens`) now forces `/compact` instead of nudging. Root cause: in that state `last_up_tokens` is null, so the token% heuristic mis-decided "nudge", and nudging a full context re-failed → circuit breaker → `failed`. `isContextOverload` now matches the message text regardless of the error-type field; the context-overload branch calls a new `forceCompact` (never nudge).
- **Faster C-c settle**: `breakToShell` now waits for claude to actually stop working (`waitForClaudeIdle`, typically ~150–450ms) instead of polling for a shell prompt (`waitForShellPrompt`) that never appears in claude's TUI — the old code burned a fixed ~5s every time. The 5s remains only as a hang-safety ceiling.
- **Stall watchdog respects /compact**: the 5-min stall nudge is now suppressed while `compact_in_progress` is set, closing a latent risk of C-c'ing a long-running compact.

### Improvements
- Spinner detection (`isClaudeWorking`) covers two more frames claude rotates through (`✢`, `✽`); `·` deliberately excluded (status-bar separator, would false-positive). The primary `… (` timer signal already covers all working states regardless of spinner char.

---

## v0.4.0 (2026-06-28)

### Bug Fixes
- **Rate-limit storm loop** (final): [`[API REQUEST]` no longer clears the two-hit confirmation counter. Root cause: every nudge-triggered request wrote `[API REQUEST]` to the debug log, which matched `SUCCESS_RE` and cleared `rate_limit_first_at` mid-storm, making every 429 look like a fresh first hit. Fix: split `REAL_SUCCESS_RE` (`Stream started` / `tool_dispatch_start`) from the old `SUCCESS_RE`; only real streaming responses clear the counter. `[API REQUEST]` now does nothing to storm state.

### Improvements
- **Unified clear entry point**: `clearRateLimitFirstAt` is the sole function that clears the two-hit counter. Called only by the logwatcher (on stream/tool success) or by user commands (`stop`/`restart`/`nudge`). Hook events (`Stop`, `SessionStart`) no longer touch it.
- **Stop hook `pending` guard**: when `claude_status === 'pending'` (quota nudge waiting), `handleStop` returns early — no status rewrite, no auto-nudge, preserving the scheduled quota timer until reset time.
- **`clearQuotaNudge` scoped down**: no longer clears `rate_limit_first_at`. Only manages the in-memory quota timer and `next_nudge_at` state.
- **Old no-resetTime two-hit branch removed**: `resetTime`-less 429s fall through to `transientNotifyCount++` (log + notify only) instead of entering a stale double-confirm path.

### Compatibility
- Fully backward-compatible (no config changes)
- No breaking changes

---

## v0.3.0 (2026-06-28)

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
