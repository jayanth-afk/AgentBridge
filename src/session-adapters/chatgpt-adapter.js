import { AgentSessionAdapter } from './base-adapter.js';

export class ChatGPTSessionAdapter extends AgentSessionAdapter {
  constructor(options = {}) {
    super('chatgpt-desktop', options);
    this.mailbox = options.mailboxHub || null;
    this.eventBus = options.eventBus || null;
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

  async deliverIncomingRequest(request) {
    return {
      status: 'buffered_in_durable_queue',
      agentId: this.agentId,
      requestId: request.requestId,
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

  async wake(reason = 'incoming_event') {
    return {
      success: false,
      agentId: this.agentId,
      wakeupType: 'bridge_process_only',
      reason,
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
      fileAccess: true,
      gitAccess: true,
      mcpStdio: true,
      requiresUserPrompt: true,
      notes: 'ChatGPT Desktop executes tools synchronously when called by ChatGPT. However, external inbound requests cannot awaken the ChatGPT desktop model without an active user conversation.'
    };
  }
}
