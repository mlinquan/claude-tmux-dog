// Type definitions for claude-tmux-dog (cdog) — v2

// ---- Claude process status (hook-driven) ----
export type ClaudeStatus = 'running' | 'waiting' | 'pending' | 'failed' | 'completed' | 'stopped' | 'starting';

// ---- cdog monitoring status (command-driven) ----
//   watching: cdog listens to hooks (nudge/recover), does NOT own the process lifetime.
//   detached: cdog ignores ALL hook events; claude keeps running untouched in tmux.
export type CdogStatus = 'watching' | 'detached';

/** Reserved keyword — no agent may be named `all`. */
export const ALL_KEYWORD = 'all';

/** Project configuration file (cdog.json), placed in a project root. */
export interface CdogConfig {
  /** Agent name — required, unique identifier. May not be `all`. */
  name: string;
  /** Working directory; tmux session is created here. */
  cwd: string;
  /**
   * Task markdown file(s), relative to cwd. If set, cdog runs `cat <md...> | claude`.
   * Accepts a single string, a comma-separated string, or an array of strings.
   * Examples: "task.md", "task1.md,task2.md", ["task1.md", "task2.md"]
   */
  md?: string | string[];
  /** Extra CLI args appended to the claude command, each as a separate token. */
  args?: string[];
  /**
   * Environment variables injected into the launched claude process, as KEY=value
   * assignments prefixed to the claude command (e.g. `DISABLE_TELEMETRY=1
   * CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 claude ...`). Useful for claude's
   * env-tunable behavior without touching ~/.zshrc or ~/.claude/settings.json.
   * Applied to claude only (after any `cat md |` pipe).
   */
  env?: Record<string, string>;
  /** Claude debug log path, relative to cwd. cdog always passes `--debug-file <path>` to claude (the log watcher needs a file to tail); defaults to `<cwd>/logs/claude-debug.log` when unset. */
  log?: string;
  /** cdog's OWN operation log path (the `[name] | ...` lines). If unset, cdog writes no operation log. */
  log_file?: string;
  /** Human-readable model label for `status` display only. */
  model?: string;
  /** Auto-generated UUID at start, or a preset fixed value. Passed to claude as `--session-id <uuid>`. */
  session_id?: string;
  /** Auto-generated tmux session name, equal to the agent `name` (suffixed `-1`/`-2` on collision). */
  tmux_session?: string;
  /** stop/restart wait timeout in milliseconds. */
  timeout?: number;
  /** Display-only time format (dayjs tokens). Stored data stays raw ISO. Default `YYYY-MM-DD HH:mm:ss`. */
  timeformat?: string;
  /**
   * Retention window for cdog's OWN operation log (log_file), e.g. "7d".
   * `cdog prune` and `cdog start` trim lines older than this. Does NOT touch
   * claude's debug log (claude manages its own). Default "7d"; "0"/"off" disables.
   */
  log_retention?: string;
  /** Optional auto-management policy. */
  watchdog?: WatchdogConfig;
  /** Optional desktop notification settings. */
  notify?: NotifyConfig;
  /** Optional `cdog stop` behavior. */
  stop?: StopConfig;
}

/** Configuration for the `cdog stop` command. */
export interface StopConfig {
  /**
   * On `cdog stop`, abort claude's in-progress turn by sending a single Esc,
   * but keep the claude process alive (claude_status → 'waiting', not exited).
   * Only fires when claude is actively working (claude_status running/pending);
   * otherwise stop detaches as usual without sending any key.
   *
   * Why Esc (not C-c): Esc interrupts the current turn and returns claude to
   * its input prompt with the process still alive — exactly "suspend, don't
   * exit". C-c risks exiting the process on a second press and is reserved for
   * the recovery flow (breakToShell). DEFAULT TRUE — `stop` semantically means
   * halt; set `false` explicitly to opt out (detach without interrupting the
   * current turn, e.g. for maintenance).
   */
  abort_work?: boolean;
}

/** Event types that can trigger a desktop notification + sound. */
// Notification event names. 'compact' fires on auto/manual /compact triggers.
// 'circuit-breaker' is a legacy name kept for backward compat with existing
// user `on` config + the old sound file, but is no longer triggered (the
// circuit breaker was removed — fatal errors suspend via 'agent-failed').
export type NotifyEvent =
  | 'agent-started'
  | 'agent-failed'
  | 'agent-recovered'
  | 'api-error'
  | 'compact'
  | 'circuit-breaker'
  | 'max-run-reached'
  | 'nudge'
  | 'task-completed';

export interface NotifyConfig {
  /** Master switch. Default false (opt-in). */
  enabled?: boolean;
  /** Sound language: "default" or "zh". Selects assets/sounds/<lang>/. Default "default". */
  lang?: 'default' | 'zh';
  /** Master sound switch. Default false (opt-in). When false, no event plays
   *  sound unless overridden `true` in `sound_on`. When true, every enabled
   *  event plays sound unless overridden `false` in `sound_on`. */
  sound?: boolean;
  /** Per-event sound override. Keys not listed follow the master `sound` flag.
   *  Useful to mute chatty events (api-error/nudge/compact) while keeping
   *  critical ones (agent-failed/task-completed) audible. Default: high-frequency
   *  events (api-error, nudge, compact) are NOT muted by code — set them false
   *  here if you enable master `sound` and find them noisy. */
  sound_on?: Partial<Record<NotifyEvent, boolean>>;
  /** Absolute icon path for the notification. Defaults to bundled assets/icon.png. */
  icon?: string;
  /** Per-event enable map. Unlisted events default to true. */
  on?: Partial<Record<NotifyEvent, boolean>>;
  /**
   * Custom shell command run alongside each enabled notification. Lets you fan
   * events out to webhooks, chat clients, or your own script. Run via `sh -c`,
   * so inline commands and script paths both work. Context is passed as ENV
   * vars (preferred) AND positional args:
   *   ENV:   CDOG_AGENT  CDOG_EVENT  CDOG_TITLE  CDOG_MESSAGE
   *   ARGS:  $1=agent  $2=event  $3=title  $4=message
   * NEVER interpolates title/message into the command string — only via these
   * vars — so message text can't break the command (no injection). Best-effort:
   * a failing/timing-out command is logged but never breaks cdog.
   */
  command?: string;
  /** Seconds before a running `command` is killed. Default 30. */
  command_timeout?: number;
  /**
   * Interactive mode: when an auto-action is OFF (auto_nudge_stop/auto_restart false),
   * pop a notification with action buttons and BLOCK until the user responds or times out.
   * macOS only (NotificationCenter wait+actions); other platforms degrade to plain notify.
   * Default false.
   */
  interactive?: boolean;
  /** Seconds to wait for user action on an interactive notification. Default 30. */
  ask_timeout?: number;
  /**
   * Click on notification body → open or focus the agent's tmux session in the
   * configured terminal app. Default true. macOS: uses `terminal-notifier -execute`.
   * If a tmux client is already attached to the session → focus/activate that
   * terminal; otherwise → open a new window and `tmux attach`. Note: macOS Do
   * Not Disturb suppresses notification display, but queued notifications appear
   * after DND is turned off. cdog cannot detect DND status from Node.js — the
   * notification is always sent regardless.
   */
  open_on_click?: boolean;
  /**
   * Terminal app to open/focus on notification click (when `open_on_click` is
   * true). macOS examples: "Terminal" (default), "iTerm2", "Ghostty",
   * "Alacritty", "kitty". Linux examples: "gnome-terminal", "konsole", "xterm",
   * "alacritty", "kitty" (default: auto-detected). Unlisted apps use a generic
   * `-e <command>` launch. The agent's tmux session is auto-detached-attached:
   * already-open → focus, otherwise → open + attach.
   */
  terminal?: string;
}

export interface WatchdogConfig {
  /** Text sent on each nudge (auto_nudge_stop, compact recovery, quota nudge). Default "continue". */
  prompt?: string;
  /** Monitor duration, e.g. "7d"/"4h". Each start/restart resets the deadline; on SessionEnd, if passed → completed. */
  per_watch_duration?: string;
  /**
   * Stall detection: if no real activity (tool_dispatch / API REQUEST / Stream started)
   * for this duration, breakToShell + nudge. Default "5m".
   */
  stall_timeout?: string;
  /** Cooldown after a stall-triggered nudge before another can fire. Default "10m". */
  stall_cooldown?: string;
  /**
   * Max context tokens for the model (e.g. 200000 for Claude Sonnet).
   * Accepts number or human string: 200000, "200k", "1m".
   * Shared by pane_watcher (compact at 80%) and api_error_auto_compact
   * (fast-path threshold at 70%). Default 200000.
   */
  max_tokens?: number | string;
  /** On Stop hook, auto-send `prompt` (+ Enter) to keep the agent working. Default false. */
  auto_nudge_stop?: boolean;
  /** On recoverable StopFailure, auto-recover (cdog-recover marker flow). Default true. */
  auto_restart?: boolean;
  /**
   * Monitor claude debug log for API errors. When consecutive API errors
   * reach the threshold, auto-trigger compact-or-nudge recovery.
   * Requires `log` field in config (or falls back to ./logs/claude-debug.log).
   */
  api_error_auto_compact?: ApiErrorAutoCompactConfig;
  /** Proactive context compaction: monitor ↑ tokens in tmux pane, compact before context overflows. */
  pane_watcher?: PaneWatcherConfig;
}

/**
 * Configuration for log-watcher-driven auto-compact on API errors.
 *
 * Flow:
 *   1. Watch claude debug log for `[ERROR] API error` lines.
 *   2. Count consecutive API errors per kind (reset on any successful response).
 *   3. When count >= threshold:
 *      a. Send C-c to break out of error state.
 *      b. Check cdog-recover marker in tmux pane.
 *      c. If marker survived → C-u to clear it.
 *      d. Read last_up_tokens from state (recorded by pane watcher).
 *      e. If upTokens >= maxTokens * 0.8 → send /compact.
 *      f. Otherwise → send continue prompt (nudge).
 */
export interface ApiErrorAutoCompactConfig {
  /** Consecutive API errors before triggering action. Default 3 (unknown), 6 (timeout). */
  threshold?: number;
  /**
   * rate_limit two-hit confirmation window in minutes.
   * First rate_limit records a timestamp; if a second rate_limit fires within
   * this window, it's treated as real quota exceeded and scheduleQuotaNudge is
   * called. Default 10.
   */
  rate_limit_confirm_minutes?: number;
}

/**
 * Configuration for pane-watcher-driven proactive context compaction.
 *
 * Instead of waiting for API errors (reactive), the pane watcher periodically
 * reads the ↑ token count from claude's TUI status line and compacts BEFORE
 * the context gets too large and causes timeouts.
 *
 * Flow:
 *   1. Every `interval` seconds, capture tmux pane.
 *   2. Parse "↑ X.Yk tokens" from claude's status line.
 *   3. If upTokens >= max_tokens * compact_ratio → send /compact + nudge.
 *   4. If claude is idle (no status line) → skip.
 *
 * This is lighter and more proactive than the log watcher:
 *   - No C-c needed (claude is idle when we check)
 *   - No /context needed (token count is already in the pane)
 *   - Prevents errors before they happen
 */
export interface PaneWatcherConfig {
  /**
   * Max context tokens for the model. Overrides watchdog.max_tokens for the
   * pane watcher only. Accepts number or "200k"/"1m". Normally set watchdog.max_tokens instead.
   */
  max_tokens?: number | string;
  /**
   * Compact when ↑ tokens >= max_tokens * compact_ratio.
   * Default 0.8 (compact at 80% full).
   */
  compact_ratio?: number;
  /** Poll interval in seconds. Default 30. */
  interval?: number;
}

/** One agent's persisted runtime state, keyed by name in state.json. */
export interface AgentState {
  name: string;
  session_id: string;
  pid?: number;
  tmux_session: string;
  /** Claude process status, driven by hooks. */
  claude_status: ClaudeStatus;
  /** cdog monitoring status, driven by commands. watching = listen to hooks; detached = ignore all hooks. */
  cdog_status: CdogStatus;
  /** Why the claude process stopped. null while running/starting. */
  stop_reason: 'stopped' | 'failed' | 'completed' | null;
  /** ISO timestamp when the claude process ended. null while running. */
  ended_at: string | null;
  /** Fatal error message (e.g. model_not_found) that caused immediate stop. null if no fatal error. */
  fatal_error: string | null;
  /** ISO timestamp when a fatal error was detected. null if no fatal error. */
  failed_at: string | null;
  /** ISO timestamp when the agent was started. */
  started_at: string;
  last_error: string | null;
  last_restart_at: string | null;
  /** Times the agent was auto-restarted after a recoverable StopFailure. */
  restart_count: number;
  /** Times `prompt` ("continue") was auto-sent on a Stop hook (auto_nudge_stop) or via `cdog nudge`. */
  nudge_count: number;
  model?: string;
  /** Absolute path to the cdog.json used to start this agent (for restart). */
  config_path?: string;
  /** Absolute claude debug log path (from config `log`), if any. */
  log_path?: string;
  /** Absolute cdog operation log path (from config `log_file`), if any. */
  log_file_path?: string;
  /** Record of timeformat resolved from config at start (dayjs tokens). */
  timeformat?: string;
  /** Epoch ms deadline at which per_watch_duration auto-completes the agent. Reset on start/restart. */
  per_watch_deadline?: number | null;
  /** Timestamps (epoch ms) of recent StopFailure events, retained for diagnostics. */
  failures?: number[];
  /**
   * Consecutive API error count from claude debug log (log-watcher-driven).
   * Persisted to state so it survives watcher restarts. Reset on a successful
   * response or after compact/nudge action taken.
   */
  api_error_count?: number;
  /** ISO timestamp of the last recovery action (cooldown tracking). */
  last_recover_at?: string | null;
  /**
   * Last known ↑ (input/upload) tokens, recorded by the pane watcher.
   * Read by the log watcher on the first API error to decide whether to
   * compact immediately (if context was already near-full) or wait.
   */
  last_up_tokens?: number | null;
  /** ISO timestamp of when last_up_tokens was recorded. */
  last_up_tokens_at?: string | null;
  /** PID of the detached log-watcher subprocess (api_error_auto_compact). */
  watcher_pid?: number | null;
  /** PID of the detached pane-watcher subprocess (proactive context compaction). */
  pane_watcher_pid?: number | null;
  /**
   * True when a /compact is in progress (sent by cdog, waiting for PostCompact hook).
   * Set by recovery.ts/panewatcher.ts before sending /compact, cleared by the
   * PostCompact hook handler in notify.ts. While true, pane watcher skips
   * token monitoring and log watcher skips recovery triggers.
   */
  compact_in_progress?: boolean;
  /** ISO timestamp when /compact was sent (for timeout fallback if PostCompact never fires). */
  compact_sent_at?: string | null;
  /** Pending nudge prompt to send after PostCompact (set by whoever sent /compact). */
  compact_pending_prompt?: string | null;
  /** ISO timestamp of the next scheduled quota nudge (null when no nudge scheduled). Cleared after nudge fires. */
  next_nudge_at?: string | null;
  /**
   * ISO timestamp of the first rate_limit trigger. Used for "two-hit confirmation":
   * if a second rate_limit occurs within 10 minutes, treat it as real quota exceeded.
   * Cleared on real quota confirmed / SUCCESS_RE (claude recovered).
   */
  rate_limit_first_at?: string | null;
  /** Runtime copy of watchdog config (for status display and watcher reads). */
  watchdog?: WatchdogConfig;
}

/** state.json: name -> AgentState. */
export type StateMap = Record<string, AgentState>;

// ---- Hook event payloads (stdin JSON from Claude Code hooks) ----

export type HookEventName = 'Stop' | 'StopFailure' | 'SessionStart' | 'SessionEnd' | 'PreCompact' | 'PostCompact' | 'UserPromptSubmit';

/** Claude Code `Stop` hook — fires when the agent finishes a turn. */
export interface StopEvent {
  session_id: string;
  hook_event_name: 'Stop';
  stop_hook_active?: boolean;
}

export interface StopFailureEvent {
  session_id: string;
  hook_event_name: 'StopFailure';
  error?: string;
  error_details?: string;
  last_assistant_message?: string;
}

export interface SessionStartEvent {
  session_id: string;
  hook_event_name: 'SessionStart';
  cwd?: string;
}

export interface SessionEndEvent {
  session_id: string;
  hook_event_name: 'SessionEnd';
  reason?: string;
}

/** Claude Code `PreCompact` hook — fires before context compaction. */
export interface PreCompactEvent {
  session_id: string;
  hook_event_name: 'PreCompact';
  trigger?: 'manual' | 'auto';
  custom_instructions?: string;
}

/** Claude Code `PostCompact` hook — fires after context compaction completes. */
export interface PostCompactEvent {
  session_id: string;
  hook_event_name: 'PostCompact';
  trigger?: 'manual' | 'auto';
  compact_summary?: string;
}

/**
 * Claude Code `UserPromptSubmit` hook — fires when a prompt is submitted
 * (turn START signal). Used to set claude_status='running' the moment claude
 * begins working on a prompt (including cdog-injected nudges), instead of
 * waiting for the turn to end (Stop hook). cdog's handler exits 0 (no prompt
 * modification / no blocking).
 */
export interface UserPromptSubmitEvent {
  session_id: string;
  hook_event_name: 'UserPromptSubmit';
  cwd?: string;
  prompt?: string;
}

export type HookEvent =
  | StopEvent
  | StopFailureEvent
  | SessionStartEvent
  | SessionEndEvent
  | PreCompactEvent
  | PostCompactEvent
  | UserPromptSubmitEvent;
