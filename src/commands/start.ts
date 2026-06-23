// cdog start [config_path]  (also supports `cdog start all`)

import { resolve, isAbsolute, dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { AgentState, CdogConfig } from '../types.js';
import { getAgent, loadState, upsertAgent, mutateAgent } from '../state.js';
import { loadConfig, buildStartCommand } from '../config.js';
import {
  tmux,
  tmuxHasSession,
  tmuxPanePid,
  newSessionId,
  localISO,
  sleep,
  parseDuration,
} from '../util.js';
import { hooksInstalled, hooksConfigured, installHookScripts, mergeHookSettings } from '../hooks.js';
import { logAndEcho, startedLine } from '../logger.js';
import { notify } from '../notify.js';
import { spawnLogWatcher } from '../logwatcher.js';
import { spawnPaneWatcher } from '../panewatcher.js';

/** Pick a tmux session name that isn't already in use, with `-1`, `-2` suffixes. */
function uniqueTmuxSession(base: string): string {
  let name = base;
  let i = 1;
  while (tmuxHasSession(name)) {
    name = `${base}-${i++}`;
  }
  return name;
}

export async function startCommand(configPath: string = './cdog.json'): Promise<void> {
  const absConfig = resolve(process.cwd(), configPath);
  const cfg: CdogConfig = loadConfig(absConfig);

  // Auto-init hooks if missing (claude settings can get reset by updates/other tools).
  if (!hooksInstalled() || !hooksConfigured()) {
    console.log('⚙ hooks not detected — running cdog init automatically...');
    installHookScripts();
    const ok = mergeHookSettings();
    if (ok) {
      console.log('✓ hooks installed and configured');
    } else {
      console.warn('⚠ hooks auto-init failed — run `cdog init` manually');
    }
  }

  // Already running (but completed → allow restart)?
  const existing = getAgent(cfg.name);
  if (existing && existing.claude_status === 'completed') {
    // Force-update deadline for completed agents
    const maxRunMs = parseDuration(cfg.watchdog?.max_run);
    const maxRunDeadline = maxRunMs > 0 ? Date.now() + maxRunMs : null;
    mutateAgent(cfg.name, (a) => {
      a.max_run_deadline = maxRunDeadline;
    });
  }
  if (
    existing &&
    existing.cdog_status === 'watching' &&
    existing.claude_status === 'running' &&
    tmuxHasSession(existing.tmux_session)
  ) {
    console.log(`✓ ${cfg.name} already running (tmux: ${existing.tmux_session})`);
    return;
  }

  // session id (raw uuid)
  const sessionId =
    cfg.session_id && cfg.session_id.trim() !== '' ? cfg.session_id : newSessionId();

  // tmux session name — just the agent name (suffixed on collision).
  const tmuxSession =
    cfg.tmux_session && cfg.tmux_session.trim() !== ''
      ? cfg.tmux_session
      : uniqueTmuxSession(cfg.name);

  // claude debug log: always pass --debug-file to claude.
  // If `log` is configured, use it. Otherwise default to <cwd>/logs/claude-debug.log.
  // This ensures the log watcher always has a file to tail.
  const logPath = cfg.log && cfg.log.trim() !== ''
    ? resolveCwd(cfg, cfg.log)
    : resolve(cfg.cwd, 'logs', 'claude-debug.log');
  // Ensure the logs directory exists so claude can write to it immediately.
  try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* ignore */ }
  cfg.log = logPath;

  // cdog operation log: only if `log_file` configured.
  const logFilePath =
    cfg.log_file && cfg.log_file.trim() !== ''
      ? resolveCwd(cfg, cfg.log_file)
      : undefined;

  // Build command (buildStartCommand always adds --debug-file now).
  const { cmd } = buildStartCommand(cfg, sessionId);

  tmux(['new-session', '-d', '-s', tmuxSession, '-c', cfg.cwd, cmd]);
  await sleep(2000);

  const pid = tmuxPanePid(tmuxSession);

  const maxRunMs = parseDuration(cfg.watchdog?.max_run);
  const maxRunDeadline = maxRunMs > 0 ? Date.now() + maxRunMs : null;

  const agent: AgentState = {
    name: cfg.name,
    session_id: sessionId,
    pid,
    tmux_session: tmuxSession,
    claude_status: 'running',
    cdog_status: 'watching',
    stop_reason: null,
    ended_at: null,
    fatal_error: null,
    failed_at: null,
    started_at: localISO(),
    last_error: null,
    last_restart_at: null,
    restart_count: 0,
    nudge_count: 0,
    model: cfg.model,
    config_path: absConfig,
    log_path: logPath,
    log_file_path: logFilePath,
    timeformat: cfg.timeformat,
    max_run_deadline: maxRunDeadline,
    failures: [],
    api_error_count: 0,
    last_recover_at: null,
    watcher_pid: null,
    pane_watcher_pid: null,
    compact_in_progress: false,
    compact_sent_at: null,
    compact_pending_prompt: null,
    watchdog: cfg.watchdog,
  };
  upsertAgent(agent);

  // Spawn log watcher (reactive: API error → C-c → /context → compact-or-nudge)
  // Always spawn both watchers — cdog always passes --debug-file so a log
  // file always exists. This is the "强制但全面" (forceful but comprehensive)
  // approach: dual-layer defense is always on.
  spawnLogWatcher(agent);
  spawnPaneWatcher(agent);

  logAndEcho(cfg.name, startedLine(agent));
  await notify(cfg.name, 'agent-started', cfg.name, `Started, session=${sessionId.slice(0, 8)}`);
  console.log(`✓ ${cfg.name} started`);
  console.log(`  Session:   ${sessionId}`);
  console.log(`  Tmux:      ${tmuxSession}`);
  if (pid) console.log(`  PID:       ${pid}`);
  if (cfg.model) console.log(`  Model:     ${cfg.model}`);
  if (logPath) console.log(`  ClaudeLog: ${logPath}`);
  if (logFilePath) console.log(`  CdogLog:   ${logFilePath}`);
  console.log(`  Cwd:       ${cfg.cwd}`);
  if (maxRunDeadline) console.log(`  Max run:   ${cfg.watchdog?.max_run}`);
}

/** `cdog start all` — restart every agent that has a config_path recorded. */
export async function startAll(): Promise<void> {
  const state = loadState();
  const names = Object.keys(state).sort();
  if (names.length === 0) {
    console.log('No agents to start.');
    return;
  }
  for (const name of names) {
    const a = state[name];
    if (!a.config_path || !existsSync(a.config_path)) {
      console.error(`✗ ${name}: no config_path, skipping`);
      continue;
    }
    try {
      await startCommand(a.config_path);
    } catch (e) {
      console.error(`✗ ${name}: ${(e as Error).message}`);
    }
  }
}

function resolveCwd(cfg: CdogConfig, p: string): string {
  return isAbsolute(p) ? p : resolve(cfg.cwd, p);
}
