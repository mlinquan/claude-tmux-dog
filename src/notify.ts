// Desktop notifications via node-notifier + optional custom sound via afplay.
//
// Two modes:
//   - plain notify(): fire-and-forget reminder (cross-platform).
//   - interactive notifyInteractive() (macOS only): blocks until user clicks an
//     action button, closes, or times out. Returns the user's choice. Used when
//     an auto-action is OFF and cdog wants to ask the user whether to act.

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NotificationCenter } from 'node-notifier';
import type { NotifyConfig, NotifyEvent } from './types.js';
import { logAgentEvent } from './logger.js';
import { loadState } from './state.js';
import { loadConfig } from './config.js';
import { buildTerminalClickCommand } from './terminal.js';

/** Bundled assets dir: dist/notify.js -> ../assets */
function assetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'assets');
}

const DEFAULT_ICON = () => join(assetsDir(), 'icon.png');
const soundPath = (lang: string, event: NotifyEvent) =>
  join(assetsDir(), 'sounds', lang, `${event}.mp3`);

// ---- Notification dedup/throttle ----
// Avoids notification storms: same (agent, event) within DEDUP_WINDOW_MS
// is suppressed. Prevents the "notifications pile up and burst after restart"
// issue when many API errors fire in quick succession.
const DEDUP_WINDOW_MS = 30_000;
const lastNotified = new Map<string, number>();

/** Returns true if this (agent, event) was notified recently (within DEDUP_WINDOW_MS). */
function isDuplicate(agentName: string, event: NotifyEvent): boolean {
  const key = `${agentName}:${event}`;
  const now = Date.now();
  const last = lastNotified.get(key) ?? 0;
  if (now - last < DEDUP_WINDOW_MS) return true;
  lastNotified.set(key, now);
  return false;
}

/** Resolve the notify config for an agent (reloads its cdog.json). Null if none / disabled. */
function resolveConfig(agentName: string): NotifyConfig | null {
  const state = loadState();
  const agent = state[agentName];
  if (!agent) return null;
  if (!agent.config_path || !existsSync(agent.config_path)) return null;
  let fullCfg;
  try {
    fullCfg = loadConfig(agent.config_path);
  } catch {
    return null;
  }
  const notify = fullCfg.notify;
  if (!notify || notify.enabled !== true) return null;
  return notify;
}

/** Is this event enabled in the config? Unlisted events default to true. */
function eventEnabled(cfg: NotifyConfig, event: NotifyEvent): boolean {
  const v = cfg.on?.[event];
  return v !== false;
}

// Events that default to SILENT even when master `sound` is on — they fire
// frequently on a 24/7 agent (every Stop nudge, every API error, every compact)
// and would beep all night. Override with `sound_on: { <event>: true }`.
const SILENT_BY_DEFAULT = new Set<NotifyEvent>(['api-error', 'nudge', 'compact']);

/**
 * Should this event play sound? Master `sound` flag is the default; `sound_on`
 * overrides per event (true → always, false → never). Chatty events
 * (api-error/nudge/compact) default to silent unless explicitly enabled.
 */
export function shouldPlaySound(cfg: NotifyConfig, event: NotifyEvent): boolean {
  const v = cfg.sound_on?.[event];
  if (v === true) return true;
  if (v === false) return false;
  if (cfg.sound !== true) return false;
  return !SILENT_BY_DEFAULT.has(event);
}

/** Play a custom sound via afplay (macOS). No-op on other platforms / missing file. */
function playSound(lang: string, event: NotifyEvent): void {
  if (process.platform !== 'darwin') return;
  const p = soundPath(lang, event);
  if (!existsSync(p)) return;
  try {
    const child = spawn('afplay', [p], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* best effort */
  }
}

/**
 * Run the user's notify.command (best-effort, never throws). Context is passed
 * ONLY as env/args — never interpolated into the command string — so message
 * text can't break or inject into the command. Killed after command_timeout so
 * a hung command can't stall cdog. The child is detached+unref'd so a long-
 * running webhook won't block the notifying (often hook-spawned, short-lived)
 * process from exiting.
 */
function runCommand(
  cfg: NotifyConfig,
  agentName: string,
  event: NotifyEvent,
  title: string,
  message: string,
): void {
  const cmd = cfg.command;
  if (!cmd) return;
  const timeoutSec = cfg.command_timeout ?? 30;
  const env = {
    ...process.env,
    CDOG_AGENT: agentName,
    CDOG_EVENT: event,
    CDOG_TITLE: title,
    CDOG_MESSAGE: message,
  };
  let child: import('node:child_process').ChildProcess;
  try {
    child = spawn('sh', ['-c', cmd, 'cdog-notify', agentName, event, title, message], {
      detached: true,
      stdio: 'ignore',
      env,
    });
  } catch (e) {
    try { logAgentEvent(agentName, `notify command spawn failed: ${(e as Error).message}`); } catch { /* ignore */ }
    return;
  }
  child.unref();
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    try { logAgentEvent(agentName, `notify command timed out after ${timeoutSec}s, killed`); } catch { /* ignore */ }
  }, timeoutSec * 1000);
  child.on('exit', () => clearTimeout(timer));
}

function resolveIcon(cfg: NotifyConfig): string | undefined {
  if (cfg.icon && existsSync(cfg.icon)) return cfg.icon;
  const def = DEFAULT_ICON();
  return existsSync(def) ? def : undefined;
}

/**
 * Fire a plain (non-blocking) desktop notification for an agent event.
 * No-ops if notify not enabled or the event is disabled. Never throws.
 *
 * Returns a Promise that resolves when the notification has been dispatched
 * (or after a 2s timeout). The caller can await this to ensure the process
 * doesn't exit before the notification is delivered — critical for short-lived
 * processes like `cdog notify` (hook-triggered).
 */
export function notify(agentName: string, event: NotifyEvent, title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const cfg = resolveConfig(agentName);
      if (!cfg) { resolve(); return; }
      if (!eventEnabled(cfg, event)) { resolve(); return; }
      // Dedup: skip if same (agent, event) was notified recently.
      if (isDuplicate(agentName, event)) { resolve(); return; }
      // Click on notification body → open tmux session in Terminal.app.
      const executeCmd = openOnClickEnabled(cfg) ? buildExecuteCommand(cfg, agentName) : undefined;
      fireNotification(cfg, title, message, false, 0, undefined, undefined, () => {}, executeCmd);
      if (shouldPlaySound(cfg, event)) playSound(cfg.lang ?? 'default', event);
      runCommand(cfg, agentName, event, title, message);
    } catch {
      /* never break main flow */
    }
    // Give terminal-notifier 2s to dispatch, then resolve regardless.
    // The notification is already forked as a subprocess — it will deliver
    // even if we resolve early. This just prevents the parent process from
    // exiting before the fork happens.
    setTimeout(resolve, 2000);
  });
}

export type InteractiveChoice = 'action' | 'close' | 'timeout' | 'error';

/** Is open_on_click enabled? Defaults to true (opt-opt). */
function openOnClickEnabled(cfg: NotifyConfig): boolean {
  return cfg.open_on_click !== false;
}

/**
 * Build the notification -execute command: opens or focuses the configured
 * terminal app (`notify.terminal`, default Terminal.app) on the agent's tmux
 * session. If a client is already attached → focus it; else → open + attach.
 * Returns undefined if the agent has no tmux session.
 */
function buildExecuteCommand(cfg: NotifyConfig, agentName: string): string | undefined {
  const session = resolveTmuxSession(agentName);
  if (!session) return undefined;
  return buildTerminalClickCommand(cfg.terminal, session);
}

/**
 * Resolve the tmux session for an agent (from state). Used to build the
 * click-to-open command for notifications.
 */
function resolveTmuxSession(agentName: string): string | null {
  const state = loadState();
  const agent = state[agentName];
  return agent?.tmux_session ?? null;
}

/**
 * Fire an INTERACTIVE notification (macOS only) that blocks until the user picks
 * an action, closes, or times out. Resolves with the choice.
 *
 * On non-macOS platforms, degrades to a plain notification and resolves 'timeout'
 * immediately (no interactive support on notify-send; Windows Toaster has partial
 * support but we don't block on it).
 *
 * `actionLabel` is the confirm button (e.g. "Nudge"); `closeLabel` is the cancel
 * button (e.g. "Skip"). The choice is 'action' if the user clicked actionLabel.
 */
export function notifyInteractive(
  agentName: string,
  event: NotifyEvent,
  title: string,
  message: string,
  actionLabel: string,
  closeLabel: string,
): Promise<InteractiveChoice> {
  return new Promise((resolve) => {
    try {
      const cfg = resolveConfig(agentName);
      if (!cfg || !eventEnabled(cfg, event) || cfg.interactive !== true) {
        // Not interactive-capable → fire plain notify (if enabled) and resolve timeout.
        if (cfg && eventEnabled(cfg, event)) {
          const executeCmd = openOnClickEnabled(cfg) ? buildExecuteCommand(cfg, agentName) : undefined;
          fireNotification(cfg, title, message, false, 0, undefined, undefined, () => {}, executeCmd);
          if (shouldPlaySound(cfg, event)) playSound(cfg.lang ?? 'default', event);
        }
        resolve('timeout');
        return;
      }

      if (process.platform !== 'darwin') {
        // Non-macOS: no blocking interaction. Plain notify + resolve timeout.
        const executeCmd = openOnClickEnabled(cfg) ? buildExecuteCommand(cfg, agentName) : undefined;
        fireNotification(cfg, title, message, false, 0, undefined, undefined, () => {}, executeCmd);
        if (shouldPlaySound(cfg, event)) playSound(cfg.lang ?? 'default', event);
        resolve('timeout');
        return;
      }

      const timeoutSecs = cfg.ask_timeout && cfg.ask_timeout > 0 ? cfg.ask_timeout : 30;
      // Click on notification body → open tmux session in Terminal.app.
      const executeCmd = openOnClickEnabled(cfg) ? buildExecuteCommand(cfg, agentName) : undefined;
      fireNotification(
        cfg,
        title,
        message,
        true, // wait
        timeoutSecs,
        actionLabel,
        [actionLabel],
        (choice) => resolve(choice),
        executeCmd,
      );
      if (shouldPlaySound(cfg, event)) playSound(cfg.lang ?? 'default', event);
    } catch {
      resolve('error');
    }
  });
}

/** Low-level fire. macOS NotificationCenter with optional interactivity. */
function fireNotification(
  cfg: NotifyConfig,
  title: string,
  message: string,
  wait: boolean,
  timeoutSecs: number,
  closeLabel: string | undefined,
  actions: string[] | undefined,
  onDone: (choice: InteractiveChoice) => void,
  execute?: string,
): void {
  // withFallback: true so that if terminal-notifier/NotificationCenter is
  // unresponsive (e.g. usernoted stuck), node-notifier can degrade to other
  // backends instead of silently dropping the notification.
  const nc = new NotificationCenter({ withFallback: true });
  const icon = resolveIcon(cfg);
  const opts: Record<string, unknown> = {
    title: `cdog · ${title}`,
    message,
    sound: false, // custom sound handled by afplay to avoid double sound
    icon,
    contentImage: icon,
    wait,
    // Don't let terminal-notifier queue up indefinitely; if the notification
    // isn't shown within this many seconds, drop it instead of piling up.
    timeout: wait ? timeoutSecs : 10,
  };
  // Click on notification body → execute command (open tmux in Terminal.app).
  // terminal-notifier supports -execute; node-notifier passes unknown keys
  // through as -<key> <value> via constructArgumentList.
  if (execute) opts.execute = execute;
  if (wait) {
    opts.timeout = timeoutSecs;
    if (closeLabel) opts.closeLabel = closeLabel;
    if (actions) {
      opts.actions = actions;
      opts.dropdownLabel = actions.length > 1 ? 'Actions' : undefined;
    }
  }
  nc.notify(opts as any, (error: Error | null, response: any, metadata: any) => {
    if (error) {
      onDone('error');
      return;
    }
    const activation = metadata?.activationType ?? response;
    // terminal-notifier reports: 'action_clicked' | 'closed' | 'timeout' | 'com.apple.notificationcenter.action'
    if (activation === 'action_clicked' || activation === 'com.apple.notificationcenter.action' || response === 'activate') {
      onDone('action');
    } else if (activation === 'timeout' || response === 'timeout') {
      onDone('timeout');
    } else if (activation === 'closed' || response === 'closed') {
      onDone('close');
    } else {
      // Any other activation treat as no-action.
      onDone('close');
    }
  });
}
