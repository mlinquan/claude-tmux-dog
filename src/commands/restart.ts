// cdog restart <name>  — Re-watch a detached agent (never kills claude).
// cdog restart all      — Re-watch every detached agent.
//
// This is the counterpart to `cdog stop`:
//   - stop  → detach cdog (cdog_status = 'detached'), kill watchers
//   - restart → re-attach cdog (cdog_status = 'watching'), respawn watchers
//
// Never kills the claude process. Only manages cdog's monitoring state.
//
// Kick-on-idle: after re-attaching, if claude is alive but NOT actively working
// (claude_status != 'running'), send a nudge to get it moving. The kick is
// skipped when claude was just relaunched via --resume (that path re-inits with
// the task md) or when claude is mid-turn (don't interrupt real work).

import { existsSync } from 'node:fs';
import { loadState, mutateAgent } from '../state.js';
import { tmuxHasSession, parseDuration, tmux, tmuxSendText } from '../util.js';
import { logAgentEvent } from '../logger.js';
import { loadConfig, buildRecoverCommand } from '../config.js';
import { spawnLogWatcher } from '../logwatcher.js';
import { spawnPaneWatcher } from '../panewatcher.js';
import { killLogWatcher, clearQuotaNudge, clearRateLimitFirstAt } from '../logwatcher.js';
import { killPaneWatcher } from '../panewatcher.js';
import { detectLiveness } from '../recovery.js';
import { resolvePrompt } from '../hooks/shared.js';
import { hooksInstalled, hooksConfigured, installHookScripts, mergeHookSettings } from '../hooks.js';

/**
 * `cdog restart <name>` — re-watch a detached agent.
 *
 *   - Sets cdog_status back to 'watching'
 *   - Kills any existing watchers (in case they're orphaned)
 *   - If claude died (pane is a shell, not claude) → restart claude via --resume
 *   - If claude is alive but idle → send a nudge kick (skip if mid-turn or just relaunched)
 *   - Resets per_watch_deadline (fresh watch window starts now)
 *   - Respawns fresh log + pane watchers
 */
export async function restartCommand(name: string): Promise<void> {
  const state = loadState();
  const agent = state[name];
  if (!agent) {
    console.error(`✗ agent not found: ${name}`);
    process.exit(1);
  }

  const session = agent.tmux_session;
  if (!tmuxHasSession(session)) {
    console.error(`✗ ${name}: tmux session not running (${session})`);
    console.error(`  Use \`cdog start ${agent.config_path ?? '<config>'}\` to recreate it.`);
    process.exit(1);
  }

  // Kill any existing watchers (in case they're orphaned)
  killLogWatcher(name);
  killPaneWatcher(name);

  // Clear stale rate_limit storm state + quota nudge — new watcher process will
  // reschedule if needed. User takeover (fresh start).
  clearRateLimitFirstAt(name);
  clearQuotaNudge(name);

  // Auto-init hooks if missing/incomplete (claude settings can get reset by
  // updates/other tools, and historical cdog versions didn't install all 7
  // hooks — e.g. UserPromptSubmit). Without it, a nudged agent stays "waiting"
  // because no hook fires to set it "running".
  if (!hooksInstalled() || !hooksConfigured()) {
    console.log(`⚙ ${name}: hooks missing/incomplete — running cdog init automatically...`);
    installHookScripts();
    const ok = mergeHookSettings();
    if (ok) {
      console.log('✓ hooks installed and configured');
    } else {
      console.warn('⚠ hooks auto-init failed — run `cdog init` manually');
    }
  }

  // Detect whether claude is still running inside the pane.
  // If it died (e.g. user C-c'd it, pane is now a shell), restart it via --resume.
  // Track whether we relaunched so we know NOT to kick (relaunch re-inits via md).
  const liveness = detectLiveness(session);

  // Load config ONCE (best-effort) — reused for the recover command, the watch
  // deadline, and the kick prompt. Previously this read the cdog.json from disk
  // up to three times per restart.
  const cfg =
    agent.config_path && existsSync(agent.config_path)
      ? (() => {
          try { return loadConfig(agent.config_path); } catch { return null; }
        })()
      : null;

  let resumed = false;
  if (liveness !== 'claude') {
    if (cfg && agent.session_id) {
      try {
        const recoverCmd = buildRecoverCommand(cfg, agent.session_id);
        // Launch claude inside the existing pane (session is alive, just a shell)
        tmux(['send-keys', '-t', session, recoverCmd, 'Enter']);
        logAgentEvent(name, `restart: claude not running (pane=${liveness}), relaunched via --resume ${agent.session_id}`);
        console.log(`↻ ${name}: claude was not running, relaunched (--resume ${agent.session_id.slice(0, 8)})`);
        resumed = true;
      } catch (e) {
        logAgentEvent(name, `restart: failed to relaunch claude: ${(e as Error).message}`);
      }
    }
    if (!resumed) {
      console.error(`✗ ${name}: claude not running and could not relaunch`);
      console.error(`  Use \`cdog start ${agent.config_path ?? '<config>'}\` instead.`);
      process.exit(1);
    }
  }

  // Snapshot the *pre-reattach* claude_status. mutateAgent below may flip
  // completed/failed → starting, which would hide whether claude was idle.
  const wasWorking = agent.claude_status === 'running';

  // Re-read per_watch_duration from config and reset the deadline.
  // Each restart starts a fresh watch window.
  let watchDeadline: number | null = null;
  let watchDur: string | undefined;
  if (cfg) {
    watchDur = cfg.watchdog?.per_watch_duration;
    const watchMs = parseDuration(watchDur);
    watchDeadline = watchMs > 0 ? Date.now() + watchMs : null;
  }

  // Re-attach cdog monitoring + reset watch window
  mutateAgent(name, (a) => {
    a.cdog_status = 'watching';
    a.per_watch_deadline = watchDeadline;
    // Reactivate if the agent was failed/completed
    if (a.claude_status === 'completed' || a.claude_status === 'failed') {
      a.claude_status = 'starting';
      a.stop_reason = null;
      a.ended_at = null;
      a.fatal_error = null;
      a.failed_at = null;
    }
    // rate_limit_first_at already force-cleared above via clearRateLimitFirstAt.
  });

  // Respawn watchers
  const freshAgent = loadState()[name]!;
  spawnLogWatcher(freshAgent);
  spawnPaneWatcher(freshAgent);

  // Kick-on-idle: if claude was alive but NOT actively working (idle/waiting/
  // completed), send a nudge to get it moving again. Skip the kick when we
  // just relaunched via --resume (that path re-inits with the task md) or when
  // claude was mid-turn (working) — don't interrupt real work.
  let kicked = false;
  if (!resumed && liveness === 'claude' && !wasWorking) {
    try {
      const prompt = resolvePrompt(cfg);
      tmuxSendText(session, prompt, true);
      kicked = true;
      mutateAgent(name, (a) => {
        a.nudge_count = (a.nudge_count ?? 0) + 1;
        // Don't manually set claude_status here — the UserPromptSubmit hook
        // fires when claude receives the nudge and sets 'running' truthfully.
      });
      logAgentEvent(name, `restart: claude was idle (status=${agent.claude_status}), kicked ("${prompt}")`);
      console.log(`↩ ${name}: was idle, kicked ("${prompt}")`);
    } catch (e) {
      logAgentEvent(name, `restart: kick failed: ${(e as Error).message}`);
    }
  }

  logAgentEvent(name, `restart: re-watched (cdog_status=watching, watchers respawned${watchDeadline ? `, watch=${watchDur}` : ''}${kicked ? ', kicked' : ''})`);
  console.log(`✓ ${name} re-watched (watching${kicked ? ' + kicked' : ''})`);
}

/** `cdog restart all` — re-watch every agent. */
export async function restartAll(): Promise<void> {
  const names = Object.keys(loadState()).sort();
  if (names.length === 0) {
    console.log('No agents to restart.');
    return;
  }
  for (const name of names) {
    try {
      await restartCommand(name);
    } catch (e) {
      console.error(`✗ ${name}: ${(e as Error).message}`);
    }
  }
}
