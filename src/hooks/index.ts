// Hook event dispatcher — entry point for `cdog notify [json]`.
//
// Reads the hook event JSON from argv or stdin, parses it, and dispatches to
// the appropriate handler. When an agent's cdog_status is 'detached', ALL
// events are ignored (claude keeps running, cdog is hands-off).

import type { HookEvent } from '../types.js';
import { mutateAgent } from '../state.js';
import { logAgentEvent } from '../logger.js';
import { readEvent, findBySession } from './shared.js';
import { observeDetached } from './observe.js';
import { handleStop } from './stop.js';
import { handleStopFailure } from './stop-failure.js';
import { handleSessionEnd } from './session-end.js';
import { handlePreCompact, handlePostCompact } from './compact.js';

export { readEvent };

export async function notifyCommand(argJson?: string): Promise<void> {
  const ev = readEvent(argJson);
  if (!ev || !ev.hook_event_name || !ev.session_id) return;

  // Detached agents: observe-only. Hooks still fire (Claude Code always invokes
  // them), so record the truthful claude_status, but never act — no nudge, no
  // recover, no notify, no watcher/kill. Single chokepoint covering all events.
  const agent = findBySession(ev.session_id);
  if (agent && agent.cdog_status === 'detached') {
    observeDetached(agent, ev);
    return;
  }

  switch (ev.hook_event_name) {
    case 'Stop':
      await handleStop(ev);
      break;
    case 'StopFailure':
      handleStopFailure(ev).catch((err) =>
        logAgentEvent('cdog', `StopFailure handler error: ${err}`),
      );
      break;
    case 'SessionStart': {
      const agent = findBySession(ev.session_id);
      if (!agent) return;
      if (agent.cdog_status !== 'watching') return;
      mutateAgent(agent.name, (a) => {
        a.claude_status = 'running';
      });
      // NOTE: no rate_limit storm clearing here. Storm state is cleared only by
      // stream/tool success (logwatcher) or user takeover (stop/restart/nudge).
      break;
    }
    case 'SessionEnd':
      await handleSessionEnd(ev);
      break;
    case 'PreCompact':
      handlePreCompact(ev);
      break;
    case 'PostCompact':
      await handlePostCompact(ev);
      break;
    case 'UserPromptSubmit': {
      // Turn START signal: claude begins working on a prompt (incl. cdog
      // nudges). Mark running immediately — the watching-mode Stop handler
      // only fires at turn end, so without this a freshly-nudged idle agent
      // would show a stale status until its first turn completes.
      const a = findBySession(ev.session_id);
      if (a) {
        mutateAgent(a.name, (s) => {
          s.claude_status = 'running';
        });
      }
      break;
    }
    default:
      break;
  }
}
