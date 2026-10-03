import { AgentSessionAdapter } from './base-adapter.js';
import { sendDesktopNotification, activateDesktopApp } from './desktop-notifier.js';

export class ChatGPTSessionAdapter extends AgentSessionAdapter {
  constructor(options = {}) {
    super('chatgpt-desktop', options);
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
      notes: 'Bridge MCP process active for ChatGPT Desktop'
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
    const queued = await this.queueRequest(request);
    return {
      status: 'buffered_in_durable_queue',
      agentId: this.agentId,
      requestId: request.requestId,
      userNotified: queued.userNotified,
      note: 'Stored in SQLite. ChatGPT model session cannot be automatically invoked without active user chat turn.'
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
        title: 'Agent Bridge: ChatGPT Desktop',
        subtitle: `Request from ${request.fromAgent || 'Peer Agent'}`,
        message: request.question || 'New multi-agent request pending in bridge.'
      });
    }

    if (this.activateAppOnWake) {
      await activateDesktopApp('ChatGPT');
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
        title: 'Agent Bridge: ChatGPT Desktop',
        subtitle: `Wake Event (${reason})`,
        message: 'ChatGPT was requested by a peer agent. Open ChatGPT to continue.'
      });
    }

    if (activateApp) {
      await activateDesktopApp('ChatGPT');
    }

    return {
      success: false,
      agentId: this.agentId,
      wakeupType: 'bridge_process_and_desktop_notification',
      reason,
      userNotified,
      appActivated: Boolean(activateApp),
      error: 'DESKTOP_MODEL_WAKEUP_UNSUPPORTED',
      details: 'ChatGPT Desktop connects via MCP/connector transport. Server-initiated LLM turn generation is not supported by the desktop app outside an active user chat turn.'
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
      notes: 'ChatGPT Desktop executes tools synchronously when called by ChatGPT. However, external inbound requests cannot awaken the ChatGPT desktop model without an active user conversation.'
    };
  }
}
