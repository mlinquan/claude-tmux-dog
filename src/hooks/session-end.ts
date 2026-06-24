// SessionEnd hook handler — Claude session exited.
//
// Ignored when detached. Determines final status:
//   - reason "compact" / "resume" → not a real exit, ignore.
//   - per_watch_duration deadline reached → completed (keep tmux alive, kill watchers).
//   - reason "clear" → stopped (user manually cleared).
//   - otherwise → failed.

import type { SessionEndEvent } from '../types.js';
import { mutateAgent } from '../state.js';
import { tmuxHasSession, localISO } from '../util.js';
import { logAgentEvent } from '../logger.js';
import { notify } from '../notify.js';
import { findBySession } from './shared.js';
import { killLogWatcher } from '../logwatcher.js';
import { killPaneWatcher } from '../panewatcher.js';

export async function handleSessionEnd(ev: SessionEndEvent): Promise<void> {
  const reason = ev.reason ?? '';
  if (reason === 'compact' || reason === 'resume') return;
  const agent = findBySession(ev.session_id);
  if (!agent) return;
  if (agent.cdog_status !== 'watching') return;

  const now = Date.now();
  let status: 'stopped' | 'failed' | 'completed' = reason === 'clear' ? 'stopped' : 'failed';

  if (agent.per_watch_deadline && now >= agent.per_watch_deadline) {
    status = 'completed';
    // Keep tmux alive (claude context preserved), just kill watchers
    killLogWatcher(agent.name);
    killPaneWatcher(agent.name);
    logAgentEvent(agent.name, 'SessionEnd: per_watch_duration reached, watchers killed, tmux kept alive');
  }

  mutateAgent(agent.name, (a) => {
    a.claude_status = status;
    a.stop_reason = status;
    a.ended_at = localISO();
  });
  logAgentEvent(agent.name, `SessionEnd (${reason}) → ${status}`);
  if (status === 'completed') {
    await notify(agent.name, 'max-run-reached', agent.name, `per_watch_duration reached → completed`);
  } else if (reason === 'clear') {
    await notify(agent.name, 'task-completed', agent.name, `Session ended (clear) → ${status}`);
  }
}
