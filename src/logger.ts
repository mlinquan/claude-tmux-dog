// cdog operation logger — writes per-agent `[name] | <time> <msg>` lines.
//
// Per v2 §3: cdog's own log is written ONLY when the agent's config sets
// `log_file` (resolved to an absolute path at start and stored on the state).
// If no log_file_path is recorded, cdog writes no operation log.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentState } from './types.js';
import { loadState, mutateAgent } from './state.js';
import { formatTime, namePrefix, plainNamePrefix, DEFAULT_TIMEFORMAT } from './util.js';
// AgentState imported only for the startedLine helper type.

/**
 * Append a cdog operation-log line for an agent.
 * Format: `[name]            | <ISO-8601> message`
 * The timestamp is written as raw ISO-8601 (UTC, sortable, unambiguous);
 * `cdog log` reformats it to the agent's `timeformat` at display time.
 * No-op if the agent has no `log_file_path` configured.
 */
export function logAgentEvent(name: string, message: string): void {
  const agent = loadState()[name];
  if (!agent) return;
  const path = agent.log_file_path;
  if (!path) return; // no log_file configured → write nothing

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* ignore */
  }
  const ts = new Date().toISOString();
  // Plain line for the file (no ANSI): fixed-width [name] (26 chars) + | + ISO + msg
  const prefix = plainNamePrefix(name);
  const line = `${prefix}| ${ts} ${message}\n`;
  try {
    appendFileSync(path, line, 'utf8');
  } catch {
    /* best effort */
  }
}

/** Also echo the colored line to stderr (so it doesn't pollute stdout pipelines).
 *  The stderr echo uses the agent's display `timeformat` (not the on-disk ISO). */
export function logAndEcho(name: string, message: string): void {
  logAgentEvent(name, message);
  const agent = loadState()[name];
  const ts = formatTime(Date.now(), agent?.timeformat || DEFAULT_TIMEFORMAT);
  process.stderr.write(`${namePrefix(name)} | ${ts} ${message}\n`);
}

/**
 * Mark a tmux session gone (status corrections). Convenience wrapper that also
 * logs. Kept here for cohesion; the actual status write is in state.
 */
export function markDead(name: string): void {
  mutateAgent(name, (a) => {
    if (a.claude_status === 'running') {
      a.claude_status = 'stopped';
      a.stop_reason = 'stopped';
      a.ended_at = a.ended_at ?? new Date().toISOString();
    }
  });
  logAgentEvent(name, 'tmux session gone');
}

/** Human summary of an AgentState for the operation log. */
export function startedLine(agent: AgentState): string {
  return `✓ started, session=${agent.session_id.slice(0, 8)}, tmux=${agent.tmux_session}`;
}
