import { AgentSessionAdapter } from './base-adapter.js';
import { AntigravitySessionAdapter } from './antigravity-adapter.js';
import { ClaudeDesktopSessionAdapter } from './claude-adapter.js';
import { ChatGPTSessionAdapter } from './chatgpt-adapter.js';

export {
  AgentSessionAdapter,
  AntigravitySessionAdapter,
  ClaudeDesktopSessionAdapter,
  ChatGPTSessionAdapter
};

export function createSessionAdapter(agentId, options = {}) {
  switch (agentId) {
    case 'antigravity-ide':
      return new AntigravitySessionAdapter(options);
    case 'claude-desktop':
      return new ClaudeDesktopSessionAdapter(options);
    case 'chatgpt-desktop':
      return new ChatGPTSessionAdapter(options);
    default:
      return new AgentSessionAdapter(agentId, options);
  }
}
