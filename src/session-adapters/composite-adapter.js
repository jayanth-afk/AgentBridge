import { AgentSessionAdapter } from './base-adapter.js';
import { AntigravitySessionAdapter } from './antigravity-adapter.js';
import { ClaudeDesktopSessionAdapter } from './claude-adapter.js';
import { ChatGPTSessionAdapter } from './chatgpt-adapter.js';
import { ClaudeDesktopUIAdapter, ChatGPTDesktopUIAdapter } from './desktop-ui-adapter.js';
import { sendDesktopNotification } from './desktop-notifier.js';
import { DesktopControlPlane } from '../control-plane/desktop-control-plane.js';

/**
 * CompositeSessionAdapter:
 * Selects the highest-priority legitimate integration transport available:
 *
 * Tier 1: Native autonomous worker (e.g. Antigravity AgentRunner)
 * Tier 2: MCP active turn session (Claude Desktop MCP / ChatGPT Desktop MCP)
 * Tier 3: Local UI automation adapter (when desktopAutomation.enabled is true)
 * Tier 4: Native desktop notification fallback
 *
 * Never downgrades into an unsafe mechanism.
 */
export class CompositeSessionAdapter extends AgentSessionAdapter {
  constructor(agentId, options = {}) {
    if (typeof agentId === 'object' && agentId !== null) {
      options = agentId;
      agentId = options.agentId || 'composite-agent';
    }
    super(agentId, options);

    // Primary MCP adapter
    if (options.mcpAdapter) {
      this.mcpAdapter = options.mcpAdapter;
    } else if (agentId === 'antigravity-ide') {
      this.mcpAdapter = new AntigravitySessionAdapter(options);
    } else if (agentId === 'claude-desktop') {
      this.mcpAdapter = new ClaudeDesktopSessionAdapter(options);
    } else if (agentId === 'chatgpt-desktop') {
      this.mcpAdapter = new ChatGPTSessionAdapter(options);
    } else {
      this.mcpAdapter = new AgentSessionAdapter(agentId, options);
    }

    if (options.desktopUIAdapter) {
      this.uiAdapter = options.desktopUIAdapter;
    } else if (agentId === 'claude-desktop') {
      this.uiAdapter = new ClaudeDesktopUIAdapter(options);
    } else if (agentId === 'chatgpt-desktop') {
      this.uiAdapter = new ChatGPTDesktopUIAdapter(options);
    } else {
      this.uiAdapter = null;
    }

    this.preferredTransport = options.preferredTransport || 'mcp';
    this.desktopAutomationEnabled = Boolean(options.desktopAutomation?.enabled || options.enableDesktopUI);

    this.controlPlane = options.controlPlane || new DesktopControlPlane({
      enabled: this.desktopAutomationEnabled,
      preferredRoute: options.desktopAutomation?.preferredRoute || options.preferredRoute || 'auto',
      ...options.desktopAutomation
    });
  }

  getActiveAdapter() {
    if (this.desktopAutomationEnabled && this.uiAdapter && this.preferredTransport === 'desktop-ui') {
      return this.uiAdapter;
    }
    return this.mcpAdapter;
  }

  async connect() {
    this.connected = true;
    const active = this.getActiveAdapter();
    const res = await active.connect();
    return {
      ...res,
      composite: true,
      activeTransport: active.capabilities().transport || 'mcp-stdio'
    };
  }

  async disconnect() {
    this.connected = false;
    if (this.mcpAdapter) await this.mcpAdapter.disconnect();
    if (this.uiAdapter) await this.uiAdapter.disconnect();
    return { connected: false, agentId: this.agentId };
  }

  isActive() {
    return this.getActiveAdapter().isActive();
  }

  isIdle() {
    return this.getActiveAdapter().isIdle();
  }

  async sendMessage(textOrPayload, options = {}) {
    // 1. If MCP has an active turn, route via MCP
    if (this.mcpAdapter && typeof this.mcpAdapter.isActiveTurn === 'function' && this.mcpAdapter.isActiveTurn()) {
      const res = await this.mcpAdapter.sendMessage(textOrPayload, options);
      return { ...res, route: 'mcp' };
    }

    // 2. If desktop UI automation is enabled and available, route via desktop UI
    const uiActive = this.uiAdapter && (this.desktopAutomationEnabled || this.uiAdapter.enabled);
    if (uiActive) {
      const uiRes = await this.uiAdapter.sendMessage(textOrPayload, options);
      if (uiRes.success) {
        return { ...uiRes, route: 'accessibility' };
      }
    }

    // 3. Fallback to native desktop notification
    const msg = typeof textOrPayload === 'string' ? textOrPayload : (textOrPayload.text || textOrPayload.message);
    const notifRes = await sendDesktopNotification({
      title: `Agent Bridge -> ${this.agentId}`,
      subtitle: 'Incoming Task Notification',
      message: msg
    });

    return {
      success: true,
      delivered: true,
      transport: 'notification',
      route: 'notification',
      agentId: this.agentId,
      status: 'delivered_notification',
      details: notifRes
    };
  }

  async deliverIncomingRequest(request) {
    if (this.desktopAutomationEnabled && this.uiAdapter && (await this.isIdle())) {
      const sendRes = await this.uiAdapter.sendMessage({
        text: request.question,
        requestId: request.requestId,
        conversationId: request.conversationId
      });
      if (sendRes.status === 'delivered_to_ui') {
        return sendRes;
      }
    }

    return await this.mcpAdapter.deliverIncomingRequest(request);
  }

  async deliverResponse(response) {
    return await this.getActiveAdapter().deliverResponse(response);
  }

  async queueRequest(request, options) {
    return await this.mcpAdapter.queueRequest(request, options);
  }

  async recoverPendingRequests() {
    return await this.mcpAdapter.recoverPendingRequests();
  }

  async wake(reason, options) {
    if (this.desktopAutomationEnabled && this.uiAdapter) {
      return await this.uiAdapter.wake(reason);
    }
    return await this.mcpAdapter.wake(reason, options);
  }

  capabilities() {
    const base = this.mcpAdapter ? this.mcpAdapter.capabilities() : {};
    const uiCap = this.uiAdapter ? this.uiAdapter.capabilities() : null;

    return {
      ...base,
      agentId: this.agentId,
      transport: 'composite',
      compositeAdapter: true,
      canWake: Boolean(this.uiAdapter),
      availableTransports: ['mcp-stdio', ...(uiCap ? ['desktop-ui'] : []), 'notification'],
      activeTransport: this.desktopAutomationEnabled ? 'desktop-ui' : (base.transport || 'mcp-stdio'),
      desktopAutomationConfigured: Boolean(this.uiAdapter),
      desktopAutomationEnabled: this.desktopAutomationEnabled
    };
  }

  diagnostics() {
    return {
      agentId: this.agentId,
      connected: this.connected,
      route: this.getActiveAdapter() === this.uiAdapter ? 'accessibility' : 'mcp',
      mcp: {
        connected: Boolean(this.mcpAdapter && this.mcpAdapter.isConnected && this.mcpAdapter.isConnected()),
        activeTurn: Boolean(this.mcpAdapter && this.mcpAdapter.isActiveTurn && this.mcpAdapter.isActiveTurn())
      },
      desktopUi: {
        configured: Boolean(this.uiAdapter),
        enabled: this.desktopAutomationEnabled
      },
      controlPlane: Boolean(this.controlPlane),
      preferredTransport: this.preferredTransport
    };
  }
}
