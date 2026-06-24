// Unified recovery flow shared by notify.ts (hook-driven), logwatcher.ts
// (log-driven), and compact.ts (manual).
//
// Single source of truth for the C-c → marker → compact-or-nudge sequence.
// Eliminates the three previous copy-pasted implementations.
//
// Compact decision is based on last_up_tokens (recorded by pane watcher),
// NOT /context. /context is slow and unreliable. The pane watcher continuously
// records ↑ tokens to state; compactOrNudge reads it instantly.
//
// Compact completion is detected via the PostCompact hook (event-driven, not
// hardcoded delays). The caller sets compact_in_progress + compact_pending_prompt
// in state before sending /compact; the PostCompact hook handler in notify.ts
// reads those fields and sends the nudge.

import { execFileSync } from 'node:child_process';
import { tmuxSendKey, tmuxSendText, tmuxCapturePane, tmux, sleep } from './util.js';
import { loadState, mutateAgent } from './state.js';

export const RECOVER_MARKER = 'cdog-recover';
export const COMPACT_INDICATOR = '/compact';
export const DEFAULT_PROMPT = 'continue';

/** Compact when last_up_tokens >= maxTokens * this ratio. */
export const COMPACT_TOKEN_RATIO = 0.8;

export const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash']);

/** Claude liveness, inferred from the pane's current command. */
export type Liveness = 'claude' | 'shell' | 'dead';

/**
 * Check if a process (by PID) has a descendant named 'claude' or 'node'.
 * Used when the pane's top-level process is a shell — we need to look into
 * the shell's children to see if claude is running inside it.
 */
function hasClaudeDescendant(pid: number): boolean {
  try {
    // pgrep -P <pid> lists direct children. Recursively walk one level deep.
    const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!out) return false;
    const childPids = out.split('\n').filter(Boolean);
    for (const cp of childPids) {
      // ps -o comm= -p <pid> gives the command name (without args).
      const comm = execFileSync('ps', ['-o', 'comm=', '-p', cp], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().toLowerCase();
      if (comm === 'claude' || comm === 'node') return true;
      // Recursively check grandchildren (one level is usually enough, but be thorough).
      if (hasClaudeDescendant(parseInt(cp, 10))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function detectLiveness(tmuxSession: string): Liveness {
  // Get both the command name and the PID of the pane's top-level process.
  const raw = tmux(['list-panes', '-t', tmuxSession, '-F', '#{pane_current_command} #{pane_pid}']);
  const parts = raw.trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const pid = parseInt(parts[1] || '0', 10);

  // Top-level is claude/node → definitely running.
  if (cmd === 'claude' || cmd === 'node') return 'claude';

  // Top-level is a shell → check if the shell has a claude/node child.
  if (SHELLS.has(cmd) && pid > 0) {
    return hasClaudeDescendant(pid) ? 'claude' : 'shell';
  }

  // Unknown command — treat as shell (conservative).
  return 'shell';
}

/**
 * Poll tmux pane until a shell prompt ($, %, #) appears. Returns true if prompt seen.
 */
export async function waitForShellPrompt(session: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = tmuxCapturePane(session, 10);
    const lastLine = pane.split('\n').filter(Boolean).pop() ?? '';
    if (/[$%#]\s*$/.test(lastLine)) return true;
    await sleep(200);
  }
  return false;
}

/**
 * Break out of claude's error state to a clean shell prompt, safely.
 *
 * Uses the cdog-recover marker technique to avoid killing the wrong process:
 *
 *   1. Type the marker text (RECOVER_MARKER) into the input line WITHOUT Enter.
 *   2. Send C-c.
 *   3. Wait for shell prompt.
 *   4. Check if marker survived in the pane:
 *      - marker present → claude was interrupted, marker text left behind → C-u to clear.
 *      - marker gone    → shell was foreground, C-c already cleared the input line → done.
 *
 * Always returns true.
 */
export async function breakToShell(session: string, timeoutMs = 5000): Promise<boolean> {
  // 1. Write marker (no Enter — stays on input line)
  tmuxSendText(session, RECOVER_MARKER, false);
  await sleep(200);

  // 2. Send C-c to break out of the error state
  tmuxSendKey(session, 'C-c');

  // 3. Wait for shell prompt to confirm C-c took effect
  await waitForShellPrompt(session, timeoutMs);

  // 4. marker survived → claude was interrupted, marker text left in pane → C-u to clear
  //    marker gone    → shell was foreground, C-c cleared the input line → nothing to do
  if (markerInPane(session)) {
    tmuxSendKey(session, 'C-u');
    await sleep(300);
  }
  return true;
}

/**
 * Parse the "↑ X.Yk tokens" from claude's status line in the tmux pane.
 *
 * Claude's TUI shows a status line like:
 *   ✻ Jitterbugging… (32m 26s · ↑ 24.6k tokens)
 *
 * The ↑ arrow indicates input/upload tokens (context size sent to the API).
 * Returns the token count as a number, or null if not found / claude idle.
 *
 * Format variations handled:
 *   ↑ 24.6k tokens  → 24600
 *   ↑ 1.2m tokens   → 1200000
 *   ↑ 500 tokens    → 500
 */
export function parsePaneTokens(paneContent: string): { upTokens: number | null } {
  // Match "↑ <number><k/m> tokens" anywhere in the pane
  const match = paneContent.match(/↑\s*([0-9.]+)\s*([km]?)\s*tokens/i);
  if (!match) return { upTokens: null };
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const mult = unit === 'k' ? 1000 : unit === 'm' ? 1_000_000 : 1;
  return { upTokens: Math.round(num * mult) };
}

/**
 * Capture the tmux pane and extract the current ↑ token count.
 * Returns null if claude is idle (no status line) or tokens can't be parsed.
 */
export function getPaneUpTokens(session: string): number | null {
  const pane = tmuxCapturePane(session, 50);
  return parsePaneTokens(pane).upTokens;
}

/** Check whether the RECOVER_MARKER text is visible in the pane (last 50 lines). */
export function markerInPane(session: string, marker = RECOVER_MARKER): boolean {
  const content = tmuxCapturePane(session, 50);
  return content.includes(marker);
}

/**
 * Decide compact vs nudge based on last_up_tokens (recorded by pane watcher).
 *
 *   - last_up_tokens >= maxTokens * 0.8 → /compact (context likely full)
 *   - last_up_tokens < 0.8 or unknown    → send prompt (nudge, safer default)
 *
 * Why not /context: it's slow (30s+) and unreliable. The pane watcher continuously
 * records ↑ tokens to state; we read it instantly. No polling, no timeouts.
 *
 * Why nudge on unknown: /compact is expensive and loses context. If we can't
 * confirm the context is actually full (no token data yet), nudging is the
 * safer default — it lets claude retry without destroying context.
 *
 * Compact completion is detected via the PostCompact hook (event-driven).
 * When we send /compact, we set compact_in_progress + compact_pending_prompt
 * in state. The PostCompact hook handler in notify.ts sends the nudge when
 * claude reports compaction is done. No hardcoded delays.
 *
 * Returns the action taken and the token info observed.
 */
export function compactOrNudge(
  session: string,
  maxTokens: number,
  prompt: string,
  agentName: string,
): { action: 'compact' | 'nudge'; upTokens: number | null; maxTokens: number } {
  const agent = loadState()[agentName];
  const upTokens = agent?.last_up_tokens ?? null;
  const compactThreshold = Math.round(maxTokens * COMPACT_TOKEN_RATIO);

  if (upTokens !== null && upTokens >= compactThreshold) {
    // Set compact_in_progress flag — PostCompact hook will send the nudge.
    mutateAgent(agentName, (a) => {
      a.compact_in_progress = true;
      a.compact_sent_at = new Date().toISOString();
      a.compact_pending_prompt = prompt;
    });
    tmuxSendText(session, COMPACT_INDICATOR, true);
    return { action: 'compact', upTokens, maxTokens };
  }
  // Context is fine OR unknown → nudge (safer than compacting blindly)
  tmuxSendText(session, prompt, true);
  return { action: 'nudge', upTokens, maxTokens };
}
