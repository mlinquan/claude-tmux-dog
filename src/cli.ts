#!/usr/bin/env node
// cdog — Claude Code process manager (tmux + hooks + watcher daemons). v2

import { startCommand, startAll } from './commands/start.js';
import { stopCommand, stopAll } from './commands/stop.js';
import { restartCommand, restartAll } from './commands/restart.js';
import { statusCommand } from './commands/status.js';
import { logCommand } from './commands/log.js';
import { messageSend } from './commands/message.js';
import { notifyCliCommand } from './commands/notify.js';
import { initCommand } from './commands/init.js';
import { deleteCommand, deleteAll } from './commands/delete.js';
import { nudgeDispatch } from './commands/nudge.js';
import { compactCommand } from './commands/compact.js';
import { autoNudgeCommand } from './commands/auto-nudge.js';
import { runLogWatcher, recoverFromApiErrors } from './logwatcher.js';
import { runPaneWatcher } from './panewatcher.js';
import { ALL_KEYWORD } from './types.js';

function usage(): never {
  console.log(`cdog — Claude Code process manager

Usage:
  cdog start [config_path]              Start an agent (default: ./cdog.json)
  cdog start all                        Start every agent that has a config_path
  cdog stop <name|all>                  Detach cdog (stop watching); claude keeps running
  cdog restart <name|all>              Re-watch a detached agent (never kills claude)
  cdog delete <name|all>                Kill tmux session (if any) + remove from state
  cdog status [name]                    pm2-style table, or detail for one
  cdog log [name] [--all] [--no-follow] [--claude-log] [--lines N]
                                        Tail cdog logs (default: follow all)
  cdog message send --to <name> --message <text> [--from <from>] [--reply-method <rm>]
                                        Send a message + Enter to an agent
  cdog nudge <name|all> [text]          Nudge an agent (send prompt + Enter). Manual counterpart
                                        to auto_nudge_stop; ignores detached. Bumps nudge_count.
                                        Text defaults to config.prompt or "continue".
  cdog compact <name>                   Compact agent context: C-c → read tokens → /compact or nudge
  cdog auto-nudge <enable|disable> <name|all>  Toggle auto-nudge in config (persistent)
  cdog notify [json]                    Internal: process a hook event (stdin or arg)
  cdog init                             Install ~/.cdog/ and wire hooks into ~/.claude
  cdog help                             Show this help

"all" is a reserved word — no agent may be named "all".

Examples:
  cdog start ./cdog.json
  cdog status
  cdog nudge snow-agent            # send "continue" (or config.prompt)
  cdog nudge snow-agent keep going # send "keep going"
  cdog message send --to snow-agent --message "status?" --from "hermes"
  cdog log snow-agent --no-follow --lines 100`);
  process.exit(0);
}

/** Parse --key value flags and --bool flags. Returns positional args + collected values. */
function parseArgs(
  argv: string[],
  opts: {
    valueFlags?: Set<string>;
    boolFlags?: Set<string>;
  } = {},
): { positional: string[]; values: Record<string, string>; bools: Set<string> } {
  const { valueFlags = new Set<string>(), boolFlags = new Set<string>() } = opts;
  const positional: string[] = [];
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (boolFlags.has(name)) {
        bools.add(name);
        continue;
      }
      if (valueFlags.has(name)) {
        values[name] = argv[i + 1] ?? '';
        i++;
        continue;
      }
      // unknown --flag: treat as positional? drop it.
      continue;
    }
    positional.push(a);
  }
  return { positional, values, bools };
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  switch (cmd) {
    case 'start': {
      if (rest[0] === ALL_KEYWORD) {
        await startAll();
        break;
      }
      await startCommand(rest[0] ?? './cdog.json');
      break;
    }
    case 'stop': {
      const name = rest[0];
      if (!name) usage();
      if (name === ALL_KEYWORD) await stopAll();
      else await stopCommand(name);
      break;
    }
    case 'restart': {
      const name = rest[0];
      if (!name) usage();
      if (name === ALL_KEYWORD) await restartAll();
      else await restartCommand(name);
      break;
    }
    case 'delete': {
      const name = rest[0];
      if (!name) usage();
      if (name === ALL_KEYWORD) await deleteAll();
      else await deleteCommand(name);
      break;
    }
    case 'status': {
      statusCommand(rest[0]);
      break;
    }
    case 'log':
    case 'logs': {
      const { positional, bools, values } = parseArgs(rest, {
        valueFlags: new Set(['lines']),
        boolFlags: new Set(['all', 'no-follow', 'claude-log', 'follow']),
      });
      const name = positional[0];
      const isAll = bools.has('all') || (!name && positional.length === 0);
      await logCommand({
        name,
        all: isAll,
        noFollow: bools.has('no-follow'),
        claudeLog: bools.has('claude-log'),
        lines: values.lines ? parseInt(values.lines, 10) : undefined,
      });
      break;
    }
    case 'message':
    case 'msg': {
      // cdog message send --to X --message Y [--from F] [--reply-method R]
      const sub = rest[0];
      if (sub !== 'send') usage();
      const { values } = parseArgs(rest.slice(1), {
        valueFlags: new Set(['to', 'message', 'from', 'reply-method', 'reply_method']),
      });
      if (!values.to || values.message === undefined) usage();
      messageSend({
        to: values.to,
        message: values.message,
        from: values.from,
        replyMethod: values['reply-method'] ?? values.reply_method,
      });
      break;
    }
    case 'notify': {
      await notifyCliCommand(rest[0]);
      break;
    }
    case 'nudge': {
      await nudgeDispatch(rest);
      break;
    }
    case 'compact': {
      await compactCommand(rest[0]);
      break;
    }
    case 'auto-nudge': {
      autoNudgeCommand(rest);
      break;
    }
    case 'init': {
      initCommand();
      break;
    }
    case '__watch': {
      // Internal: detached log-watcher subprocess entry point.
      const name = rest[0];
      if (!name) process.exit(1);
      await runLogWatcher(name);
      break;
    }
    case '__recover-from-errors': {
      // Internal: invoked by the log watcher when API error threshold is reached.
      const name = rest[0];
      if (!name) process.exit(1);
      await recoverFromApiErrors(name);
      break;
    }
    case '__panewatch': {
      // Internal: detached pane-watcher subprocess entry point.
      const name = rest[0];
      if (!name) process.exit(1);
      await runPaneWatcher(name);
      break;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      console.error(`✗ unknown command: ${cmd}`);
      usage();
  }
}

main().catch((e: unknown) => {
  console.error(`✗ ${(e as Error)?.message ?? e}`);
  process.exit(1);
});
