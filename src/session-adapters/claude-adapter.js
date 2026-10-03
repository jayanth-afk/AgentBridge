import { AgentSessionAdapter } from './base-adapter.js';
import { sendDesktopNotification, activateDesktopApp } from './desktop-notifier.js';

export class ClaudeDesktopSessionAdapter extends AgentSessionAdapter {
  constructor(options = {}) {
    super('claude-desktop', options);
    this.mailbox = options.mailboxHub || null;
    this.eventBus = options.eventBus || null;
    this.presence = options.presenceManager || null;
    this.enableNotifications = options.enableNotifications !== false;
    this.activateAppOnWake = Boolean(options.activateAppOnWake);
  }

  async connect() {
    this.connected = true;
    return {
      connected: true,
      agentId: this.agentId,
      transport: 'mcp-stdio',
      notes: 'Bridge MCP process active for Claude Desktop'
    };
  }

  async disconnect() {
    this.connected = false;
    return { connected: false, agentId: this.agentId };
  }

  isActive() {
    if (!this.connected) return false;
    if (this.presence) {
      const p = this.presence.getPresence(this.agentId);
      return Boolean(p?.isAlive);
    }
    return true;
  }

  isIdle() {
    if (!this.isActive()) return false;
    if (this.presence) {
      const p = this.presence.getPresence(this.agentId);
      return p?.state === 'IDLE' || !p?.state;
    }
    return true;
  }

  async deliverIncomingRequest(request) {
    // 1. Buffer in durable queue
    const queued = await this.queueRequest(request);

    // 2. Report status truthfully
    return {
      status: 'buffered_in_durable_queue',
      agentId: this.agentId,
      requestId: request.requestId,
      userNotified: queued.userNotified,
      note: 'Stored in SQLite. Claude model session cannot be automatically invoked without active user chat turn.'
    };
  }

  async deliverResponse(response) {
    return {
      status: 'buffered_in_durable_queue',
      agentId: this.agentId,
      requestId: response.requestId
    };
  }

  async queueRequest(request, { notifyUser = this.enableNotifications } = {}) {
    let userNotified = false;
    if (notifyUser) {
      userNotified = await sendDesktopNotification({
        title: 'Agent Bridge: Claude Desktop',
        subtitle: `Request from ${request.fromAgent || 'Peer Agent'}`,
        message: request.question || 'New multi-agent request pending in bridge.'
      });
    }

    if (this.activateAppOnWake) {
      await activateDesktopApp('Claude');
    }

    return {
      status: 'queued',
      agentId: this.agentId,
      requestId: request.requestId,
      userNotified
    };
  }

  async recoverPendingRequests() {
    if (this.mailbox && this.mailbox.getPendingRequests) {
      return this.mailbox.getPendingRequests(this.agentId);
    }
    return [];
  }

  async wake(reason = 'incoming_event', { notifyUser = this.enableNotifications, activateApp = this.activateAppOnWake } = {}) {
    let userNotified = false;
    if (notifyUser) {
      userNotified = await sendDesktopNotification({
        title: 'Agent Bridge: Claude Desktop',
        subtitle: `Wake Event (${reason})`,
        message: 'Claude was requested by a peer agent. Open Claude to continue.'
      });
    }

    if (activateApp) {
      await activateDesktopApp('Claude');
    }

    // Truthful report of transport capability:
    // Bridge MCP process is awake, user notification dispatched, but Claude Desktop GUI model session
    // wakeup is unsupported by the stdio MCP protocol without an active user conversation.
    return {
      success: false,
      agentId: this.agentId,
      wakeupType: 'bridge_process_and_desktop_notification',
      reason,
      userNotified,
      appActivated: Boolean(activateApp),
      error: 'DESKTOP_MODEL_WAKEUP_UNSUPPORTED',
      details: 'Claude Desktop connects via stdio MCP. The Model Context Protocol specification does not support server-initiated LLM turn generation. The request is durably buffered for the next active Claude turn.'
    };
  }

  capabilities() {
    return {
      agentId: this.agentId,
      autonomousExecution: false,
      headlessExecution: false,
      externalModelWakeup: false,
      idleWakeupSupported: false,
      activeTurnRpc: true,
      desktopNotificationSupported: true,
      fileAccess: true,
      gitAccess: true,
      mcpStdio: true,
      requiresUserPrompt: true,
      notes: 'Claude Desktop connects via stdio MCP. When Claude invokes bridge_ask_agent, it can await the correlated response. Inbound requests are durably queued in SQLite with native macOS user notifications, but cannot externally force an idle Claude model to generate a new turn without active user input.'
    };
  }
}
