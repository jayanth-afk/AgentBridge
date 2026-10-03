import { DesktopAgentWorker, DesktopAgentWorkerStatus } from './desktop-agent-worker.js';
import { ChatGptAutonomousSession } from './chatgpt-autonomous-session.js';

export const ChatGptWorkerStatus = DesktopAgentWorkerStatus;

/**
 * ChatGptDesktopWorker — the `chatgpt-desktop` participant.
 * Drives the REAL ChatGPT Desktop app through ChatGptAutonomousSession.
 * See DesktopAgentWorker for the event-driven delivery/guarantee contract.
 */
export class ChatGptDesktopWorker extends DesktopAgentWorker {
  constructor(options = {}) {
    const session = options.session || new ChatGptAutonomousSession(options.chatgptDesktop || options.options || {});
    super({ ...options, agentId: options.agentId || 'chatgpt-desktop', session });
  }
}
