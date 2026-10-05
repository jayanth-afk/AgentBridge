import { ChatGptAutonomousSession } from './chatgpt-autonomous-session.js';

/**
 * ZiA Background GPT
 *
 * Product-facing name for ZiA's non-foreground ChatGPT worker.
 * It always uses the real user-authorized ChatGPT Desktop application.
 * It never activates ChatGPT or claims a response without model-turn evidence.
 */
export class ZiABackgroundGPT extends ChatGptAutonomousSession {
  constructor(options = {}) {
    super({
      ...options,
      background: true,
      headless: true,
      backgroundTransport: options.backgroundTransport || 'auto',
      backgroundWorkerName: 'ZiA Background GPT'
    });
  }
}
