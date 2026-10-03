import { AgentSessionAdapter } from './base-adapter.js';

export class ClaudeDesktopSessionAdapter extends AgentSessionAdapter {
  constructor(options = {}) {
    super('claude-desktop', options);
    this.mailbox = options.mailboxHub || null;
    this.eventBus = options.eventBus || null;
    this.guiAdapter = options.guiAdapter || null;
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

  async deliverIncomingRequest(request) {
    return {
      status: 'buffered_in_durable_queue',
      agentId: this.agentId,
      requestId: request.requestId,
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

  async wake(reason = 'incoming_event') {
    // Truthful report of transport capability:
    // Bridge MCP process is awake, but Claude Desktop GUI model session wakeup is unsupported by MCP stdio protocol.
    return {
      success: false,
      agentId: this.agentId,
      wakeupType: 'bridge_process_only',
      reason,
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
      fileAccess: true,
      gitAccess: true,
      mcpStdio: true,
      requiresUserPrompt: true,
      notes: 'Claude Desktop connects via stdio MCP. When Claude invokes bridge_ask_agent, it can await the correlated response. However, inbound requests cannot externally wake the Claude model without an active user conversation.'
    };
  }
}
