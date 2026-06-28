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
import dayjs from 'dayjs';
import type { AgentState, CdogConfig } from './types.js';
import { loadState, mutateAgent } from './state.js';
import { loadConfig, buildRecoverCommand } from './config.js';
import { tmuxHasSession, sleep, parseTokenCount, parseDuration } from './util.js';
import { tmux, tmuxSendKey, tmuxSendText } from './util.js';
import { killPaneWatcher } from './panewatcher.js';
import { enableTmuxTitles } from './terminal.js';
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
const QUOTA_NUDGE_DELAY_SEC = 30; // wait 30s after quota reset before nudging
const DEFAULT_STALL_TIMEOUT_MS = 5 * 60_000; // no real activity for 5min → stall
const DEFAULT_STALL_COOLDOWN_MS = 10 * 60_000; // cooldown after stall-triggered nudge

// ---- API error line regex ----
// Matches: 2026-06-22T19:40:41.805Z [ERROR] API error (attempt 1/11): ...
export const API_ERROR_RE = /\[ERROR\]\s+API error/;

// ---- Quota reset time parser ----
// Matches English: "It will reset at 2026-06-24 07:07:31 +0800 CST"
// Matches English: "It will reset at 2026-06-24 07:07:31"
// Matches Chinese: "您的限额将在 2026-06-24 17:41:17 重置"
// Matches Chinese: "将在 2026-06-24 17:41:17 重置"
export const QUOTA_RESET_RE = /(?:reset at|将在)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\s+[+-]\d{4})?)/i;

/**
 * Parse quota reset time from an API error line.
 * Returns the reset Date, or null if no reset time found.
 *
 * Example input:
 *   "429 AccountQuotaExceeded ... It will reset at 2026-06-24 07:07:31 +0800 CST ..."
 *   "...您的限额将在 2026-06-24 22:18:49 重置..."
 *
 * The timezone offset in the message is "+0800" (no colon), which dayjs doesn't
 * parse natively. We normalize it to "+08:00" first.
 *
 * Uses dayjs for explicit local-time parsing (new Date has ES5/ES6 timezone
 * ambiguity on timezone-less ISO strings). Strings without a timezone offset are
 * parsed as the provider's local time (= cdog host local time, by default UTC+8
 * for Chinese providers).
 */
export function parseQuotaResetTime(line: string): Date | null {
  const match = line.match(QUOTA_RESET_RE);
  if (!match) return null;
  let raw = match[1].trim();
  // Normalize timezone: "+0800" → "+08:00", "-0500" → "-05:00"
  raw = raw.replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3');
  // dayjs parses no-timezone strings as local time (explicit, unlike new Date)
  const dt = dayjs(raw);
  if (!dt.isValid()) return null;
  return dt.toDate();
}

// ---- Successful response indicators (resets error counter) ----
// Real claude debug log markers for a successful API response:
//   "Stream started - received first chunk"  → stream began (strong success signal)
//   "[API REQUEST]"                          → a new request dispatched (claude recovered)
//   "tool_dispatch_start"                     → tool execution (response was processed)
export const SUCCESS_RE = /Stream started - received first chunk|\[API REQUEST\]|tool_dispatch_start/;
// Real recovery signal — only stream/tool count as genuine success for clearing
// rate_limit storm state. [API REQUEST] fires on every dispatched request including
// ones that immediately 429, so it must NOT trigger the rate_limit recovery clear.
export const REAL_SUCCESS_RE = /Stream started - received first chunk|tool_dispatch_start/;

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
  // Provider capacity/routing errors (temporary, self-recovers): classify FIRST.
  // new-api gateway returns 503 with code=model_not_found + "no available channel"
  // — this is a temporary capacity/routing issue, NOT the model being permanently
  // offline. Must be checked before the model_not_found fatal check below.
  // Concurrent limit exceeded is also a temporary capacity issue (too many parallel
  // requests), not a quota limit — should be provider, not rate_limit.
  if (/no available channel|new_api_error|no available model|Concurrent limit exceeded/i.test(line)) return 'provider';
  // Fatal: model_not_found / authentication_failed / billing_error / oauth_org_not_allowed
  // → model offline or auth issue, stop immediately
  if (/model_not_found|authentication_failed|billing_error|oauth_org_not_allowed/i.test(line)) return 'fatal';
  // Rate limit (quota exceeded, not concurrent)
  if (/rate.?limit|公平使用|frequency|429/i.test(line)) return 'rate_limit';
  // Provider errors: 503, upstream error, overloaded_error (model busy)
  // NOTE: overloaded_error = "该模型当前访问量过大" = provider overloaded, NOT context full
  // Provider errors: 503, upstream error, overloaded_error (model busy), AND
  // upstream-5xx status codes (500/502/520-523/525-527). 521 = Cloudflare
  // "origin is down" — the model provider is unreachable, compact won't help.
  // Leave it to claude's own retry (don't C-c + nudge mid-storm). The stall
  // watchdog (5min) backstops: if claude goes silent, it nudges once to retry.
  // NOTE: 524 is excluded — it's a Cloudflare timeout, handled as 'timeout' below.
  if (/503|upstream error|overloaded_error|访问量过大|稍后再试|\b(50[02]|52[0-37-9])\b/i.test(line)) return 'provider';
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
  /** rate_limit two-hit confirmation window in minutes. Default 10. */
  rateLimitConfirmMinutes: number;
  /** Stall detection: no real activity for this long → breakToShell + nudge. Default 5min. */
  stallTimeoutMs: number;
  /** Cooldown after a stall-triggered nudge. Default 10min. */
  stallCooldownMs: number;
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
  const prompt = cfg.watchdog?.prompt ?? DEFAULT_PROMPT;
  return {
    enabled: true,
    threshold: ac?.threshold ?? DEFAULT_THRESHOLD,
    prompt,
    maxTokens: parseTokenCount(cfg.watchdog?.max_tokens) || 200_000,
    rateLimitConfirmMinutes: ac?.rate_limit_confirm_minutes ?? 10,
    stallTimeoutMs: parseDuration(cfg.watchdog?.stall_timeout) || DEFAULT_STALL_TIMEOUT_MS,
    stallCooldownMs: parseDuration(cfg.watchdog?.stall_cooldown) || DEFAULT_STALL_COOLDOWN_MS,
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
    // Kill the whole process group (watcher + tail child) — detached: true
    process.kill(-pid);
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

  // ---- Stall watchdog ----
  // A single setTimeout that resets on every real activity (SUCCESS_RE match:
  // tool_dispatch_start / [API REQUEST] / Stream started). If it fires (no real
  // activity for stallTimeoutMs), claude is stuck (Wibbling but no output) →
  // breakToShell + nudge. Cooldown (stallCooldownMs) prevents nudge loops.
  // No state persistence, no extra polling — the timer itself is the detector.
  let stallWatchdog: NodeJS.Timeout | null = null;
  let lastStallAt = 0;
  const armStallWatchdog = (): void => {
    if (stallWatchdog) clearTimeout(stallWatchdog);
    stallWatchdog = setTimeout(() => {
      stallWatchdog = null;
      const now = dayjs().valueOf();
      if (now - lastStallAt < acConfig.stallCooldownMs) {
        // Still in cooldown — re-arm and wait
        writeWatcherLog(agentName, `stall timer fired but in cooldown (${Math.round((acConfig.stallCooldownMs - (now - lastStallAt)) / 60_000)}min left), re-arming`);
        armStallWatchdog();
        return;
      }
      lastStallAt = now;
      const cs = loadState()[agentName];
      // Suppress while a /compact is in flight — claude is legitimately busy
      // summarizing context (can take minutes on a large context), and C-c'ing
      // it would abort the compact. Re-arm and wait for PostCompact.
      if (cs?.compact_in_progress) {
        writeWatcherLog(agentName, `stall timer fired but /compact in progress — suppressing nudge, re-arming`);
        armStallWatchdog();
        return;
      }
      // Cross-check with the pane watcher: if it recorded real token activity
      // (last_up_tokens_at) within the stall window, Claude IS working — the
      // debug-log tail is likely blind (e.g. rotation), not actually stalled.
      // Suppress the nudge so we don't interrupt real work, and re-arm.
      if (cs) {
        const lastTokensAt = cs.last_up_tokens_at ? dayjs(cs.last_up_tokens_at).valueOf() : 0;
        const tokenAge = now - lastTokensAt;
        if (lastTokensAt > 0 && tokenAge < acConfig.stallTimeoutMs) {
          writeWatcherLog(agentName, `stall timer fired but pane-watcher saw token activity ${Math.round(tokenAge / 1000)}s ago — log tail may be blind, suppressing nudge`);
          armStallWatchdog();
          return;
        }
      }
      writeWatcherLog(agentName, `STALL detected: no real activity for ${Math.round(acConfig.stallTimeoutMs / 60_000)}min, breakToShell + nudge`);
      // A stall kicks claude with a nudge, so notify as 'nudge' (plays nudge.mp3),
      // NOT 'api-error' — claude is idle/stuck, not failing.
      notify(agentName, 'nudge', agentName, `Stall detected (no activity ${Math.round(acConfig.stallTimeoutMs / 60_000)}min) — nudging`).catch(() => {});
      const session = loadState()[agentName]?.tmux_session ?? agentName;
      if (tmuxHasSession(session)) {
        breakToShell(session)
          .then(() => nudgeAgentFromWatcher(agentName, session))
          .catch(() => nudgeAgentFromWatcher(agentName, session));
      }
      // Re-arm so we keep watching after the nudge
      armStallWatchdog();
    }, acConfig.stallTimeoutMs);
  };

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

  // Arm the stall watchdog at startup so a startup-stuck agent is caught even
  // before the first real activity line. Subsequent SUCCESS_RE matches reset it.
  armStallWatchdog();

  // tail -F the log file. -F (uppercase) follows by NAME, so it reopens the
  // file when Claude rotates it (rename → .log.1, new .log created) — prevents
  // the watcher from going blind after rotation. NOT detached: the tail stays
  // in the watcher's process group so `process.kill(-watcherPid)` reaches it.
  const tail = spawn('tail', ['-F', '-n', '0', logPath], {
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
        // Real activity (stream/tool) resets the stall watchdog AND clears
        // rate_limit storm state. [API REQUEST] alone does NEITHER — it only
        // means a request was dispatched, not that it succeeded, so a 5xx storm
        // (only [API REQUEST], never a stream) must NOT reset the 5min health
        // timer. This is what lets the stall watchdog catch sustained failures:
        // no real success for 5min → nudge once to probe.
        if (REAL_SUCCESS_RE.test(trimmed)) {
          armStallWatchdog(); // real success → reset health timer
          clearRateLimitFirstAt(agentName);
          clearQuotaNudge(agentName);
        }
        continue;
      }

      // API error → classify and handle by kind
      if (API_ERROR_RE.test(trimmed)) {
        const kind = classifyApiError(trimmed);
        writeWatcherLog(agentName, `API error: kind=${kind} (line: ${trimmed})`);

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
          `API error (${kind})${tokenInfo}: ${trimmed}`);

        if (kindThreshold !== null) {
          // unknown / timeout → count toward intervention threshold
          const count = (errorCounters.get(kind) ?? 0) + 1;
          errorCounters.set(kind, count);
          // Persist unknown counter for restart persistence.
          if (kind === 'unknown') persistCounter(agentName, count);
          writeWatcherLog(agentName, `${kind} error #${count}/${kindThreshold}${tokenInfo}`);

          if (count >= kindThreshold) {
            // Check cooldown, detached state, and compact-in-progress before triggering
            const now = dayjs().valueOf();
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
            const lastRecover = state.last_recover_at ? dayjs(state.last_recover_at).valueOf() : 0;
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
            handleFatalError(agentName, trimmed).catch(() => {});
            return; // watcher exits after fatal
          }
          if (kind === 'rate_limit') {
            const resetTime = parseQuotaResetTime(trimmed);
            const tmuxSession = currentState?.tmux_session ?? agentName;
            const confirmMinutes = acConfig.rateLimitConfirmMinutes;
            const firstAt = currentState?.rate_limit_first_at ?? null;

            // ── 429 + resetTime: two-hit confirmation (high priority) ──
            // resetTime means the error carries "reset at 2026-06-28 21:34:21"
            // (AccountQuotaExceeded) — a definitive quota exhaustion signal.
            // Subsequent 429s may flood in as claude internally retries.
            if (resetTime) {
              const deltaMs = firstAt ? dayjs().valueOf() - dayjs(firstAt).valueOf() : Infinity;
              writeWatcherLog(agentName, `rate_limit with resetTime: firstAt=${firstAt ?? 'null'}, deltaMs=${deltaMs === Infinity ? 'Infinity' : Math.round(deltaMs / 1000) + 's'}, quotaTimers=${quotaTimers.has(agentName)}`);

              // First hit: no record or expired
              if (firstAt === null || deltaMs >= confirmMinutes * 60_000) {
                rateLimitFirstHit(agentName, tmuxSession,
                  firstAt === null ? 'no prior record'
                    : `delta=${Math.round(deltaMs / 60_000)}min >= ${confirmMinutes}min`);
              } else if (quotaTimers.has(agentName)) {
                // Timer already set → skip burst 429s
                writeWatcherLog(agentName, `rate_limit with resetTime, nudge already scheduled, skipping burst`);
              } else {
                // Confirmed — schedule quota nudge
                writeWatcherLog(agentName, `rate_limit confirmed, scheduling quota nudge`);
                mutateAgent(agentName, (a) => { a.claude_status = 'pending'; });
                scheduleQuotaNudge(agentName, resetTime, trimmed);
                if (tmuxHasSession(tmuxSession)) {
                  breakToShell(tmuxSession).catch(() => {});
                }
              }
              continue;
            }
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
    if (stallWatchdog) clearTimeout(stallWatchdog);
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
 * Clear rate_limit_first_at — the SOLE entry point for clearing the two-hit
 * counter. Called only on genuine recovery (stream/tool success) or user
 * takeover (manual stop/restart/nudge). No time-guard: stream/tool never fires
 * during a quota storm (every request 429s before streaming), so it's a
 * definitive "storm over" signal.
 */
export function clearRateLimitFirstAt(agentName: string): void {
  try {
    mutateAgent(agentName, (a) => {
      a.rate_limit_first_at = null;
    });
  } catch { /* best effort */ }
}

/**
 * Nudge agent from logwatcher: resolve prompt from config, send it,
 * increment nudge_count. Self-contained (no clearQuotaNudge, unlike nudgeCommand).
 */
function nudgeAgentFromWatcher(agentName: string, tmuxSession: string): void {
  const state = loadState()[agentName];
  let prompt = DEFAULT_PROMPT;
  try {
    if (state?.config_path) {
      const cfg = loadConfig(state.config_path);
      prompt = cfg.watchdog?.prompt ?? DEFAULT_PROMPT;
    }
  } catch { /* best effort */ }
  try {
    tmuxSendText(tmuxSession, prompt, true);
    mutateAgent(agentName, (a) => {
      a.nudge_count = (a.nudge_count ?? 0) + 1;
    });
    writeWatcherLog(agentName, `nudge #${(loadState()[agentName]?.nudge_count ?? 0)} ("${prompt}")`);
  } catch (e) {
    writeWatcherLog(agentName, `nudge failed: ${(e as Error).message}`);
  }
}

/**
 * First-hit action for rate_limit two-hit confirmation:
 * record timestamp, break to shell, nudge once.
 */
function rateLimitFirstHit(agentName: string, tmuxSession: string, reason: string): void {
  const ts = dayjs().toISOString();
  mutateAgent(agentName, (a) => {
    a.rate_limit_first_at = ts;
  });
  writeWatcherLog(agentName, `rate_limit first hit (${reason}), firstAt=${ts}`);
  if (tmuxHasSession(tmuxSession)) {
    breakToShell(tmuxSession)
      .then(() => nudgeAgentFromWatcher(agentName, tmuxSession))
      .catch(() => nudgeAgentFromWatcher(agentName, tmuxSession));
  } else {
    nudgeAgentFromWatcher(agentName, tmuxSession);
  }
}

/**
 * Handle a fatal API error (model_not_found, authentication_failed, etc.).
 *
 * Stops the agent immediately using breakToShell (marker → C-c → C-u):
 *   1. breakToShell to interrupt claude and get to a clean shell prompt.
 *   2. Mark agent as `failed` with fatal_error reason.
 *   3. Kill tmux session.
 *   4. Kill pane watcher (this log watcher exits via return).
 *   5. Send desktop notification.
 *
 * No anti-nudge needed — fatal errors don't trigger Stop hook (claude is killed, not stopped).
 */
async function handleFatalError(agentName: string, errorLine: string): Promise<void> {
  const state = loadState()[agentName];
  if (!state) return;

  const tmuxSession = state.tmux_session ?? agentName;

  // 1. breakToShell: marker → C-c → check → C-u (stop claude's retry churn, but
  //    DON'T kill the tmux session — keep claude/context alive for the user to
  //    inspect. This is a "suspend", not a kill: mark failed + detach + stop
  //    watchers, wait for the user to `cdog restart` after fixing the cause.)
  if (tmuxHasSession(tmuxSession)) {
    try {
      await breakToShell(tmuxSession);
    } catch { /* best effort */ }
  }

  // 2. Suspend: mark failed + detach (stop monitoring), keep tmux alive
  try {
    mutateAgent(agentName, (a) => {
      a.claude_status = 'failed';
      a.cdog_status = 'detached';
      a.stop_reason = 'failed';
      a.fatal_error = errorLine;
      a.failed_at = dayjs().toISOString();
      a.ended_at = dayjs().toISOString();
    });
  } catch { /* best effort */ }

  // 3. Kill watchers (this log watcher exits via return); tmux/claude left alive
  killPaneWatcher(agentName);

  // 4. Notify
  notify(agentName, 'agent-failed', agentName,
    `FATAL: suspended (not killed) — ${errorLine}`).catch(() => {});
}

// Track active quota timers per agent to avoid duplicate scheduling
const quotaTimers = new Map<string, NodeJS.Timeout>();

// rate_limit_first_at lives in state.json; the sole clearing entry point is
// clearRateLimitFirstAt (called on stream/tool recovery or user takeover).
// No longer spuriously cleared by [API REQUEST] or hook events.

/**
 * Cancel a pending quota nudge timer + clear next_nudge_at + reset claude_status.
 * Called only on genuine recovery (stream/tool) or user takeover (manual
 * stop/restart/nudge). Does NOT touch rate_limit_first_at — that's
 * clearRateLimitFirstAt's sole job.
 */
export function clearQuotaNudge(agentName: string): void {
  const timer = quotaTimers.get(agentName);
  if (timer) {
    clearTimeout(timer);
    quotaTimers.delete(agentName);
  }
  try {
    mutateAgent(agentName, (a) => {
      a.next_nudge_at = null;
      if (a.claude_status === 'pending') {
        a.claude_status = 'running';
      }
    });
  } catch { /* best effort */ }
}

/**
 * Schedule a nudge after the quota reset time + delay.
 *
 * When Claude Code hits AccountQuotaExceeded, the error message includes a reset
 * time (e.g. "It will reset at 2026-06-24 07:07:31 +0800 CST"). We parse that,
 * wait until reset + 30s, then send a nudge to resume work.
 *
 * If the reset time has already passed, nudge immediately.
 * If a timer is already scheduled for this agent, the earlier one wins (no reschedule).
 */
function scheduleQuotaNudge(agentName: string, resetTime: Date, errorLine: string): void {
  // Don't schedule duplicate timers
  if (quotaTimers.has(agentName)) {
    writeWatcherLog(agentName, `quota nudge already scheduled, skipping`);
    return;
  }

  const now = dayjs().valueOf();
  const resetMs = dayjs(resetTime).valueOf();
  const waitMs = Math.max(0, resetMs - now) + QUOTA_NUDGE_DELAY_SEC * 1000;
  const resetLocal = dayjs(resetTime).format('YYYY-MM-DD HH:mm:ss');

  if (waitMs <= QUOTA_NUDGE_DELAY_SEC * 1000) {
    // Reset time already passed — nudge soon (just the delay)
    writeWatcherLog(agentName, `quota reset already passed (${resetLocal}), nudging in ${QUOTA_NUDGE_DELAY_SEC}s`);
  } else {
    const waitMin = Math.round(waitMs / 60_000);
    writeWatcherLog(agentName, `quota exceeded, reset at ${resetLocal}, scheduling nudge in ${waitMin}min`);
  }

  // Record next nudge time in state for status display
  const nudgeAt = dayjs(now + waitMs);
  try {
    mutateAgent(agentName, (a) => {
      a.next_nudge_at = nudgeAt.toISOString();
    });
  } catch { /* best effort */ }

  const timer = setTimeout(() => {
    quotaTimers.delete(agentName);

    // Clear next_nudge_at — nudge is firing now
    try {
      mutateAgent(agentName, (a) => {
        a.next_nudge_at = null;
      });
    } catch { /* best effort */ }

    // Check if agent is still alive and watching
    const state = loadState()[agentName];
    if (!state) {
      writeWatcherLog(agentName, `quota nudge fired but agent gone, skipping`);
      return;
    }
    if (state.cdog_status === 'detached') {
      writeWatcherLog(agentName, `quota nudge fired but detached, skipping`);
      return;
    }

    const tmuxSession = state.tmux_session ?? agentName;
    const sessionId = state.session_id;

    // Read prompt from config
    let prompt = DEFAULT_PROMPT;
    let cfg: CdogConfig | null = null;
    try {
      if (state.config_path) {
        cfg = loadConfig(state.config_path);
        prompt = cfg.watchdog?.prompt ?? DEFAULT_PROMPT;
      }
    } catch { /* best effort */ }

    if (!tmuxHasSession(tmuxSession)) {
      // tmux session died (claude exited after quota errors) — recreate it
      // with `claude --resume` to continue the same conversation.
      writeWatcherLog(agentName, `quota reset reached, tmux dead — recreating session with --resume`);
      try {
        if (cfg) {
          const recoverCmd = buildRecoverCommand(cfg, sessionId);
          tmux(['new-session', '-d', '-s', tmuxSession, '-c', cfg.cwd, recoverCmd]);
          enableTmuxTitles(tmuxSession); // Linux: title-based click-to-focus
          // Update state
          mutateAgent(agentName, (a) => {
            a.claude_status = 'running';
            a.cdog_status = 'watching';
            a.stop_reason = null;
            a.ended_at = null;
          });
          // Wait for claude to start, then nudge
          setTimeout(() => {
            if (tmuxHasSession(tmuxSession)) {
              writeWatcherLog(agentName, `session recreated, nudging with "${prompt}"`);
              try { tmuxSendText(tmuxSession, prompt, true); } catch { /* best effort */ }
            }
          }, 3000);
        }
      } catch (e) {
        writeWatcherLog(agentName, `failed to recreate session: ${(e as Error).message}`);
      }
    } else {
      // tmux session alive — claude is still running (C-c only interrupted it)
      // just nudge to resume work
      writeWatcherLog(agentName, `quota reset reached, nudging with "${prompt}"`);
      mutateAgent(agentName, (a) => {
        a.claude_status = 'running';
      });
      try { tmuxSendText(tmuxSession, prompt, true); } catch { /* best effort */ }
    }

    // Notify
    notify(agentName, 'nudge', agentName,
      `Quota reset — auto-nudge sent`).catch(() => {});
  }, waitMs);

  quotaTimers.set(agentName, timer);
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
    a.last_recover_at = dayjs().toISOString();
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
  await breakToShell(session, 5000);

  // 2. Compact or nudge based on last_up_tokens
  const { action, upTokens } = compactOrNudge(session, acConfig.maxTokens, acConfig.prompt, agentName);

  if (action === 'compact') {
    logAgentEvent(agentName, `recover-from-errors: → /compact (↑ ${upTokens ?? 'unknown'} tokens, max=${acConfig.maxTokens})`);
    notify(agentName, 'compact', agentName, `Auto-compact (↑ ${upTokens ?? 'unknown'} tokens >= ${Math.round(acConfig.maxTokens * 0.8)})`);
  } else {
    logAgentEvent(agentName, `recover-from-errors: → nudge "${acConfig.prompt}" (↑ ${upTokens ?? 'unknown'} tokens, max=${acConfig.maxTokens})`);
    notify(agentName, 'nudge', agentName, `Nudged after ${acConfig.threshold} API errors (↑ ${upTokens ?? 'unknown'} tokens, context OK)`);
  }

  // Reset api_error_count
  mutateAgent(agentName, (a) => {
    a.api_error_count = 0;
  });
}
