// cdog status [name]  — dual-track table (cdog + claude status) + started_at.

import { loadState } from '../state.js';
import { loadConfig } from '../config.js';
import { existsSync } from 'node:fs';
import { tmuxHasSession, uptimeFrom, colorClaudeStatus, colorCdogStatus, ANSI, formatTime, parseTokenCount, formatTokenCount, DEFAULT_TIMEFORMAT } from '../util.js';

/**
 * Resolve max_tokens: read from config file (real-time) first, fall back to
 * state.watchdog.max_tokens, then default 200000.
 *
 * This ensures `cdog status` always reflects the current config — if the user
 * edits cdog.json and changes max_tokens, status picks it up immediately
 * without needing to restart the agent.
 */
function resolveMaxTokens(a: { config_path?: string; watchdog?: { max_tokens?: number | string } }): number {
  // Try config file first (real-time read).
  if (a.config_path && existsSync(a.config_path)) {
    try {
      const cfg = loadConfig(a.config_path);
      if (cfg?.watchdog?.max_tokens) {
        return parseTokenCount(cfg.watchdog.max_tokens);
      }
    } catch { /* fall through */ }
  }
  // Fall back to state (may be stale if config was edited after start).
  if (a.watchdog?.max_tokens) {
    return parseTokenCount(a.watchdog.max_tokens);
  }
  return 200_000;
}

/** Strip ANSI escapes to measure visible width. */
function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Pad a (possibly colored) string to a visible width with trailing spaces. */
function pad(s: string, w: number): string {
  const v = visibleLen(s);
  if (v >= w) return s;
  return s + ' '.repeat(w - v);
}

function printTable(): void {
  const state = loadState();
  const names = Object.keys(state).sort();
  if (names.length === 0) {
    console.log('No agents. Run `cdog start ./cdog.json`.');
    return;
  }

  const headers = ['name', 'session', 'status', 'claude', 'auto-nudge', 'context', 'nudge', '↺', 'uptime', 'next nudge', 'started_at'];
  const rows = names.map((n) => {
    const a = state[n];
    const alive = tmuxHasSession(a.tmux_session);
    let claude = a.claude_status;
    let cdog = a.cdog_status;
    if (claude === 'running' && !alive) {
      claude = 'stopped';
      cdog = 'detached';
    }
    // Show fatal indicator in table when model offline
    let claudeDisplay = colorClaudeStatus(claude);
    if (a.fatal_error && claude === 'failed') {
      claudeDisplay = ANSI.red('failed!');
    }
    const up = claude === 'running' || claude === 'failed' || claude === 'completed' || claude === 'pending'
      ? uptimeFrom(a.started_at)
      : '–';
    const sess = a.session_id ? a.session_id.slice(0, 8) : '–';
    const started = formatTime(a.started_at, a.timeformat || DEFAULT_TIMEFORMAT);
    const nextNudge = a.next_nudge_at
      ? ANSI.yellow(formatTime(a.next_nudge_at, a.timeformat || DEFAULT_TIMEFORMAT))
      : ANSI.dim('–');
    const autoNudge = a.watchdog?.auto_nudge_stop ? ANSI.green('on') : ANSI.dim('off');
    const maxNum = resolveMaxTokens(a);
    let context: string;
    if (a.last_up_tokens != null && a.last_up_tokens > 0) {
      const pct = Math.round((a.last_up_tokens / maxNum) * 100);
      const tokenStr = formatTokenCount(a.last_up_tokens);
      const maxStr = formatTokenCount(maxNum);
      const pctColored = pct >= 80 ? ANSI.red(`${pct}%`) : pct >= 70 ? ANSI.yellow(`${pct}%`) : `${pct}%`;
      context = `${tokenStr}/${maxStr} ${pctColored}`;
    } else {
      context = ANSI.dim('–');
    }
    return [
      a.name,
      ANSI.dim(sess),
      colorCdogStatus(cdog),
      claudeDisplay,
      autoNudge,
      context,
      ANSI.dim(String(a.nudge_count ?? 0)),
      ANSI.dim(String(a.restart_count ?? 0)),
      up,
      nextNudge,
      ANSI.dim(started),
    ];
  });

  const widths = headers.map((h, i) =>
    Math.max(visibleLen(h), ...rows.map((r) => visibleLen(r[i]))),
  );

  const line = (l: string, m: string, r: string) =>
    l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;

  const fmt = (cells: string[], header = false) => {
    const padded = cells.map((c, i) => pad(c, widths[i]));
    const body = header ? padded.map((c, i) => (i === 0 ? ANSI.bold(c) : ANSI.dim(c))) : padded;
    return '│ ' + body.join(' │ ') + ' │';
  };

  console.log(line('┌', '┬', '┐'));
  console.log(fmt(headers, true));
  console.log(line('├', '┼', '┤'));
  for (const r of rows) console.log(fmt(r));
  console.log(line('└', '┴', '┘'));
}

function printDetail(name: string): void {
  const state = loadState();
  const a = state[name];
  if (!a) {
    console.error(`✗ agent not found: ${name}`);
    process.exit(1);
  }
  const alive = tmuxHasSession(a.tmux_session);
  let claude = a.claude_status;
  let claudeNote = '';
  if (claude === 'running' && !alive) {
    claude = 'stopped';
    claudeNote = ' (tmux session gone)';
  }

  const w = 13;
  const row = (label: string, val: string) => `  ${label.padEnd(w)}${val}`;
  const fmt = a.timeformat || DEFAULT_TIMEFORMAT;

  console.log(`${ANSI.bold('Agent:')} ${a.name}`);
  console.log(row('Session ID:', a.session_id));
  console.log(row('cdog:', colorCdogStatus(a.cdog_status)));
  console.log(row('claude:', colorClaudeStatus(claude) + claudeNote));
  if (claude !== 'running' && claude !== 'starting' && a.stop_reason) {
    let reason: string = a.stop_reason;
    if (a.stop_reason === 'completed' && a.per_watch_deadline) reason = 'completed (per_watch_duration reached)';
    console.log(row('Stop reason:', reason));
  }
  if (a.fatal_error) {
    console.log(row('Fatal error:', ANSI.red(a.fatal_error)));
  }
  if (a.failed_at) {
    console.log(row('Failed at:', formatTime(a.failed_at, fmt)));
  }
  console.log(row('PID:', a.pid ? String(a.pid) : '—'));
  if (a.model) console.log(row('Model:', a.model));
  console.log(row('Tmux:', `${a.tmux_session}  ${alive ? '(alive)' : '(dead)'}`));
  console.log(row('Started:', formatTime(a.started_at, fmt)));
  if (a.ended_at) console.log(row('Ended:', formatTime(a.ended_at, fmt)));
  console.log(row('Uptime:', uptimeFrom(a.started_at)));
  console.log(row('Restarts:', String(a.restart_count ?? 0)));
  console.log(row('Nudges:', String(a.nudge_count ?? 0)));
  const maxNum = resolveMaxTokens(a);
  if (a.last_up_tokens != null && a.last_up_tokens > 0) {
    const pct = Math.round((a.last_up_tokens / maxNum) * 100);
    const tokenStr = formatTokenCount(a.last_up_tokens);
    const maxStr = formatTokenCount(maxNum);
    const pctColored = pct >= 80 ? ANSI.red(`${pct}%`) : pct >= 70 ? ANSI.yellow(`${pct}%`) : `${pct}%`;
    const updated = a.last_up_tokens_at ? formatTime(a.last_up_tokens_at, fmt) : '—';
    console.log(row('Context:', `${tokenStr}/${maxStr} tokens (${pctColored}) — updated ${updated}`));
  } else {
    console.log(row('Context:', ANSI.dim('— (pane watcher has not recorded tokens yet)')));
  }
  if (a.api_error_count != null && a.api_error_count > 0) {
    console.log(row('API errors:', String(a.api_error_count)));
  }
  const autoNudgeStatus = a.watchdog?.auto_nudge_stop
    ? ANSI.green('on') + ' (auto-nudge enabled)'
    : ANSI.dim('off') + ' (auto-nudge disabled)';
  console.log(row('Auto-nudge:', autoNudgeStatus));
  console.log(row('Last error:', a.last_error ?? '—'));
  if (a.last_restart_at) console.log(row('Last restart:', formatTime(a.last_restart_at, fmt)));
  if (a.next_nudge_at) console.log(row('Next nudge:', ANSI.yellow(formatTime(a.next_nudge_at, fmt))));
  if (a.config_path) console.log(row('Config:', a.config_path));
  if (a.log_path) console.log(row('Claude log:', a.log_path));
  if (a.log_file_path) console.log(row('cdog log:', a.log_file_path));
}

export function statusCommand(name?: string): void {
  if (name) printDetail(name);
  else printTable();
}
