export class AgentSessionAdapter {
  constructor(agentId, options = {}) {
    this.agentId = agentId;
    this.options = options;
    this.connected = false;
  }

  async connect() {
    this.connected = true;
    return { connected: true, agentId: this.agentId };
  }

  async disconnect() {
    this.connected = false;
    return { connected: false, agentId: this.agentId };
  }

  isActive() {
    return this.connected;
  }

  isIdle() {
    return this.connected;
  }

  async deliverIncomingRequest(request) {
    throw new Error(`deliverIncomingRequest not implemented for ${this.agentId}`);
  }

  async deliverResponse(response) {
    throw new Error(`deliverResponse not implemented for ${this.agentId}`);
  }

  async queueRequest(request) {
    throw new Error(`queueRequest not implemented for ${this.agentId}`);
  }

  async recoverPendingRequests() {
    return [];
  }

  async wake(reason = 'incoming_event') {
    throw new Error(`wake not implemented for ${this.agentId}`);
  }

  capabilities() {
    return {
      agentId: this.agentId,
      autonomousExecution: false,
      headlessExecution: false,
      externalModelWakeup: false,
      idleWakeupSupported: false,
      activeTurnRpc: true,
      desktopNotificationSupported: false,
      mcpStdio: true,
      requiresUserPrompt: true,
      notes: 'Base session adapter'
    };
  }
}
