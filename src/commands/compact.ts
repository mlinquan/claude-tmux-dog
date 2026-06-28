// cdog compact <name>
//
// Manual trigger for the compact-or-nudge recovery flow:
//   1. C-c to break out of current state.
//   2. Wait for shell prompt.
//   3. C-u to clear input line.
//   4. Read last_up_tokens from state (recorded by pane watcher).
//   5. If upTokens >= maxTokens * 0.8 → /compact.
//   6. Otherwise → send continue prompt.
//
// This is the same flow used by the log watcher's auto-recovery, but triggered manually.

import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { loadState, mutateAgent } from '../state.js';
import { tmuxHasSession } from '../util.js';
import { logAgentEvent } from '../logger.js';
import { notify } from '../notify.js';
import { resolveAutoCompactConfig } from '../logwatcher.js';
import { breakToShell, compactOrNudge, detectLiveness, DEFAULT_PROMPT } from '../recovery.js';
import type { CdogConfig } from '../types.js';

/**
 * `cdog compact <name>` — manually trigger compact-or-nudge for an agent.
 *
 * Uses the same flow as the log-watcher auto-recovery:
 *   C-c → read last_up_tokens → compact-or-nudge
 */
export async function compactCommand(name?: string): Promise<void> {
  if (!name) {
    console.error('✗ usage: cdog compact <name>');
    process.exit(1);
  }

  const state = loadState();
  const agent = state[name];
  if (!agent) {
    console.error(`✗ agent not found: ${name}`);
    process.exit(1);
  }

  const session = agent.tmux_session;
  if (!tmuxHasSession(session)) {
    console.error(`✗ ${name}: tmux session not running (${session})`);
    process.exit(1);
  }

  // Load config for maxTokens + prompt
  let cfg: CdogConfig | null = null;
  let maxTokens = 200_000;
  let prompt = DEFAULT_PROMPT;

  if (agent.config_path && existsSync(agent.config_path)) {
    try {
      cfg = loadConfig(agent.config_path);
      const ac = resolveAutoCompactConfig(cfg);
      maxTokens = ac.maxTokens;
      prompt = ac.prompt;
    } catch { /* ignore */ }
  }

  logAgentEvent(name, `compact: starting manual compact-or-nudge (maxTokens=${maxTokens})`);
  console.log(`⚡ ${name}: running compact-or-nudge...`);

  // Check liveness
  const liveness = detectLiveness(session);
  if (liveness === 'dead') {
    console.error(`✗ ${name}: session appears dead (pane command not claude/shell)`);
    process.exit(1);
  }

  // 1. Break to shell (marker → C-c → check marker → C-u)
  await breakToShell(session, 5000);

  // 2. Compact or nudge based on last_up_tokens
  const { action, upTokens } = compactOrNudge(session, maxTokens, prompt, name);

  if (action === 'compact') {
    logAgentEvent(name, `compact: → /compact (↑ ${upTokens ?? 'unknown'} tokens, max=${maxTokens})`);
    console.log(`✓ ${name}: /compact (↑ ${upTokens ?? 'unknown'} tokens >= ${Math.round(maxTokens * 0.8)})`);
    await notify(name, 'compact', name, `Manual compact (↑ ${upTokens ?? 'unknown'} tokens)`);
  } else {
    logAgentEvent(name, `compact: → nudge "${prompt}" (↑ ${upTokens ?? 'unknown'} tokens, max=${maxTokens})`);
    console.log(`✓ ${name}: nudge "${prompt}" (↑ ${upTokens ?? 'unknown'} tokens, context OK)`);
    await notify(name, 'nudge', name, `Nudged via compact command (↑ ${upTokens ?? 'unknown'} tokens, context OK)`);
  }

  // Reset api_error_count
  mutateAgent(name, (a) => {
    a.api_error_count = 0;
  });
}
