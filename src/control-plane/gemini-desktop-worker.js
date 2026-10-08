import { DesktopAgentWorker, DesktopAgentWorkerStatus } from './desktop-agent-worker.js';
import { GeminiDesktopSession } from './gemini-desktop-session.js';

export const GeminiWorkerStatus = DesktopAgentWorkerStatus;

/**
 * GeminiDesktopWorker — the `gemini` participant.
 * Drives the REAL Google Gemini Desktop app through GeminiDesktopSession.
 * Extends DesktopAgentWorker to receive Agent Bridge tasks, execute the turn in
 * Gemini.app, wait for the real model response, and settle through MailboxHub.
 */
export class GeminiDesktopWorker extends DesktopAgentWorker {
  constructor(options = {}) {
    const session = options.session || new GeminiDesktopSession(options.geminiDesktop || options.options || {});
    super({ ...options, agentId: options.agentId || 'gemini', session });
  }
}
