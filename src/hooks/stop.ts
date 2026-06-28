// Stop hook handler — Claude finished a turn.
//
// Ignored when detached. Behavior depends on auto_nudge_stop + interactive:
//   - auto_nudge_stop on  → auto-send prompt (bump nudge_count).
//   - auto_nudge_stop off + interactive on → ask user "Nudge?" (block until
//     response/timeout); on action/timeout → send prompt; on close → no-op.
//   - auto_nudge_stop off + interactive off → no-op.
//
// Per-watch duration check: if deadline reached, stop nudge, kill watchers,
// mark completed, but keep tmux alive (claude context preserved).

import type { StopEvent } from '../types.js';
import { mutateAgent } from '../state.js';
import { tmuxHasSession, tmuxSendText, localISO } from '../util.js';
import { logAgentEvent } from '../logger.js';
import { notify, notifyInteractive } from '../notify.js';
import { findBySession, reloadConfig, resolvePrompt } from './shared.js';
import { killLogWatcher } from '../logwatcher.js';
import { killPaneWatcher } from '../panewatcher.js';

export async function handleStop(ev: StopEvent): Promise<void> {
  const agent = findBySession(ev.session_id);
  if (!agent) return;
  if (agent.cdog_status !== 'watching') return;
  if (!tmuxHasSession(agent.tmux_session)) return;

  // Per-watch duration check: if deadline reached, stop nudging
  if (agent.per_watch_deadline && Date.now() >= agent.per_watch_deadline) {
    logAgentEvent(agent.name, `Stop → per_watch_duration reached, stopping auto-nudge`);
    // Kill watchers (stop monitoring)
    killLogWatcher(agent.name);
    killPaneWatcher(agent.name);
    // Mark completed but keep tmux alive
    mutateAgent(agent.name, (a) => {
      a.claude_status = 'completed';
      a.cdog_status = 'detached';
      a.stop_reason = 'completed';
      a.ended_at = localISO();
    });
    await notify(agent.name, 'max-run-reached', agent.name, `per_watch_duration reached → completed (tmux kept alive)`);
    return; // don't nudge
  }

  // Quota-exceeded wait: claude_status='pending' means a quota nudge is
  // scheduled for the reset time. Bail out entirely — DON'T auto-nudge (it
  // would just trigger 429 churn until reset) and DON'T flip status back to
  // 'running' (it's genuinely waiting for quota). Let the scheduled quota
  // timer resume claude at reset time. (Storm state clearing is not done here
  // at all — only stream/tool success or manual stop/restart/nudge clear it.)
  if (agent.claude_status === 'pending') {
    logAgentEvent(agent.name, `Stop → quota nudge pending, not nudging (waiting for reset)`);
    return;
  }

  if (agent.claude_status !== 'running') {
    logAgentEvent(agent.name, `Stop → claude_status was ${agent.claude_status}, marking running (user-recovered)`);
    mutateAgent(agent.name, (a) => {
      a.claude_status = 'running';
      a.stop_reason = null;
      a.ended_at = null;
    });
    // NOTE: do NOT clear rate_limit storm state here. A Stop event isn't a
    // recovery signal (could be a C-c mid-storm). Storm state is cleared only
    // by stream/tool success (logwatcher) or user takeover (stop/restart/nudge).
  }

  const cfg = reloadConfig(agent);
  const autoNudge = cfg?.watchdog?.auto_nudge_stop === true;
  const interactive = cfg?.notify?.interactive === true && cfg?.notify?.enabled === true;

  if (autoNudge) {
    const prompt = resolvePrompt(cfg);
    tmuxSendText(agent.tmux_session, prompt, true);
    const next = (agent.nudge_count ?? 0) + 1;
    mutateAgent(agent.name, (a) => {
      a.nudge_count = next;
    });
    logAgentEvent(agent.name, `Stop → nudge #${next} ("${prompt}")`);
    await notify(agent.name, 'nudge', agent.name, `Nudge #${next} ("${prompt}")`);
    return;
  }

  if (interactive) {
    const choice = await notifyInteractive(
      agent.name,
      'nudge',
      agent.name,
      'Agent stopped. Nudge it?',
      'Nudge',
      'Skip',
    );
    logAgentEvent(agent.name, `Stop → interactive ask: ${choice}`);
    if (choice === 'action' || choice === 'timeout') {
      const prompt = resolvePrompt(cfg);
      tmuxSendText(agent.tmux_session, prompt, true);
      const next = (agent.nudge_count ?? 0) + 1;
      mutateAgent(agent.name, (a) => {
        a.nudge_count = next;
      });
      logAgentEvent(agent.name, `Stop → nudge #${next} ("${prompt}") (${choice === 'timeout' ? 'timeout→auto' : 'user-approved'})`);
    }
    return;
  }
}
