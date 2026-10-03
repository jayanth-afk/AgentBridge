import { AgentSessionAdapter } from './base-adapter.js';
import { AntigravitySessionAdapter } from './antigravity-adapter.js';
import { ClaudeDesktopSessionAdapter } from './claude-adapter.js';
import { ChatGPTSessionAdapter } from './chatgpt-adapter.js';
import { DesktopUIAdapter, ClaudeDesktopUIAdapter, ChatGPTDesktopUIAdapter } from './desktop-ui-adapter.js';
import { CompositeSessionAdapter } from './composite-adapter.js';
import { sendDesktopNotification, activateDesktopApp } from './desktop-notifier.js';

export {
  AgentSessionAdapter,
  AntigravitySessionAdapter,
  ClaudeDesktopSessionAdapter,
  ChatGPTSessionAdapter,
  DesktopUIAdapter,
  ClaudeDesktopUIAdapter,
  ChatGPTDesktopUIAdapter,
  CompositeSessionAdapter,
  sendDesktopNotification,
  activateDesktopApp
};

export function createSessionAdapter(agentId, options = {}) {
  if (options.useComposite || options.desktopAutomation !== undefined || options.enableDesktopUI) {
    return new CompositeSessionAdapter(agentId, options);
  }

  switch (agentId) {
    case 'antigravity-ide':
      return new AntigravitySessionAdapter(options);
    case 'claude-desktop':
      return new ClaudeDesktopSessionAdapter(options);
    case 'chatgpt-desktop':
      return new ChatGPTSessionAdapter(options);
    case 'claude-ui':
      return new ClaudeDesktopUIAdapter(options);
    case 'chatgpt-ui':
      return new ChatGPTDesktopUIAdapter(options);
    default:
      return new AgentSessionAdapter(agentId, options);
  }
}
