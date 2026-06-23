// Log watcher: a standalone long-running process that tails the claude debug log,
// counts consecutive [ERROR] API error lines, and triggers compact-or-nudge recovery
// when the threshold is reached.
//
// Spawned by `cdog start` as a detached child process when api_error_auto_compact
// is configured. Killed on `cdog stop` / `cdog delete`.
//
// Architecture:
//   cdog start → spawns `cdog __watch <name>` as detached child
//   __watch process: tail -f log, count errors, on threshold → call `cdog __recover-from-errors <name>`
//   __recover-from-errors: runs the C-c → /context → compact-or-nudge flow
//
// Log path resolution priority:
//   1. agent.log_path (from config `log` field, absolute)
//   2. <cwd>/logs/claude-debug.log (default fallback)
//
// This keeps the watcher simple (just counting) and the recovery complex logic in the main cdog codebase.

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { AgentState, CdogConfig } from './types.js';
import { loadState, mutateAgent } from './state.js';
import { loadConfig } from './config.js';
import { tmuxHasSession, sleep, parseTokenCount } from './util.js';
import { tmux, tmuxSendKey, tmuxCapturePane, tmuxSendText } from './util.js';
import { killPaneWatcher } from './panewatcher.js';
import {
  breakToShell,
  compactOrNudge,
  detectLiveness,
  DEFAULT_PROMPT,
} from './recovery.js';
import { logAgentEvent } from './logger.js';
import { notify } from './notify.js';

// ---- Constants ----
const DEFAULT_THRESHOLD = 3;
const RECOVER_COOLDOWN_MS = 60_000; // min interval between recovery triggers

// ---- API error line regex ----
// Matches: 2026-06-22T19:40:41.805Z [ERROR] API error (attempt 1/11): ...
export const API_ERROR_RE = /\[ERROR\]\s+API error/;

// ---- Successful response indicators (resets error counter) ----
// Real claude debug log markers for a successful API response:
//   "Stream started - received first chunk"  → stream began (strong success signal)
//   "[API REQUEST]"                          → a new request dispatched (claude recovered)
//   "tool_dispatch_start"                     → tool execution (response was processed)
export const SUCCESS_RE = /Stream started - received first chunk|\[API REQUEST\]|tool_dispatch_start/;

// ---- API error classification ----
// Different API errors need different recovery strategies:
//
//   timeout / 524 (Cloudflare)   → transient network issue, claude is retrying.
//                                   C-c would interrupt claude's own retry. Wait longer.
//   503 model_not_found           → provider has no capacity. compact won't help.
//                                   Wait + notify user. Don't C-c.
//   500 rate_limit                → user hit rate limit. compact won't help.
//                                   Wait + notify user. Don't C-c.
//   500 upstream                  → provider upstream error. transient. Wait.
//   overloaded_error              → "该模型当前访问量过大" = provider overloaded.
//                                   NOT context full! compact won't help. Wait.
//   524 Proxy Read Timeout        → transient. Wait.
//   unknown                       → unknown, check context then compact-or-nudge.
//
// IMPORTANT: "overloaded_error" in the API response is the MODEL being
// overloaded (provider-side), NOT the context window being full. A truly
// full context window shows up as StopFailure:unknown + "Request timed out",
// not as an API error with overloaded_error type.
export type ApiErrorKind =
  | 'timeout'        // TTFB timeout, 524 Cloudflare timeout
  | 'provider'        // 503, upstream error, overloaded_error (model busy)
  | 'rate_limit'     // 500 rate_limit / fair use
  | 'fatal'          // model_not_found, authentication_failed — model offline, stop immediately
  | 'unknown';       // unclassified — check context then decide

/** Classify an API error line from the log. */
export function classifyApiError(line: string): ApiErrorKind {
  // Fatal: model_not_found means the model is offline — stop immediately
  if (/model_not_found|authentication_failed|billing_error/i.test(line)) return 'fatal';
  // Rate limit
  if (/rate.?limit|公平使用|frequency|429/i.test(line)) return 'rate_limit';
  // Provider errors: 503, upstream error, overloaded_error (model busy)
  // NOTE: overloaded_error = "该模型当前访问量过大" = provider overloaded, NOT context full
  if (/503|upstream error|no available channel|overloaded_error|访问量过大|稍后再试/i.test(line)) return 'provider';
  // Transient timeouts: TTFB, 524 Cloudflare, "Request timed out"
  if (/timed out|524|TTFB|no response headers/i.test(line)) return 'timeout';
  return 'unknown';
}

/** Whether this error kind warrants a C-c + compact-or-nudge intervention. */
export function shouldIntervene(kind: ApiErrorKind): boolean {
  // unknown + timeout trigger intervention (check context then compact-or-nudge).
  // provider/rate_limit are better left to claude's own retry — compact won't help.
  // fatal (model_not_found etc.) → stop immediately, no intervention.
  // timeout is included because consecutive timeouts often indicate a full context
  // window (large request body → slow upload → TTFB timeout / 524 Proxy Read Timeout).
  return kind === 'unknown' || kind === 'timeout';
}

/**
 * Intervention threshold per error kind.
 * - unknown: 3 (default, act fast on unclassified errors)
 * - timeout: 6 (higher — occasional timeout is normal network jitter, but
 *   6+ consecutive timeouts likely mean context is too large)
 * Returns null for kinds that should never trigger intervention.
 *
 * FAST-PATH: If the pane watcher has recorded a high ↑ token count recently
 * (last_up_tokens >= maxTokens * 0.7), reduce threshold to 1 — the first API
 * error likely means the large context is causing problems, so compact
 * immediately instead of waiting for 3-6 errors.
 */
export function interveneThreshold(
  kind: ApiErrorKind,
  defaultThreshold: number,
  lastUpTokens?: number | null,
  maxTokens?: number,
): number | null {
  // fatal (model_not_found etc.) → stop immediately, never compact
  // provider and rate_limit never benefit from compact — skip regardless of token count.
  if (kind === 'fatal' || kind === 'provider' || kind === 'rate_limit') return null;

  // Fast-path: if pane watcher recorded high tokens (>= 70% of max), act on first error.
  // A large context is the most likely cause of unknown/timeout errors, so compact
  // immediately instead of waiting for 3-6 errors to pile up.
  if (lastUpTokens !== null && lastUpTokens !== undefined && maxTokens) {
    const highWatermark = maxTokens * 0.7;
    if (lastUpTokens >= highWatermark) {
      return 1; // first error → immediate intervention
    }
  }

  switch (kind) {
    case 'unknown': return defaultThreshold;
    case 'timeout': return Math.max(defaultThreshold * 2, 6);
    default: return null;
  }
}

// ============================================================
// Public API: start/stop watcher from cdog lifecycle
// ============================================================

/**
 * Resolve the log path for an agent.
 * Priority: agent.log_path (from config `log`, always set by start.ts) → <cwd>/logs/claude-debug.log
 *
 * Since start.ts always passes --debug-file and creates the logs directory,
 * this always returns a valid path. The file may not exist yet if the agent
 * was just started — runLogWatcher waits for it to appear.
 */
export function resolveLogPath(agent: AgentState): string | undefined {
  if (agent.log_path) return agent.log_path;

  // Default fallback: <cwd>/logs/claude-debug.log
  if (!agent.config_path || !existsSync(agent.config_path)) return undefined;
  try {
    const cfg = loadConfig(agent.config_path);
    return resolve(cfg.cwd, 'logs', 'claude-debug.log');
  } catch { /* ignore */ }
  return undefined;
}

/** Resolved log path for state display (always returns the intended path even if file missing). */
export function resolveIntendedLogPath(agent: AgentState): string {
  if (agent.log_path) return agent.log_path;
  if (agent.config_path && existsSync(agent.config_path)) {
    try {
      const cfg = loadConfig(agent.config_path);
      return resolve(cfg.cwd, 'logs', 'claude-debug.log');
    } catch { /* ignore */ }
  }
  return resolve(process.cwd(), 'logs', 'claude-debug.log');
}

export interface ResolvedAutoCompactConfig {
  enabled: boolean;
  threshold: number;
  prompt: string;
  /** Max context tokens (from watchdog.max_tokens or default 200000). Used for compact decision. */
  maxTokens: number;
}

/**
 * Resolve api_error_auto_compact config, merging defaults.
 *
 * Always enabled — cdog always passes --debug-file to claude and always
 * spawns the log watcher. Users can tune thresholds via config but can't
 * disable the watcher entirely (it's the reactive defense layer).
 */
export function resolveAutoCompactConfig(cfg: CdogConfig, _hasLog = false): ResolvedAutoCompactConfig {
  const ac = cfg.watchdog?.api_error_auto_compact;
  const prompt = ac?.prompt ?? cfg.watchdog?.prompt ?? DEFAULT_PROMPT;
  return {
    enabled: true,
    threshold: ac?.threshold ?? DEFAULT_THRESHOLD,
    prompt,
    maxTokens: parseTokenCount(cfg.watchdog?.max_tokens) || 200_000,
  };
}

/**
 * Spawn the log watcher as a detached child process.
 * The child runs `cdog __watch <name>` which is handled in cli.ts.
 */
export function spawnLogWatcher(agent: AgentState): number | null {
  const logPath = resolveLogPath(agent);
  if (!logPath) {
    logAgentEvent(agent.name, `logwatcher: no log file found, not spawning (checked config log + <cwd>/logs/claude-debug.log)`);
    return null;
  }

  const child = spawn(process.execPath, [process.argv[1]!, '__watch', agent.name], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();

  const pid = child.pid ?? null;
  mutateAgent(agent.name, (a) => {
    a.watcher_pid = pid;
  });

  logAgentEvent(agent.name, `logwatcher spawned (pid=${pid}, watching ${logPath})`);
  return pid;
}

/**
 * Kill the log watcher process for an agent.
 */
export function killLogWatcher(agentName: string): void {
  const agent = loadState()[agentName];
  const pid = agent?.watcher_pid;
  if (!pid) return;
  try {
    process.kill(pid);
  } catch { /* already dead */ }
  mutateAgent(agentName, (a) => {
    a.watcher_pid = null;
  });
  logAgentEvent(agentName, 'logwatcher killed');
}

// ============================================================
// __watch command: long-running tail -f loop
// ============================================================

/**
 * Run the log watcher loop. Entry point for `cdog __watch <name>`.
 * Tails the claude debug log, counts consecutive API errors, and when
 * the threshold is reached, triggers recovery via `cdog __recover-from-errors`.
 */
export async function runLogWatcher(agentName: string): Promise<void> {
  const agent = loadState()[agentName];
  if (!agent) {
    process.exit(1);
  }

  const logPath = resolveLogPath(agent);
  if (!logPath) {
    logAgentEvent(agentName, 'logwatcher: no log file, exiting');
    process.exit(1);
  }

  // Load config for threshold
  let acConfig: ResolvedAutoCompactConfig;
  try {
    const cfg = loadConfig(agent.config_path!);
    acConfig = resolveAutoCompactConfig(cfg, true); // hasLog=true: we already resolved logPath above
  } catch {
    process.exit(1);
  }

  if (!acConfig.enabled) {
    process.exit(0);
  }

  const threshold = acConfig.threshold;
  // Per-kind consecutive error counters.
  // Each kind has its own threshold (see interveneThreshold()).
  // On any successful response, ALL counters reset.
  const errorCounters = new Map<ApiErrorKind, number>();
  // Track non-intervening errors (provider/rate_limit) for notify.
  // No threshold — notify on every transient error; dedup is handled by notify()
  // (30s window per agent+event). This is the "just an on/off switch" approach.
  let transientNotifyCount = 0;

  // Restore unknown counter from state (for restart persistence).
  let initialUnknown = agent.api_error_count ?? 0;
  if (initialUnknown > 0) errorCounters.set('unknown', initialUnknown);

  // If the file doesn't exist yet, wait for it
  let waitMs = 0;
  while (!existsSync(logPath) && waitMs < 60_000) {
    // Check if agent was deleted while we waited
    if (!loadState()[agentName]) process.exit(0);
    await sleep(5000);
    waitMs += 5000;
  }
  if (!existsSync(logPath)) {
    logAgentEvent(agentName, `logwatcher: log file never appeared (${logPath}), exiting`);
    process.exit(1);
  }

  logAgentEvent(agentName, `logwatcher: started watching ${logPath} (threshold=${threshold}, unknown=${initialUnknown})`);

  // tail -f the log file
  const tail = spawn('tail', ['-f', '-n', '0', logPath], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  let buffer = '';

  tail.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Successful API activity → reset ALL counters
      if (SUCCESS_RE.test(trimmed)) {
        if (errorCounters.size > 0 || transientNotifyCount > 0) {
          errorCounters.clear();
          transientNotifyCount = 0;
          persistCounter(agentName, 0);
        }
        continue;
      }

      // API error → classify and handle by kind
      if (API_ERROR_RE.test(trimmed)) {
        const kind = classifyApiError(trimmed);
        writeWatcherLog(agentName, `API error: kind=${kind} (line: ${trimmed.slice(0, 120)})`);

        // Read last known ↑ tokens from state (recorded by pane watcher).
        // This allows fast-path: if context was already near-full, act on first error.
        const currentState = loadState()[agentName];
        const lastUpTokens = currentState?.last_up_tokens ?? null;
        const maxTokens = acConfig.maxTokens;
        const kindThreshold = interveneThreshold(kind, threshold, lastUpTokens, maxTokens);

        // Notify on EVERY API error — dedup is handled by notify() (30s window).
        // Includes token context so the user knows whether context is the likely cause.
        const tokenInfo = lastUpTokens !== null
          ? ` (↑ ${lastUpTokens}/${maxTokens} = ${Math.round((lastUpTokens / maxTokens) * 100)}%)`
          : '';
        notify(agentName, 'api-error', agentName,
          `API error (${kind})${tokenInfo}: ${trimmed.slice(0, 100)}`);

        if (kindThreshold !== null) {
          // unknown / timeout → count toward intervention threshold
          const count = (errorCounters.get(kind) ?? 0) + 1;
          errorCounters.set(kind, count);
          // Persist unknown counter for restart persistence.
          if (kind === 'unknown') persistCounter(agentName, count);
          writeWatcherLog(agentName, `${kind} error #${count}/${kindThreshold}${tokenInfo}`);

          if (count >= kindThreshold) {
            // Check cooldown, detached state, and compact-in-progress before triggering
            const now = Date.now();
            const state = loadState()[agentName];
            if (!state) { process.exit(0); }
            if (state.cdog_status === 'detached') {
              writeWatcherLog(agentName, `${kind} threshold reached but detached, skipping`);
              continue;
            }
            if (state.compact_in_progress) {
              writeWatcherLog(agentName, `${kind} threshold reached but compact in progress, skipping`);
              continue;
            }
            const lastRecover = state.last_recover_at ? new Date(state.last_recover_at).getTime() : 0;
            if (now - lastRecover < RECOVER_COOLDOWN_MS) {
              writeWatcherLog(agentName, `${kind} threshold reached but in cooldown, skipping`);
              continue;
            }

            writeWatcherLog(agentName, `${kind} threshold reached (${kindThreshold}), triggering recovery`);
            errorCounters.delete(kind);
            if (kind === 'unknown') persistCounter(agentName, 0);

            // Trigger recovery via `cdog __recover-from-errors <name>`
            const recoverChild = spawn(process.argv[1]!, ['__recover-from-errors', agentName], {
              detached: true,
              stdio: ['ignore', 'ignore', 'ignore'],
            });
            recoverChild.unref();
          }
        } else {
          // fatal / provider / rate_limit → don't compact.
          if (kind === 'fatal') {
            // model_not_found / authentication_failed → model is offline, stop immediately
            writeWatcherLog(agentName, `FATAL error (${kind}): stopping agent — model offline`);
            handleFatalError(agentName, trimmed);
            return; // watcher exits after fatal
          }
          // provider / rate_limit → let claude retry.
          // Notification already sent above (on every API error).
          transientNotifyCount++;
          writeWatcherLog(agentName, `transient error (${transientNotifyCount}x ${kind}), letting claude retry`);
        }
        continue;
      }
    }
  });

  tail.on('exit', () => {
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

/** Persist the error counter to state (throttled by caller). */
function persistCounter(agentName: string, count: number): void {
  try {
    mutateAgent(agentName, (a) => {
      a.api_error_count = count;
    });
  } catch { /* best effort */ }
}

/** Write a small watcher-side log. */
function writeWatcherLog(agentName: string, message: string): void {
  try {
    logAgentEvent(agentName, `logwatcher: ${message}`);
  } catch { /* best effort */ }
}

/**
 * Handle a fatal API error (model_not_found, authentication_failed, etc.).
 *
 * Stops the agent immediately using the marker technique:
 *   1. Type "cdog-stop" marker (no Enter — stays on input line).
 *   2. Send C-c to interrupt claude.
 *   3. Check if marker survived:
 *      - Marker gone → C-c took effect (claude interrupted/killed). Done.
 *      - Marker still there → C-c didn't work. C-u to clear marker.
 *   4. Mark agent as `failed` with fatal_error reason.
 *   5. Kill tmux session.
 *   6. Kill pane watcher (this log watcher exits via return).
 *   7. Send desktop notification.
 *
 * No anti-nudge needed — fatal errors don't trigger Stop hook (claude is killed, not stopped).
 */
function handleFatalError(agentName: string, errorLine: string): void {
  const state = loadState()[agentName];
  if (!state) return;

  const tmuxSession = state.tmux_session ?? agentName;
  const MARKER = 'cdog-stop';

  // 1-3. Marker technique: type marker, C-c, check if it survived
  if (tmuxHasSession(tmuxSession)) {
    try {
      tmuxSendText(tmuxSession, MARKER, false); // no Enter — marker stays on input line
      tmuxSendKey(tmuxSession, 'C-c');
      sleep(500);
      const pane = tmuxCapturePane(tmuxSession, 10);
      if (!pane.includes(MARKER)) {
        // Marker gone → C-c took effect (claude interrupted/killed). Done.
      } else {
        // Marker survived → C-c didn't work. C-u to clear marker, then proceed to kill.
        tmuxSendKey(tmuxSession, 'C-u');
      }
    } catch { /* best effort */ }
  }

  // 4. Mark failed with reason
  try {
    mutateAgent(agentName, (a) => {
      a.claude_status = 'failed';
      a.cdog_status = 'detached';
      a.stop_reason = 'failed';
      a.fatal_error = errorLine.slice(0, 200);
      a.failed_at = new Date().toISOString();
      a.ended_at = new Date().toISOString();
    });
  } catch { /* best effort */ }

  // 5. Kill tmux session
  if (tmuxHasSession(tmuxSession)) {
    try { tmux(['kill-session', '-t', tmuxSession]); } catch { /* best effort */ }
  }

  // 6. Kill pane watcher (this log watcher exits via return)
  killPaneWatcher(agentName);

  // 7. Notify
  notify(agentName, 'agent-failed', agentName,
    `FATAL: model offline — ${errorLine.slice(0, 120)}`).catch(() => {});
}

// ============================================================
// __recover-from-errors command: compact-or-nudge flow
// ============================================================

/**
 * Execute the compact-or-nudge recovery flow triggered by the log watcher.
 *
 * Flow:
 *   1. Write cdog-recover marker (no Enter).
 *   2. Send C-c to break out of error state.
 *   3. Wait for shell prompt.
 *   4. Check if marker survived in pane.
 *   5. C-u to clear input line.
 *   6. Read last_up_tokens from state (recorded by pane watcher).
 *   7. If upTokens >= maxTokens * 0.8 → /compact.
 *   8. Otherwise → send continue prompt (nudge).
 */
export async function recoverFromApiErrors(agentName: string): Promise<void> {
  const agent = loadState()[agentName];
  if (!agent) return;
  if (agent.cdog_status === 'detached') return;

  // Mark recovering timestamp (used for cooldown)
  mutateAgent(agentName, (a) => {
    a.last_recover_at = new Date().toISOString();
  });

  const session = agent.tmux_session;
  if (!tmuxHasSession(session)) {
    logAgentEvent(agentName, 'recover-from-errors: tmux session not alive, skipping');
    return;
  }

  // Load config
  let cfg: CdogConfig | null = null;
  if (agent.config_path && existsSync(agent.config_path)) {
    try { cfg = loadConfig(agent.config_path); } catch { /* ignore */ }
  }
  const acConfig = resolveAutoCompactConfig(cfg ?? { name: agent.name, cwd: '' });

  logAgentEvent(agentName, `recover-from-errors: starting (threshold=${acConfig.threshold}, maxTokens=${acConfig.maxTokens})`);

  // Check liveness
  const liveness = detectLiveness(session);
  if (liveness === 'dead') {
    logAgentEvent(agentName, 'recover-from-errors: session dead, skipping (let hook path handle restart)');
    return;
  }

  // 1. Break to shell (marker → C-c → check marker → C-u)
  const broke = await breakToShell(session, 5000);
  if (!broke) {
    logAgentEvent(agentName, 'recover-from-errors: breakToShell failed (marker survived 2x C-c), aborting to avoid killing wrong process');
    notify(agentName, 'api-error', agentName, 'Recovery aborted: C-c did not take effect (marker survived)');
    return;
  }

  // 2. Compact or nudge based on last_up_tokens
  const { action, upTokens } = compactOrNudge(session, acConfig.maxTokens, acConfig.prompt, agentName);

  if (action === 'compact') {
    logAgentEvent(agentName, `recover-from-errors: → /compact (↑ ${upTokens ?? 'unknown'} tokens, max=${acConfig.maxTokens})`);
    notify(agentName, 'circuit-breaker', agentName, `Auto-compact (↑ ${upTokens ?? 'unknown'} tokens >= ${Math.round(acConfig.maxTokens * 0.8)})`);
  } else {
    logAgentEvent(agentName, `recover-from-errors: → nudge "${acConfig.prompt}" (↑ ${upTokens ?? 'unknown'} tokens, max=${acConfig.maxTokens})`);
    notify(agentName, 'nudge', agentName, `Nudged after ${acConfig.threshold} API errors (↑ ${upTokens ?? 'unknown'} tokens, context OK)`);
  }

  // Reset api_error_count
  mutateAgent(agentName, (a) => {
    a.api_error_count = 0;
  });
}
