import { AgentSessionAdapter } from './base-adapter.js';
import { sendDesktopNotification, activateDesktopApp } from './desktop-notifier.js';
import { ChatGptAutonomousSession } from '../control-plane/chatgpt-autonomous-session.js';

export class ChatGPTSessionAdapter extends AgentSessionAdapter {
  constructor(options = {}) {
    super('chatgpt-desktop', options);
    this.mailbox = options.mailboxHub || null;
    this.eventBus = options.eventBus || null;
    this.presence = options.presenceManager || null;
    this.enableNotifications = options.enableNotifications !== false;
    this.activateAppOnWake = Boolean(options.activateAppOnWake);
    // Opt-in autonomous delivery through the REAL ChatGPT Desktop app.
    // Disabled by default so existing notification/buffer semantics are preserved.
    this.autonomousSession = options.chatgptSession || (options.autonomous ? new ChatGptAutonomousSession(options.chatgptDesktop || options) : null);
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
    // Autonomous path: submit to the REAL ChatGPT Desktop app and wait for the
    // real, correlated model response. We never report "delivered" as success
    // here — the response itself is the proof of a completed model turn.
    if (this.autonomousSession) {
      const turn = await this.autonomousSession.send({
        text: request.question || request.message || '',
        requestId: request.requestId
      });
      return {
        status: turn.success ? 'model_turn_completed' : 'model_turn_failed',
        agentId: this.agentId,
        requestId: request.requestId,
        response: turn.response,
        transport: turn.transport,
        modelTurnConfirmed: turn.modelTurnConfirmed,
        error: turn.error,
        latencyMs: turn.latencyMs
      };
    }

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
    // Autonomous path: wake by driving the real ChatGPT Desktop app. Any pending
    // correlated requests are recovered and answered with real model turns.
    if (this.autonomousSession) {
      const available = await this.autonomousSession.isAvailable().catch(() => false);
      return {
        success: available,
        agentId: this.agentId,
        wakeupType: 'chatgpt-desktop-accessibility',
        reason,
        appActivated: available,
        sessionAvailable: available,
        error: available ? null : 'CHATGPT_ACCESSIBILITY_UNAVAILABLE'
      };
    }

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
    if (this.autonomousSession) {
      return {
        agentId: this.agentId,
        autonomousExecution: true,
        headlessExecution: false,
        externalModelWakeup: true,
        idleWakeupSupported: true,
        activeTurnRpc: true,
        transport: 'chatgpt-desktop-accessibility',
        desktopNotificationSupported: true,
        fileAccess: true,
        gitAccess: true,
        mcpStdio: true,
        requiresUserPrompt: false,
        notes: 'Autonomous delivery to the REAL ChatGPT Desktop app via user-authorized macOS Accessibility. Request submission and real model response correlation are enabled.'
      };
    }

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
