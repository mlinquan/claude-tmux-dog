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
import { spawnLogWatcher, killLogWatcher } from '../logwatcher.js';
import { spawnPaneWatcher, killPaneWatcher } from '../panewatcher.js';

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
    const watchMs = parseDuration(cfg.watchdog?.per_watch_duration);
    const watchDeadline = watchMs > 0 ? Date.now() + watchMs : null;
    mutateAgent(cfg.name, (a) => {
      a.per_watch_deadline = watchDeadline;
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

  // Pre-register agent state BEFORE starting claude, so watchers can start
  // tailing the log file before claude writes its first line.
  // This ensures the log watcher catches the very first API error (e.g. 429
  // quota exceeded at startup) without missing any lines.
  const watchMs = parseDuration(cfg.watchdog?.per_watch_duration);
  const watchDeadline = watchMs > 0 ? Date.now() + watchMs : null;

  // Kill any leftover watcher processes from a previous run before overwriting state.
  // Must happen BEFORE upsertAgent, otherwise the old watcher_pid in state is lost
  // and killLogWatcher/killPaneWatcher can't find the PID to kill.
  if (existing) {
    killLogWatcher(cfg.name);
    killPaneWatcher(cfg.name);
  }

  const agent: AgentState = {
    name: cfg.name,
    session_id: sessionId,
    pid: undefined,         // filled after tmux starts
    tmux_session: tmuxSession,
    claude_status: 'starting',
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
    per_watch_deadline: watchDeadline,
    failures: [],
    api_error_count: 0,
    last_recover_at: null,
    watcher_pid: null,
    pane_watcher_pid: null,
    compact_in_progress: false,
    compact_sent_at: null,
    compact_pending_prompt: null,
    next_nudge_at: null,
    watchdog: cfg.watchdog,
  };
  upsertAgent(agent);

  // Start watchers BEFORE claude — they tail the log file and pane,
  // so they're ready to catch the very first error.
  spawnLogWatcher(agent);
  spawnPaneWatcher(agent);

  // Now start claude inside tmux.
  tmux(['new-session', '-d', '-s', tmuxSession, '-c', cfg.cwd, cmd]);
  await sleep(2000);

  const pid = tmuxPanePid(tmuxSession);

  // Update state with PID and mark as running.
  mutateAgent(cfg.name, (a) => {
    a.pid = pid;
    a.claude_status = 'running';
  });

  const updatedAgent = getAgent(cfg.name)!;
  logAndEcho(cfg.name, startedLine(updatedAgent));
  await notify(cfg.name, 'agent-started', cfg.name, `Started, session=${sessionId.slice(0, 8)}`);
  console.log(`✓ ${cfg.name} started`);
  console.log(`  Session:   ${sessionId}`);
  console.log(`  Tmux:      ${tmuxSession}`);
  if (pid) console.log(`  PID:       ${pid}`);
  if (cfg.model) console.log(`  Model:     ${cfg.model}`);
  if (logPath) console.log(`  ClaudeLog: ${logPath}`);
  if (logFilePath) console.log(`  CdogLog:   ${logFilePath}`);
  console.log(`  Cwd:       ${cfg.cwd}`);
  if (watchDeadline) console.log(`  Watch:     ${cfg.watchdog?.per_watch_duration}`);
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
