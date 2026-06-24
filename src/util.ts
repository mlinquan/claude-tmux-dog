// Shared utilities: paths, exec wrappers, shell quoting, time formatting.

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import dayjs from 'dayjs';

export const HOME = homedir();
export const CDOG_DIR = process.env.CDOG_DIR ?? join(HOME, '.cdog');
export const CLAUDE_DIR = join(HOME, '.claude');
export const HOOKS_DIR = join(CLAUDE_DIR, 'hooks');
export const LOGS_DIR = join(CDOG_DIR, 'logs');
export const STATE_PATH = join(CDOG_DIR, 'state.json');
export const CLAUDE_SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');

// ANSI color helpers (disabled when stdout is not a TTY).
const USE_COLOR = process.stdout.isTTY === true;
function c(code: string, s: string): string {
  return USE_COLOR ? `${code}${s}\x1b[0m` : s;
}
export const ANSI = {
  bold: (s: string) => c('\x1b[1m', s),
  dim: (s: string) => c('\x1b[2m', s),
  red: (s: string) => c('\x1b[31m', s),
  green: (s: string) => c('\x1b[32m', s),
  yellow: (s: string) => c('\x1b[33m', s),
  blue: (s: string) => c('\x1b[34m', s),
  cyan: (s: string) => c('\x1b[36m', s),
  grey: (s: string) => c('\x1b[90m', s),
};

/** Default display time format (dayjs tokens). */
export const DEFAULT_TIMEFORMAT = 'YYYY-MM-DD HH:mm:ss';

/** Colorize a Claude process status string, pm2-style. */
export function colorClaudeStatus(status: string): string {
  switch (status) {
    case 'running':
      return ANSI.green(status);
    case 'waiting':
      return ANSI.blue(status);
    case 'pending':
      return ANSI.yellow(status);
    case 'completed':
      return ANSI.cyan(status);
    case 'failed':
      return ANSI.red(status);
    case 'starting':
      return ANSI.yellow(status);
    case 'stopped':
      return ANSI.grey(status);
    default:
      return status;
  }
}

/** Colorize a cdog monitoring status string. */
export function colorCdogStatus(status: string): string {
  switch (status) {
    case 'watching':
      return ANSI.green(status);
    case 'detached':
      return ANSI.yellow(status);
    default:
      return status;
  }
}

// Deeper, more saturated colors for per-agent log-name prefixes.
const NAME_COLORS = [
  '\x1b[38;5;33m', // blue
  '\x1b[38;5;35m', // teal
  '\x1b[38;5;90m', // purple
  '\x1b[38;5;130m', // orange
  '\x1b[38;5;161m', // pink
  '\x1b[38;5;28m', // green
  '\x1b[38;5;94m', // brown-orange
  '\x1b[38;5;55m', // indigo
];

/** Stable color for an agent name (hash → palette index). */
export function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

/** Total visible width of a `[name]` prefix (brackets + spaces). */
export const NAME_PREFIX_WIDTH = 26;

/**
 * Plain (no-ANSI) fixed-width `[name]` prefix, total visible width = `width`
 * (default 26). Pads with trailing spaces; if `[name]` exceeds the width,
 * truncates to `[name...]` (also exactly `width` chars).
 */
export function plainNamePrefix(name: string, width = NAME_PREFIX_WIDTH): string {
  const bracketed = `[${name}]`;
  if (bracketed.length <= width) {
    return bracketed + ' '.repeat(width - bracketed.length);
  }
  // Overflow: `[` + truncated-name + `...]` == width  →  name = width - 5.
  const inner = Math.max(0, width - 5);
  return `[${name.slice(0, inner)}...]`;
}

/** Colored (ANSI) fixed-width `[name]` prefix for terminal echo. */
export function namePrefix(name: string, width = NAME_PREFIX_WIDTH): string {
  return colorForName(name) + plainNamePrefix(name, width) + '\x1b[0m';
}

/** Format an epoch ms / ISO / Date using a dayjs token format. */
export function formatTime(
  t: number | string | Date,
  fmt: string = DEFAULT_TIMEFORMAT,
): string {
  return dayjs(t).format(fmt);
}

/** Run a command and return trimmed stdout, or empty string on failure. */
export function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Run a command in a shell, throw on failure (used for `cat | tail`). */
export function runShell(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' });
}

/** Run tmux subcommand. Returns trimmed stdout, '' on failure. */
export function tmux(args: string[]): string {
  return run('tmux', args);
}

/** Does a tmux session exist? */
export function tmuxHasSession(session: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Send keys literally (no tmux key-name interpretation) then Enter. */
export function tmuxSendText(session: string, text: string, pressEnter = true): void {
  tmux(['send-keys', '-t', session, '-l', text]);
  if (pressEnter) tmux(['send-keys', '-t', session, 'Enter']);
}

/** Capture a tmux pane's text (default: visible + scrollback). Returns the pane content. */
export function tmuxCapturePane(session: string, lines = 50): string {
  return tmux(['capture-pane', '-p', '-t', session, '-S', `-${lines}`, '-E', '-']);
}

/** Send a special key (e.g. C-c) to a tmux session. */
export function tmuxSendKey(session: string, key: string): void {
  tmux(['send-keys', '-t', session, key]);
}

/** Current foreground command name of the (sole) pane in a session. */
export function tmuxPaneCommand(session: string): string {
  return tmux(['list-panes', '-t', session, '-F', '#{pane_current_command}']);
}

/** PID of the pane's shell process. */
export function tmuxPanePid(session: string): number | undefined {
  const out = tmux(['list-panes', '-t', session, '-F', '#{pane_pid}']);
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Quote a single string for safe inclusion in a POSIX shell command. */
export function shellQuote(s: string): string {
  if (s !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Generate a cdog session id: a raw UUID v4 (passed to `claude --session-id <uuid>`). */
export function newSessionId(): string {
  return randomUUID();
}

/** Current time as an ISO 8601 string with local timezone offset (e.g. +08:00). */
export function localISO(d: dayjs.Dayjs | string = dayjs()): string {
  return dayjs(d).format();
}

/** Format a duration (ms) as "7d 0h 0m" / "2h 15m" / "12m" / "45s". */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

/** Parse a human duration like "7d", "4h", "10m", "30s" or "1d4h" into milliseconds. Returns 0 if unparseable. */
export function parseDuration(s: string | undefined): number {
  if (!s) return 0;
  const re = /(\d+)\s*(d|h|m|s)/gi;
  const mult: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    total += n * mult[unit] * 1000;
  }
  return total;
}

/**
 * Parse a token count from number or human string.
 * Accepts: 200000, "200000", "200k", "1m", "1.5k".
 * Returns 0 if unparseable.
 *
 * Note: this is TOKEN count, not bytes. "200k" = 200000 tokens, not 200KB.
 */
export function parseTokenCount(v: number | string | undefined): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim().toLowerCase();
  const m = /^([0-9.]+)\s*(k|m)?$/i.exec(s);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2]?.toLowerCase();
  const mult = unit === 'k' ? 1000 : unit === 'm' ? 1_000_000 : 1;
  return Math.round(n * mult);
}

/**
 * Format a token count for display: "200k", "1m", "15.6k", "500".
 * Uses k for thousands, m for millions, with 1 decimal for k.
 */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return Number.isInteger(m) ? `${m}m` : `${m.toFixed(1)}m`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

/** Parse a local ISO string (with offset) back to epoch ms. */
export function parseLocalISO(s: string): number {
  return dayjs(s).valueOf();
}

/** Human uptime string from a started_at ISO timestamp. */
export function uptimeFrom(startedAt: string): string {
  const started = parseLocalISO(startedAt);
  if (!Number.isFinite(started)) return '–';
  return formatDuration(dayjs().valueOf() - started);
}

export function ensureCdogDir(): void {
  if (!existsSync(CDOG_DIR)) mkdirSync(CDOG_DIR, { recursive: true });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
