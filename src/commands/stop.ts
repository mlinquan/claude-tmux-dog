// cdog stop <name>  — sets cdog_status to 'detached'. Does NOT kill the tmux/claude process.
//                     cdog stops responding to hooks; claude keeps running.
// cdog stop all      — detach every agent.
//
// Optional `stop.abort_work` (cdog.json): when true AND claude is actively
// working (claude_status running/pending), send a single Esc to abort the
// in-progress turn and set claude_status='waiting' — the process stays alive
// (suspend, don't exit). Esc is used (not C-c) so the process isn't at risk of
// exiting; C-c is reserved for the recovery flow (breakToShell).

import { existsSync } from 'node:fs';
import { loadState, mutateAgent } from '../state.js';
import { tmuxHasSession, tmuxChecked } from '../util.js';
import { loadConfig } from '../config.js';
import { logAgentEvent, logSwallow } from '../logger.js';
import { killLogWatcher, clearQuotaNudge } from '../logwatcher.js';
import { killPaneWatcher } from '../panewatcher.js';
import type { AgentState, ClaudeStatus } from '../types.js';

/**
 * Resolve the raw `stop.abort_work` config value to its effective boolean.
 * DEFAULT TRUE: `cdog stop` aborts the in-progress turn unless explicitly
 * disabled with `stop.abort_work: false`. Only an explicit false opts out;
 * undefined (field absent / no config) and true both mean "abort".
 */
export function resolveAbortWork(raw: boolean | undefined): boolean {
  return raw !== false;
}

/** Read stop.abort_work from the agent's cdog.json, defaulting to true. */
function shouldAbortWork(agent: AgentState): boolean {
  let raw: boolean | undefined;
  if (agent.config_path && existsSync(agent.config_path)) {
    try {
      raw = loadConfig(agent.config_path).stop?.abort_work;
    } catch {
      /* fall through to default */
    }
  }
  return resolveAbortWork(raw);
}

/** claude is mid-turn (worth interrupting)? */
export function isWorking(status: ClaudeStatus): boolean {
  return status === 'running' || status === 'pending';
}

/**
 * Pure decision: should `cdog stop` send an Esc to abort claude's in-progress
 * turn? True only when the session is alive, abort_work is enabled, and claude
 * is actively working (running/pending). Extracted so the decision matrix is
 * unit-testable without tmux.
 */
export function decideAbort(opts: {
  abortWork: boolean;
  status: ClaudeStatus;
  sessionAlive: boolean;
}): boolean {
  return opts.sessionAlive && opts.abortWork && isWorking(opts.status);
}

/**
 * Detach an agent: cdog_status → 'detached'. The claude process is left running
 * in tmux untouched; cdog will ignore all subsequent hook events for it
 * (observe-only status recording still happens — see hooks/observe.ts).
 * Also kills the log watcher subprocess (it will be respawned on `cdog restart`).
 *
 * With stop.abort_work enabled and claude actively working, sends one Esc to
 * abort the current turn first (claude_status → 'waiting'); process stays alive.
 */
export async function stopCommand(name: string): Promise<void> {
  const state = loadState();
  const agent = state[name];
  if (!agent) {
    console.error(`✗ agent not found: ${name}`);
    process.exit(1);
  }

  killLogWatcher(name);
  killPaneWatcher(name);
  clearQuotaNudge(name);

  // Watchers are now dead, so no auto-nudge can race with the Esc below.
  const session = agent.tmux_session;
  let aborted = decideAbort({
    abortWork: shouldAbortWork(agent),
    status: agent.claude_status,
    sessionAlive: tmuxHasSession(session),
  });
  if (aborted) {
    try {
      tmuxChecked(['send-keys', '-t', session, 'Escape']);
    } catch (e) {
      // Esc didn't land — claude is still working, so don't claim 'waiting'.
      logSwallow(name, 'stop abort (Esc)', e);
      aborted = false;
    }
  }

  mutateAgent(name, (a) => {
    a.cdog_status = 'detached';
    if (aborted) a.claude_status = 'waiting';
  });

  logAgentEvent(
    name,
    aborted
      ? 'detached + aborted in-progress turn (Esc); claude left alive (waiting)'
      : 'detached (cdog stopped watching, claude left running)',
  );

  const alive = tmuxHasSession(session);
  const tail = aborted
    ? ` — in-progress turn aborted (Esc), claude suspended (waiting)${alive ? ` in ${session}` : ''}`
    : ` — cdog no longer watching${alive ? ` (claude still running in ${session})` : ''}`;
  console.log(`✓ ${name} detached${tail}`);
}

/** `cdog stop all` — detach every agent. One failure doesn't stop the rest. */
export async function stopAll(): Promise<void> {
  const names = Object.keys(loadState()).sort();
  if (names.length === 0) {
    console.log('No agents to stop.');
    return;
  }
  for (const name of names) {
    try {
      await stopCommand(name);
    } catch (e) {
      console.error(`✗ ${name}: ${(e as Error).message}`);
    }
  }
}
