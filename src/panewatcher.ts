// Pane watcher: proactive context monitor.
//
// Primary mode (event-driven): tmux pipe-pane streams pane output to a file,
// tail -f watches it. Whenever claude redraws its TUI (including ↑ tokens),
// the watcher sees it instantly.
//
// Fallback mode (polling): if pipe-pane doesn't work (e.g. sandbox restrictions),
// fall back to periodic tmux capture-pane every 15s.
//
// Flow:
//   1. Try pipe-pane → tail -f → strip ANSI → match ↑ tokens
//   2. If pipe file doesn't appear in 5s → fallback to capture-pane polling
//   3. If upTokens >= max_tokens * compact_ratio → /compact + nudge
//
// Spawned by `cdog start` as a detached child process (`cdog __panewatch <name>`).
// Killed on `cdog stop` / `cdog delete`.

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentState, CdogConfig, PaneWatcherConfig } from './types.js';
import { loadState, mutateAgent } from './state.js';
import { loadConfig } from './config.js';
import { tmuxHasSession, tmux, tmuxChecked, sleep, tmuxCapturePane, parseTokenCount } from './util.js';
import { parsePaneTokens } from './recovery.js';
import { logAgentEvent, logSwallow } from './logger.js';
import { notify } from './notify.js';

// ---- Defaults ----
const DEFAULT_MAX_TOKENS = 200_000;
const DEFAULT_COMPACT_RATIO = 0.8;
const DEFAULT_PROMPT = 'continue';
const RECOVER_COOLDOWN_MS = 60_000;
const POLL_FALLBACK_SEC = 15;

export interface ResolvedPaneWatcherConfig {
  enabled: boolean;
  maxTokens: number;
  compactRatio: number;
  compactThreshold: number;
  prompt: string;
}

export function resolvePaneWatcherConfig(cfg: CdogConfig, _hasLog = false): ResolvedPaneWatcherConfig {
  const pw = cfg.watchdog?.pane_watcher;
  const prompt = cfg.watchdog?.prompt ?? DEFAULT_PROMPT;
  // pane_watcher.max_tokens overrides watchdog.max_tokens (rarely needed)
  const maxTokens = parseTokenCount(pw?.max_tokens) || parseTokenCount(cfg.watchdog?.max_tokens) || DEFAULT_MAX_TOKENS;
  const compactRatio = pw?.compact_ratio ?? DEFAULT_COMPACT_RATIO;
  return {
    enabled: true, // always on — dual-layer defense is always active
    maxTokens,
    compactRatio,
    compactThreshold: Math.round(maxTokens * compactRatio),
    prompt,
  };
}

function pipeFilePath(agentName: string): string {
  return join(homedir(), '.cdog', `${agentName}.pane`);
}

export function spawnPaneWatcher(agent: AgentState): number | null {
  const child = spawn(process.execPath, [process.argv[1]!, '__panewatch', agent.name], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  const pid = child.pid ?? null;
  mutateAgent(agent.name, (a) => { a.pane_watcher_pid = pid; });
  logAgentEvent(agent.name, `pane-watcher spawned (pid=${pid})`);
  return pid;
}

export function killPaneWatcher(agentName: string): void {
  const agent = loadState()[agentName];
  const pid = agent?.pane_watcher_pid;
  if (pid) {
    try {
      // Kill the whole process group (watcher + tail child) — detached: true
      process.kill(-pid);
    } catch { /* dead */ }
  }
  try { tmux(['pipe-pane', '-t', agent.tmux_session]); } catch { /* ignore */ }
  try { rmSync(pipeFilePath(agentName), { force: true }); } catch { /* ignore */ }
  mutateAgent(agentName, (a) => { a.pane_watcher_pid = null; });
  logAgentEvent(agentName, 'pane-watcher killed');
}

// ANSI escape stripper: CSI, OSC, and misc sequences + carriage returns.
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>]|\x1b[0-9]+|\r/g;

/**
 * Entry point for `cdog __panewatch <name>`.
 * Tries pipe-pane (event-driven) first, falls back to capture-pane polling.
 */
export async function runPaneWatcher(agentName: string): Promise<void> {
  const agent = loadState()[agentName];
  if (!agent) process.exit(1);

  let cfg: ResolvedPaneWatcherConfig;
  try {
    cfg = resolvePaneWatcherConfig(loadConfig(agent.config_path!), true);
  } catch { process.exit(1); }
  if (!cfg.enabled) process.exit(0);

  const session = agent.tmux_session;
  const pipeFile = pipeFilePath(agentName);

  // Ensure ~/.cdog exists
  try { mkdirSync(join(homedir(), '.cdog'), { recursive: true }); } catch { /* ignore */ }
  try { rmSync(pipeFile, { force: true }); } catch { /* ignore */ }

  // Try pipe-pane mode
  let pipeOk = false;
  try {
    tmux(['pipe-pane', '-t', session, '-o', `cat >> ${pipeFile}`]);
    // Wait up to 5s for file to appear
    for (let i = 0; i < 5; i++) {
      if (existsSync(pipeFile) && existsSync(pipeFile) && (await fileHasContent(pipeFile))) { pipeOk = true; break; }
      if (!existsSync(pipeFile) && i === 0) { await sleep(500); continue; }
      if (existsSync(pipeFile)) { pipeOk = true; break; }
      await sleep(1000);
    }
  } catch { /* pipe-pane failed */ }

  if (pipeOk) {
    logAgentEvent(agentName, `pane-watcher: event-driven mode (pipe-pane → ${pipeFile}, max=${cfg.maxTokens}, compact at ${cfg.compactThreshold})`);
    await runPipeMode(agentName, session, pipeFile, cfg);
  } else {
    logAgentEvent(agentName, `pane-watcher: pipe-pane unavailable, fallback to polling (every ${POLL_FALLBACK_SEC}s)`);
    await runPollMode(agentName, session, cfg);
  }
}

async function fileHasContent(path: string): Promise<boolean> {
  try {
    const { statSync } = await import('node:fs');
    return statSync(path).size > 0;
  } catch { return false; }
}

/**
 * Event-driven mode: tail -f the pipe file, strip ANSI, match tokens.
 */
async function runPipeMode(agentName: string, session: string, pipeFile: string, cfg: ResolvedPaneWatcherConfig): Promise<void> {
  // -n 50: start by reading the last 50 lines so we catch the current token
  // count immediately, instead of waiting for the next TUI redraw.
  // NOT detached: stays in the pane-watcher's process group so
  // `process.kill(-watcherPid)` reaches it (prevents orphan accumulation).
  const tail = spawn('tail', ['-f', '-n', '50', pipeFile], { stdio: ['ignore', 'pipe', 'ignore'] });

  let buffer = '';
  let lastTokens: number | null = null;
  let lastCompactAt = 0;

  tail.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    if (buffer.length > 16384) buffer = buffer.slice(-8192);

    const cleaned = buffer.replace(ANSI_RE, '');
    const { upTokens } = parsePaneTokens(cleaned);

    if (upTokens !== null && upTokens !== lastTokens) {
      lastTokens = upTokens;
      handleTokens(agentName, session, cfg, upTokens, lastCompactAt, (t) => { lastCompactAt = t; });
    }
  });

  tail.on('exit', () => {
    cleanupPipe(agentName, session, pipeFile);
    process.exit(0);
  });

  await new Promise(() => {});
}

/**
 * Polling fallback mode: capture-pane every N seconds.
 */
async function runPollMode(agentName: string, session: string, cfg: ResolvedPaneWatcherConfig): Promise<void> {
  let lastTokens: number | null = null;
  let lastCompactAt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(POLL_FALLBACK_SEC * 1000);

    const state = loadState()[agentName];
    if (!state) process.exit(0);
    if (state.cdog_status === 'detached') continue;
    if (!tmuxHasSession(session)) continue;

    const pane = tmuxCapturePane(session, 50);
    const { upTokens } = parsePaneTokens(pane);

    if (upTokens !== null && upTokens !== lastTokens) {
      lastTokens = upTokens;
      handleTokens(agentName, session, cfg, upTokens, lastCompactAt, (t) => { lastCompactAt = t; });
    }
  }
}

/**
 * Shared token handler: check threshold, trigger compact if needed.
 * Also persists the token count to state so the log watcher can read it
 * on the first API error to decide whether to compact immediately.
 *
 * Compact completion is detected via the PostCompact hook (event-driven).
 * We set compact_in_progress + compact_pending_prompt in state before sending
 * /compact. The PostCompact hook handler in notify.ts sends the nudge when
 * claude reports compaction is done — no hardcoded delays.
 */

function handleTokens(
  agentName: string,
  session: string,
  cfg: ResolvedPaneWatcherConfig,
  upTokens: number,
  lastCompactAt: number,
  setLastCompactAt: (t: number) => void,
): void {
  // Single state read — used for both the meaningful-change check and the
  // compact decision, avoiding the previous 2 reads + 2 writes (4 lock
  // acquisitions) per token change. Decide + apply in one mutation below.
  const state = loadState()[agentName];
  if (!state) return;

  const prevTokens = state.last_up_tokens ?? null;
  const delta = prevTokens !== null ? Math.abs(upTokens - prevTokens) : upTokens;
  const deltaThreshold = Math.max(100, Math.round(cfg.maxTokens * 0.01));
  const meaningfulChange = prevTokens === null || delta >= deltaThreshold;

  // Decide whether to trigger a compact, from the same snapshot we persist.
  const overThreshold = upTokens >= cfg.compactThreshold;
  const now = Date.now();
  const inCooldown = overThreshold && now - lastCompactAt < RECOVER_COOLDOWN_MS;
  const shouldCompact =
    overThreshold && !state.compact_in_progress && !inCooldown && state.cdog_status !== 'detached';

  // One write: persist token count (always) + compact flags (when triggering).
  mutateAgent(agentName, (a) => {
    a.last_up_tokens = upTokens;
    if (meaningfulChange) {
      a.last_up_tokens_at = new Date().toISOString();
    }
    if (shouldCompact) {
      a.compact_in_progress = true;
      a.compact_sent_at = new Date().toISOString();
      a.compact_pending_prompt = cfg.prompt;
      a.last_recover_at = new Date().toISOString();
    }
  });

  if (!overThreshold) {
    logAgentEvent(agentName, `pane-watcher: ↑ ${upTokens} tokens (${Math.round(upTokens / cfg.maxTokens * 100)}%)`);
    return;
  }
  if (state.compact_in_progress) return; // already compacting
  if (!shouldCompact) return; // cooldown, or detached

  setLastCompactAt(now);
  logAgentEvent(agentName, `pane-watcher: ↑ ${upTokens} tokens >= ${cfg.compactThreshold} (${Math.round(cfg.compactRatio * 100)}%), triggering compact`);

  // /compact already armed above (compact_in_progress=true). PostCompact hook
  // will fire when it's done → sends nudge. tmux send-keys here initiates it.
  try {
    tmuxChecked(['send-keys', '-t', session, '/compact', 'C-m']);
  } catch (e) {
    // /compact never landed — clear the armed flag so we're not stuck waiting
    // for a PostCompact that will never fire (the next cycle can retry).
    logSwallow(agentName, 'pane-watcher /compact send', e);
    mutateAgent(agentName, (a) => {
      a.compact_in_progress = false;
      a.compact_sent_at = null;
      a.compact_pending_prompt = null;
    });
    return;
  }
  logAgentEvent(agentName, `pane-watcher: /compact sent (waiting for PostCompact hook to nudge)`);

  notify(agentName, 'compact', agentName,
    `Proactive compact: ↑ ${upTokens} tokens (${Math.round(upTokens / cfg.maxTokens * 100)}% of ${cfg.maxTokens})`);
}

function cleanupPipe(agentName: string, session: string, pipeFile: string): void {
  try { tmux(['pipe-pane', '-t', session]); } catch { /* ignore */ }
  try { rmSync(pipeFile, { force: true }); } catch { /* ignore */ }
  logAgentEvent(agentName, 'pane-watcher: cleaned up');
}
