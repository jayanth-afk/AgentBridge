import { AgentSessionAdapter } from './base-adapter.js';

export class AntigravitySessionAdapter extends AgentSessionAdapter {
  constructor(options = {}) {
    super('antigravity-ide', options);
    this.runner = options.runner || null;
    this.mailbox = options.mailboxHub || null;
    this.eventBus = options.eventBus || null;
  }

  async connect() {
    this.connected = true;
    if (this.runner && !this.runner.running) {
      this.runner.start();
    }
    return { connected: true, agentId: this.agentId, mode: 'autonomous_worker' };
  }

  async disconnect() {
    this.connected = false;
    if (this.runner && this.runner.running) {
      this.runner.stop();
    }
    return { connected: false, agentId: this.agentId };
  }

  isActive() {
    return this.connected && (this.runner ? this.runner.running : true);
  }

  isIdle() {
    return this.isActive() && (!this.runner || this.runner.state === 'IDLE');
  }

  async deliverIncomingRequest(request) {
    if (this.runner) {
      this.runner.wakeUp('adapter_deliverIncomingRequest');
      return {
        status: 'dispatched_to_autonomous_runner',
        agentId: this.agentId,
        requestId: request.requestId || request.id
      };
    }
    return { status: 'queued', agentId: this.agentId };
  }

  async deliverResponse(response) {
    return {
      status: 'delivered',
      agentId: this.agentId,
      requestId: response.requestId
    };
  }

  async queueRequest(request) {
    if (this.runner) {
      this.runner.wakeUp('adapter_queueRequest');
    }
    return {
      status: 'queued_and_runner_notified',
      agentId: this.agentId,
      requestId: request.requestId || request.id
    };
  }

  async recoverPendingRequests() {
    if (this.mailbox && this.mailbox.getPendingRequests) {
      return this.mailbox.getPendingRequests(this.agentId);
    }
    return [];
  }

  async wake(reason = 'external_event') {
    if (this.runner) {
      this.runner.wakeUp(reason);
      return {
        success: true,
        agentId: this.agentId,
        wakeupType: 'autonomous_runner_wakeup',
        reason
      };
    }
    return { success: true, agentId: this.agentId, wakeupType: 'bridge_process_only', reason };
  }

  capabilities() {
    return {
      agentId: this.agentId,
      autonomousExecution: true,
      headlessExecution: true,
      externalModelWakeup: true,
      idleWakeupSupported: true,
      activeTurnRpc: true,
      desktopNotificationSupported: false,
      fileAccess: true,
      gitAccess: true,
      mcpStdio: true,
      requiresUserPrompt: false,
      notes: 'Antigravity IDE runs autonomous background workers (AgentRunner) that genuinely wake from EventBus, claim tasks atomically, execute tool operations, and deliver correlated responses without manual intervention.'
    };
  }
}
