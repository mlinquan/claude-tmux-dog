// StopFailure recovery handler (cdog-recover marker flow).
//
// Gated on cdog_status === watching + auto_restart.
//
// Flow:
//   StopFailure
//   ↓
//   1. Classify error → fatal / recoverable.
//   2. If fatal → mark failed, no action.
//   3. If recoverable → write "cdog-recover" marker to input line (no Enter)
//                        ↓
//                        tmux send-keys C-c
//                        sleep 1
//                        ↓
//                        Read pane content (last N lines)
//                        ├─ Marker survived (shell input line intact)
//                        │  → Ctrl-U clear marker
//                        │  → /new → cat <md> (if config has md) or claude --resume <sid>
//                        │
//                        ├─ Marker lost (C-c cleared the shell line too)
//                        │  → /new → cat <md> (if config has md) or claude --resume <sid>
//                        │
//                        └─ Session dead
//                           → new-session + claude --resume <sid> (+ cat md)
//
// Step 4: circuit breaker — >=3 recoverable failures in 5min → failed.

import type { StopFailureEvent, CdogConfig, AgentState } from '../types.js';
import { mutateAgent } from '../state.js';
import { buildRecoverCommand } from '../config.js';
import {
  tmuxHasSession,
  tmuxSendText,
  tmux,
  localISO,
  parseTokenCount,
} from '../util.js';
import { enableTmuxTitles } from '../terminal.js';
import { logAgentEvent } from '../logger.js';
import { notify, notifyInteractive } from '../notify.js';
import {
  breakToShell,
  detectLiveness,
  compactOrNudge,
  forceCompact,
} from '../recovery.js';
import { findBySession, reloadConfig, resolvePrompt } from './shared.js';
import {
  FATAL_ERRORS,
  TRANSIENT_ERRORS,
  CONTEXT_SUSPECT_ERRORS,
  CIRCUIT_WINDOW_MS,
  CIRCUIT_MAX_FAILURES,
} from './error-types.js';

function logRawStopFailure(name: string, ev: StopFailureEvent): void {
  const raw = JSON.stringify(ev);
  logAgentEvent(name, `StopFailure raw: ${raw}`);

  const detail = [
    `error=${ev.error ?? 'unknown'}`,
    ev.error_details ? `details=${ev.error_details}` : '',
    ev.last_assistant_message ? `msg_len=${ev.last_assistant_message.length}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
  logAgentEvent(name, `StopFailure summary: ${detail}`);
}

function isContextOverload(ev: StopFailureEvent): boolean {
  const msg = typeof ev.last_assistant_message === 'string' ? ev.last_assistant_message : '';
  // "context window limit" is the definitive full-context signal — and claude
  // often mislabels it (e.g. error=max_output_tokens with this message), so
  // match on the message text regardless of the error type field.
  if (msg.includes('context window limit')) return true;
  return (
    (ev.error === 'unknown' || ev.error === 'invalid_request') &&
    (msg.includes('Request timed out') ||
      msg.includes('timed out') ||
      msg.length > 100_000)
  );
}

async function runPostRecover(session: string, cfg: CdogConfig | null, agent: AgentState, errorType: string): Promise<void> {
  const maxTokens = cfg?.watchdog?.max_tokens
    ? parseTokenCount(cfg.watchdog.max_tokens)
    : 200_000;
  const prompt = resolvePrompt(cfg);
  const { action, upTokens } = compactOrNudge(session, maxTokens, prompt, agent.name);

  if (action === 'compact') {
    logAgentEvent(agent.name, `StopFailure recover: → /compact (↑ ${upTokens ?? 'unknown'} tokens >= ${Math.round(maxTokens * 0.8)})`);
  } else {
    logAgentEvent(agent.name, `StopFailure recover: → nudge "${prompt}" (↑ ${upTokens ?? 'unknown'} tokens < ${Math.round(maxTokens * 0.8)})`);
  }
}

function markFailed(
  name: string,
  errMsg: string,
  failures: number[],
): void {
  mutateAgent(name, (a) => {
    a.claude_status = 'failed';
    a.stop_reason = 'failed';
    a.ended_at = localISO();
    a.last_error = errMsg;
    a.failures = failures;
  });
}

export async function handleStopFailure(ev: StopFailureEvent): Promise<void> {
  const agent = findBySession(ev.session_id);
  if (!agent) return;
  if (agent.cdog_status !== 'watching') return;

  logRawStopFailure(agent.name, ev);

  const errorType = ev.error ?? 'unknown';
  const errSummary = `${ev.error ?? 'error'}: ${ev.error_details ?? ''}`.trim();

  mutateAgent(agent.name, (a) => {
    a.claude_status = 'failed';
    a.stop_reason = 'failed';
    a.ended_at = localISO();
    a.last_error = errSummary;
  });

  const cfgEarly = reloadConfig(agent);
  const willAskInteractively =
    !FATAL_ERRORS.has(errorType) &&
    cfgEarly?.watchdog?.auto_restart === false &&
    cfgEarly?.notify?.interactive === true &&
    cfgEarly?.notify?.enabled === true &&
    (TRANSIENT_ERRORS.has(errorType) || CONTEXT_SUSPECT_ERRORS.has(errorType));
  if (!willAskInteractively) {
    await notify(agent.name, 'api-error', agent.name, `API error: ${errSummary}`);
  }

  const now = Date.now();
  const failures = (agent.failures ?? []).filter((t) => now - t < CIRCUIT_WINDOW_MS);
  failures.push(now);

  const cfg = cfgEarly;
  const autoRestart = cfg?.watchdog?.auto_restart !== false;
  const recoverable = TRANSIENT_ERRORS.has(errorType) || CONTEXT_SUSPECT_ERRORS.has(errorType);

  if (FATAL_ERRORS.has(errorType)) {
    markFailed(agent.name, errSummary, failures);
    logAgentEvent(agent.name, `StopFailure → failed (fatal: ${errorType})`);
    await notify(agent.name, 'agent-failed', agent.name, `Failed (fatal): ${errSummary}`);
    return;
  }

  if (!autoRestart) {
    const interactive = cfg?.notify?.interactive === true && cfg?.notify?.enabled === true;
    if (interactive && recoverable) {
      const choice = await notifyInteractive(
        agent.name,
        'agent-recovered',
        agent.name,
        `API error: ${errSummary}. Restart?`,
        'Restart',
        'Skip',
      );
      logAgentEvent(agent.name, `StopFailure → interactive ask: ${choice}`);
      if (choice === 'close' || choice === 'error') {
        markFailed(agent.name, `${errSummary} (user skipped recovery)`, failures);
        return;
      }
    } else {
      markFailed(agent.name, `${errSummary} (auto_restart disabled)`, failures);
      return;
    }
  }

  const circuitTripped = failures.length >= CIRCUIT_MAX_FAILURES;
  if (circuitTripped) {
    markFailed(
      agent.name,
      `${errSummary} (circuit breaker tripped: ${failures.length} failures in 5m)`,
      failures,
    );
    logAgentEvent(agent.name, `StopFailure → failed (circuit breaker)`);
    await notify(agent.name, 'circuit-breaker', agent.name, `Circuit breaker tripped: ${failures.length} failures in 5m`);
    return;
  }

  if (isContextOverload(ev)) {
    logAgentEvent(agent.name, `StopFailure → context-overload detected, forcing /compact`);

    const session = agent.tmux_session;
    if (tmuxHasSession(session) && detectLiveness(session) !== 'dead') {
      // Context is definitively full — force /compact. Do NOT use compactOrNudge
      // here: in this state last_up_tokens is usually null, so the token%
      // heuristic would mis-decide "nudge", and nudging a full context just
      // re-triggers the same failure (→ circuit breaker → failed).
      await breakToShell(session, 3000);
      const prompt = resolvePrompt(cfg);
      forceCompact(session, prompt, agent.name);
      const nextRestart = (agent.restart_count ?? 0) + 1;
      mutateAgent(agent.name, (a) => {
        a.claude_status = 'running';
        a.stop_reason = null;
        a.ended_at = null;
        a.last_error = errSummary;
        a.last_restart_at = localISO();
        a.restart_count = nextRestart;
        a.failures = failures;
      });
      logAgentEvent(agent.name, `StopFailure context-overload: → forced /compact #${nextRestart}`);
      await notify(agent.name, 'agent-recovered', agent.name, `Context-overload → forced /compact #${nextRestart}`);
      return;
    }
    logAgentEvent(agent.name, 'StopFailure context-overload: session dead, fall through to normal recovery');
  }

  const session = agent.tmux_session;
  const liveness = detectLiveness(session);

  if (!tmuxHasSession(session) || liveness === 'dead') {
    if (!cfg) {
      markFailed(agent.name, `${errSummary} (session dead, no config to relaunch)`, failures);
      return;
    }
    const cmd = buildRecoverCommand(cfg, agent.session_id);
    tmux(['new-session', '-d', '-s', session, '-c', cfg.cwd, cmd]);
    enableTmuxTitles(session); // Linux: title-based click-to-focus
    logAgentEvent(agent.name, `StopFailure recover: new-session + resume (session dead, ${errorType})`);
  } else {
    await breakToShell(session, 3000);
    await runPostRecover(session, cfg, agent, errorType);
  }

  const nextRestart = (agent.restart_count ?? 0) + 1;
  mutateAgent(agent.name, (a) => {
    a.claude_status = 'running';
    a.stop_reason = null;
    a.ended_at = null;
    a.last_error = errSummary;
    a.last_restart_at = localISO();
    a.restart_count = nextRestart;
    a.failures = failures;
  });
  await notify(agent.name, 'agent-recovered', agent.name, `Recovered #${nextRestart} (${errorType})`);
}
