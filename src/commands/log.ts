// cdog log / cdog logs — tail cdog operation logs, claude debug logs, or both.
//
// Source selection (what to tail):
//   cdog log                  — all agents, both cdog + claude logs (follow)
//   cdog log all              — same as above
//   cdog log --all            — same (explicit "both sources")
//   cdog log --cdog           — all agents, cdog op-logs only
//   cdog log --claude         — all agents, claude debug logs only
//   cdog log <name> --all     — one agent, both cdog + claude
//   cdog log <name> --cdog    — one agent, cdog only
//   cdog log <name> --claude  — one agent, claude only
//
// Modifiers (combine with any of the above):
//   --no-follow               — snapshot last N lines, then exit
//   --lines N                 — number of lines (default 50)
//   --err                     — only [ERROR] lines
//
// Target selection (which agents):
//   no positional / positional "all"  → all agents
//   positional <name>                 → that single agent

import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { loadState } from '../state.js';
import { formatTime, DEFAULT_TIMEFORMAT } from '../util.js';

// Colors for agent names — cycle through these for multi-agent output
const AGENT_COLORS = [
  (s: string) => `\x1b[32m${s}\x1b[39m`,   // green
  (s: string) => `\x1b[34m${s}\x1b[39m`,   // blue
  (s: string) => `\x1b[33m${s}\x1b[39m`,   // yellow
  (s: string) => `\x1b[35m${s}\x1b[39m`,   // magenta
  (s: string) => `\x1b[36m${s}\x1b[39m`,   // cyan
  (s: string) => `\x1b[31m${s}\x1b[39m`,   // red
  (s: string) => `\x1b[92m${s}\x1b[39m`,   // bright green
  (s: string) => `\x1b[94m${s}\x1b[39m`,   // bright blue
];

function colorAgent(name: string, index: number): string {
  return AGENT_COLORS[index % AGENT_COLORS.length](name);
}

// Regexes for claude debug log levels
const LOG_LEVEL_COLORS: Record<string, (s: string) => string> = {
  ERROR:   (s) => `\x1b[31m${s}\x1b[39m`, // red
  WARN:    (s) => `\x1b[33m${s}\x1b[39m`, // yellow
  INFO:    (s) => `\x1b[36m${s}\x1b[39m`, // cyan
  DEBUG:   (s) => `\x1b[90m${s}\x1b[39m`, // bright black (gray)
};

/** Colorize log levels like [ERROR] [WARN] [DEBUG] etc. */
function colorizeLogLevel(line: string): string {
  return line.replace(
    /\[(ERROR|WARN|INFO|DEBUG)\]/g,
    (_, level: string) => LOG_LEVEL_COLORS[level]?.(`[${level}]`) ?? `[${level}]`,
  );
}

/** Fixed label width for agent name alignment (matches cdog log format). */
const AGENT_LABEL_WIDTH = 26;

/**
 * Format an agent label: `[name]` padded/truncated to AGENT_LABEL_WIDTH chars,
 * then colorized. The plain-text width is always AGENT_LABEL_WIDTH so alignment
 * is consistent regardless of ANSI codes.
 */
function formatAgentLabel(name: string, colorIdx: number): string {
  const label = `[${name}]`;
  const padded = label.length >= AGENT_LABEL_WIDTH
    ? label.slice(0, AGENT_LABEL_WIDTH)
    : label + ' '.repeat(AGENT_LABEL_WIDTH - label.length);
  return `${colorAgent(padded, colorIdx)}|`;
}

/** A single tailable log source. `kind` controls how the line is prefixed. */
interface LogSource {
  name: string;
  path: string;
  kind: 'cdog' | 'claude';
}

/** Which source(s) to tail. */
type SourceMode = 'cdog' | 'claude' | 'both';

export interface LogArgs {
  name?: string; // agent name, or undefined for "all"
  cdog?: boolean; // --cdog: cdog op-logs only
  claude?: boolean; // --claude: claude debug logs only
  err?: boolean; // --err: only [ERROR] lines
  noFollow?: boolean;
  lines?: number;
}

/** The cdog operation-log path for an agent (its configured log_file_path). Undefined if none. */
function cdogLogPath(agentName: string): string | undefined {
  const a = loadState()[agentName];
  return a?.log_file_path;
}

/** Agent names that have a readable cdog log. */
function agentsWithLogs(): string[] {
  return Object.keys(loadState())
    .filter((n) => {
      const p = cdogLogPath(n);
      return p && existsSync(p);
    })
    .sort();
}

/** Agents that have a readable claude debug log (config `log`). */
function agentsWithClaudeLogs(): { name: string; path: string }[] {
  const state = loadState();
  return Object.keys(state)
    .filter((n) => {
      const p = state[n].log_path;
      return p && existsSync(p);
    })
    .sort()
    .map((n) => ({ name: n, path: state[n].log_path! }));
}

/** Build the list of log sources for a single agent, filtered by source mode. */
function sourcesForAgent(name: string, mode: SourceMode): LogSource[] {
  const out: LogSource[] = [];
  const agent = loadState()[name];
  if (!agent) return out;
  if (mode !== 'claude') {
    const p = cdogLogPath(name);
    if (p && existsSync(p)) out.push({ name, path: p, kind: 'cdog' });
  }
  if (mode !== 'cdog') {
    const p = agent.log_path;
    if (p && existsSync(p)) out.push({ name, path: p, kind: 'claude' });
  }
  return out;
}

/** Build the list of log sources across all agents, filtered by source mode. */
function sourcesForAll(mode: SourceMode): LogSource[] {
  const out: LogSource[] = [];
  if (mode !== 'claude') {
    for (const name of agentsWithLogs()) {
      out.push({ name, path: cdogLogPath(name)!, kind: 'cdog' });
    }
  }
  if (mode !== 'cdog') {
    for (const { name, path } of agentsWithClaudeLogs()) {
      out.push({ name, path, kind: 'claude' });
    }
  }
  return out;
}

const ERROR_RE = /\[ERROR\]/;

// Leading ISO-8601 timestamp as written to disk by both the cdog logger and
// claude's --debug-file (e.g. "2026-06-24T16:34:03.696Z"). At display time we
// reformat it to the agent's `timeformat`.
const ISO_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s?([\s\S]*)$/;

// Legacy cdog log timestamp (human-readable "YYYY-MM-DD HH:mm:ss"). Used by
// older cdog log files before we switched to ISO-8601 on disk.
const LEGACY_CDOG_TS_RE = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+([\s\S]*)$/;

// Tag prepended to cdog-op-log lines in merged ("both") mode so they're
// distinguishable from claude debug-log lines. Bright magenta / pink.
const TAG_CDOG = '\x1b[95m[CDOG]\x1b[39m';

/**
 * Render a cdog op-log line for display. Strips the on-disk `[name] | ` prefix
 * (rebuilding it fixed-width + colored, with exactly one space after `|`),
 * reformats the leading timestamp to `timeformat`, and — in merged mode —
 * inserts the `[CDOG]` tag right after the timestamp.
 */
function renderCdogLine(raw: string, name: string, colorIdx: number, tf: string, merged: boolean): string {
  const body = raw.replace(/^\[[^\]]+\]\s*\|\s*/, ''); // drop "[name] | " → "timestamp msg"
  const label = formatAgentLabel(name, colorIdx); // "[padded]|"
  // Try ISO-8601 first (new cdog logs + claude debug logs), then legacy human-readable.
  const iso = body.match(ISO_RE);
  const legacy = iso ? null : body.match(LEGACY_CDOG_TS_RE);
  const m = iso ?? legacy;
  if (!m) {
    // No timestamp — just colorize and render the body.
    return body ? `${label} ${colorizeLogLevel(body)}` : `${label}`;
  }
  const time = formatTime(m[1], tf);
  const msg = m[2];
  const tag = merged ? ` ${TAG_CDOG}` : '';
  return `${label} ${time}${tag}${msg ? ` ${colorizeLogLevel(msg)}` : ''}`;
}

/**
 * Render a claude debug-log line for display. Prepends the fixed-width colored
 * `[name] |` label and reformats the leading ISO timestamp to `timeformat`.
 */
function renderClaudeLine(raw: string, name: string, colorIdx: number, tf: string): string {
  const label = formatAgentLabel(name, colorIdx);
  const m = raw.match(ISO_RE);
  if (!m) {
    return raw ? `${label} ${colorizeLogLevel(raw)}` : `${label}`;
  }
  const time = formatTime(m[1], tf);
  const msg = m[2];
  return `${label} ${time}${msg ? ` ${colorizeLogLevel(msg)}` : ''}`;
}

/** A log line with its timestamp parsed for sorting. */
interface TimestampedLine {
  raw: string;
  src: LogSource;
  timestamp: number; // Unix epoch ms
}

/**
 * Parse timestamp from a log line. Returns 0 if no timestamp found.
 * Handles both ISO-8601 ("2026-06-24T16:34:03.696Z") and legacy
 * cdog format ("2026-06-24 16:34:03").
 */
function parseTimestamp(raw: string): number {
  // cdog op-log lines carry a "[name] | " prefix on disk; strip it so the
  // timestamp regexes (anchored at line start) can match.
  const body = raw.replace(/^\[[^\]]+\]\s*\|\s*/, '');
  // Try ISO-8601 first
  const iso = body.match(ISO_RE);
  if (iso) {
    const dt = new Date(iso[1]);
    if (!isNaN(dt.getTime())) return dt.getTime();
  }
  // Try legacy cdog timestamp
  const legacy = body.match(LEGACY_CDOG_TS_RE);
  if (legacy) {
    const dt = new Date(legacy[1].replace(' ', 'T') + 'Z');
    if (!isNaN(dt.getTime())) return dt.getTime();
  }
  return 0;
}

/**
 * Tail one or more log sources, merging them onto stdout. cdog sources already
 * carry a `[name] |` prefix per line (recolor it); claude sources get a
 * `[name] |` prefix prepended. When errOnly is set, only lines matching
 * `[ERROR]` are emitted. Follow mode runs until Ctrl-C; snapshot mode exits
 * when the initial burst finishes.
 *
 * Timestamps: both cdog and claude write ISO-8601 to disk; we reformat to the
 * agent's configured `timeformat` at display time. In merged ("both") mode,
 * cdog lines get a bright-magenta `[CDOG]` tag after the timestamp.
 *
 * Initial display ordering: the first `lines`-per-source burst is collected
 * across all sources and sorted by timestamp before being printed, so opening
 * `cdog log all` shows a chronologically merged history instead of each
 * agent's lines clumped together. In follow mode, a separate `tail -n 0 -f`
 * is then started to stream new lines as they arrive.
 */
function tailSources(sources: LogSource[], lines: number, follow: boolean, errOnly: boolean, merged: boolean): void {
  if (sources.length === 0) return;

  // Consistent color per agent name across all sources.
  const nameColorMap = new Map<string, number>();
  let nextColor = 0;
  for (const s of sources) {
    if (!nameColorMap.has(s.name)) nameColorMap.set(s.name, nextColor++);
  }

  // Per-agent timeformat (fallback to default).
  const state = loadState();
  const timeformatMap = new Map<string, string>();
  for (const s of sources) {
    if (!timeformatMap.has(s.name)) {
      timeformatMap.set(s.name, state[s.name]?.timeformat || DEFAULT_TIMEFORMAT);
    }
  }

  /** Render one raw line per its source kind, applying color + (optional) err gate. */
  const emit = (raw: string, src: LogSource): void => {
    if (errOnly && !ERROR_RE.test(raw)) return;
    const tf = timeformatMap.get(src.name) ?? DEFAULT_TIMEFORMAT;
    const colorIdx = nameColorMap.get(src.name) ?? 0;
    const line =
      src.kind === 'cdog'
        ? renderCdogLine(raw, src.name, colorIdx, tf, merged)
        : renderClaudeLine(raw, src.name, colorIdx, tf);
    process.stdout.write(line + '\n');
  };

  // ---- Phase 1: initial snapshot, buffered + sorted by timestamp ----
  // Spawn `tail -n N` (no -f) per source. Collect every line, then on full
  // completion sort the merged set by timestamp and print it. This gives the
  // chronological "first open" view the user asked for.
  const snapshot: TimestampedLine[] = [];
  let pending = sources.length;
  const snapshotChildren: ChildProcess[] = [];

  const startFollow = (): void => {
    if (!follow) {
      process.exit(0);
      return;
    }
    // ---- Phase 2: follow new lines, streamed live (no sorting) ----
    const followChildren: ChildProcess[] = [];
    for (const src of sources) {
      // -n 0 -f: start at current EOF, only print newly appended lines.
      const child = spawn('tail', ['-n', '0', '-f', src.path], { stdio: ['ignore', 'pipe', 'inherit'] });
      let buf = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const raw of parts) {
          if (raw === '') continue;
          emit(raw, src);
        }
      });
      followChildren.push(child);
    }
    process.on('SIGINT', () => {
      for (const c of followChildren) c.kill();
      process.exit(0);
    });
  };

  for (const src of sources) {
    const child = spawn('tail', ['-n', String(lines), src.path], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const raw of parts) {
        if (raw === '') continue;
        snapshot.push({ raw, src, timestamp: parseTimestamp(raw) });
      }
    });
    child.on('exit', () => {
      if (buf) snapshot.push({ raw: buf, src, timestamp: parseTimestamp(buf) });
      if (--pending === 0) {
        // All snapshot tails done — sort merged lines by timestamp and print.
        snapshot.sort((a, b) => a.timestamp - b.timestamp);
        for (const item of snapshot) emit(item.raw, item.src);
        startFollow();
      }
    });
    snapshotChildren.push(child);
  }

  if (!follow) {
    // Snapshot-only: still allow Ctrl-C to abort if a tail hangs.
    process.on('SIGINT', () => {
      for (const c of snapshotChildren) c.kill();
      process.exit(0);
    });
  }
}

export async function logCommand(args: LogArgs): Promise<void> {
  const lines = args.lines ?? 50;
  const follow = !args.noFollow;

  // Source mode: explicit --cdog / --claude win; otherwise both.
  const mode: SourceMode = args.cdog && !args.claude
    ? 'cdog'
    : args.claude && !args.cdog
      ? 'claude'
      : 'both';

  // Target: single agent (positional name) vs all agents.
  const single = !!args.name && args.name !== 'all';

  let sources: LogSource[];
  if (single) {
    const name = args.name!;
    if (!loadState()[name]) {
      console.error(`✗ agent not found: ${name}`);
      process.exit(1);
    }
    sources = sourcesForAgent(name, mode);
    if (sources.length === 0) {
      const what = mode === 'cdog' ? 'cdog log (log_file not configured)'
        : mode === 'claude' ? 'claude debug log (config "log" not set)'
        : 'logs (no log_file or "log" configured)';
      console.error(`✗ ${name} has no ${what}`);
      process.exit(1);
    }
  } else {
    sources = sourcesForAll(mode);
    if (sources.length === 0) {
      const what = mode === 'cdog' ? 'cdog logs (configure log_file in cdog.json)'
        : mode === 'claude' ? 'claude debug logs (configure log in cdog.json)'
        : 'logs (configure log_file and/or log in cdog.json)';
      console.log(`No ${what} found.`);
      return;
    }
  }

  tailSources(sources, lines, follow, args.err === true, mode === 'both');
  if (follow) return new Promise(() => {}); // stay alive for follow
}
