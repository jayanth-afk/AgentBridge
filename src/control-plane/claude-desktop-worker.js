import { DesktopAgentWorker, DesktopAgentWorkerStatus } from './desktop-agent-worker.js';
import { ClaudeDesktopSession } from './claude-desktop-session.js';

export const ClaudeWorkerStatus = DesktopAgentWorkerStatus;

/**
 * ClaudeDesktopWorker — the `claude-desktop` participant.
 * Drives the REAL Claude Desktop app through ClaudeDesktopSession.
 * See DesktopAgentWorker for the event-driven delivery/guarantee contract.
 */
export class ClaudeDesktopWorker extends DesktopAgentWorker {
  constructor(options = {}) {
    const session = options.session || new ClaudeDesktopSession(options.claudeDesktop || options.options || {});
    super({ ...options, agentId: options.agentId || 'claude-desktop', session });
  }
}
