// cdog nudge <name|all> [text]
//
// Manually send a prompt + Enter to an agent's tmux pane. This is the manual
// counterpart to watchdog.auto_nudge_stop. It is NOT gated on cdog_status:
// a detached agent can still be nudged by the user (detached means "cdog won't
// act automatically", not "the user is forbidden"). Bumps nudge_count.
//
// Text resolution:  args.text  ??  config.watchdog.prompt  ??  "continue"

import { existsSync } from 'node:fs';
import type { CdogConfig } from '../types.js';
import { ALL_KEYWORD } from '../types.js';
import { loadState, mutateAgent } from '../state.js';
import { tmuxHasSession, tmuxSendText } from '../util.js';
import { loadConfig } from '../config.js';
import { logAgentEvent } from '../logger.js';
import { clearQuotaNudge, clearRateLimitFirstAt } from '../logwatcher.js';

const DEFAULT_PROMPT = 'continue';

/** Resolve the nudge text: explicit arg → config prompt → "continue". */
function resolveText(text: string | undefined, cfg: CdogConfig | null): string {
  if (text && text.trim() !== '') return text;
  const p = cfg?.watchdog?.prompt?.trim();
  if (p) return p;
  return DEFAULT_PROMPT;
}

/** Nudge a single agent. Returns true on success. */
export function nudgeCommand(name: string, text?: string): boolean {
  const state = loadState();
  const agent = state[name];
  if (!agent) {
    console.error(`✗ agent not found: ${name}`);
    return false;
  }
  if (!tmuxHasSession(agent.tmux_session)) {
    console.error(`✗ ${name}: tmux session not running (${agent.tmux_session})`);
    return false;
  }

  // If claude is marked as failed but the session is alive, claude likely
  // recovered on its own (e.g. internal retry after authentication_failed).
  // Sync the state before nudging so the prompt has effect.
  if (agent.claude_status === 'failed') {
    mutateAgent(name, (a) => {
      a.claude_status = 'running';
      a.stop_reason = null;
      a.ended_at = null;
    });
    logAgentEvent(name, `nudge: claude_status was failed → running (session alive, pre-nudge sync)`);
  }

  // User takeover — clear rate_limit storm state + pending quota timer.
  clearRateLimitFirstAt(name);
  clearQuotaNudge(name);

  const cfg =
    agent.config_path && existsSync(agent.config_path)
      ? (() => {
          try {
            return loadConfig(agent.config_path!);
          } catch {
            return null;
          }
        })()
      : null;
  const prompt = resolveText(text, cfg);

  tmuxSendText(agent.tmux_session, prompt, true);
  mutateAgent(name, (a) => {
    a.nudge_count = (a.nudge_count ?? 0) + 1;
  });
  logAgentEvent(name, `nudge #${(agent.nudge_count ?? 0) + 1} ("${prompt}")`);
  console.log(`✓ nudged ${name}: ${prompt}`);
  return true;
}

/** `cdog nudge all` — nudge every agent; one failure doesn't stop the rest. */
export function nudgeAll(text?: string): void {
  const names = Object.keys(loadState()).sort();
  if (names.length === 0) {
    console.log('No agents to nudge.');
    return;
  }
  for (const name of names) {
    try {
      nudgeCommand(name, text);
    } catch (e) {
      console.error(`✗ ${name}: ${(e as Error).message}`);
    }
  }
}

/** Dispatch `cdog nudge <name|all> [text...]`. */
export async function nudgeDispatch(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error('✗ usage: cdog nudge <name|all> [text]');
    process.exit(1);
  }
  const target = args[0];
  // Everything after the target is the optional text (joined), so the user can
  // write `cdog nudge snow-agent keep going` without quoting.
  const text = args.slice(1).join(' ').trim() || undefined;
  if (target === ALL_KEYWORD) {
    nudgeAll(text);
  } else {
    const ok = nudgeCommand(target, text);
    if (!ok) process.exit(1);
  }
}
