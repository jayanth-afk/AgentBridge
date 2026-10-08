/**
 * AgentBridgeClient:
 * Clean, lightweight, self-contained Bridge-facing SDK client for Zia Core and external agents.
 * Connects over HTTP or local bridge interface without importing or altering Zia internals.
 */
export class AgentBridgeClient {
  constructor({
    baseUrl = 'http://127.0.0.1:8765',
    apiKey = null,
    agentId = 'zia-core'
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.agentId = agentId;
  }

  async _request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Agent-ID': this.agentId,
      ...(this.apiKey ? { 'X-API-Key': this.apiKey, 'Authorization': `Bearer ${this.apiKey}` } : {}),
      ...(options.headers || {})
    };

    const res = await fetch(url, {
      ...options,
      headers
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error(`Bridge HTTP Error ${res.status}: ${errText}`);
      err.status = res.status;
      throw err;
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return await res.json();
    }
    return await res.text();
  }

  /** Health & Connectivity */
  async ping() {
    return this._request('/health');
  }

  /** Agent Discovery & Presence */
  async discoverAgents() {
    return this.executeTool('bridge_discover_agents', {});
  }

  async getPresence(agentId) {
    return this.executeTool('bridge_agent_presence', { agentId });
  }

  /** Capability Inspection Scoped to (agent_id, route_id) */
  async getCapabilities(agentId) {
    return this.executeTool('bridge_get_adapter_capabilities', { agentId });
  }

  /** Correlated Query (Ask) */
  // Native desktop model turns may take >30s; callers can still override this.
  async askAgent({ toAgent, question, context = null, timeoutMs = 90000, asyncMode = false }) {
    return this.executeTool('bridge_ask_agent', {
      fromAgent: this.agentId,
      toAgent,
      question,
      context,
      timeoutMs,
      asyncMode
    });
  }

  /** Delegation & Tasks */
  async delegateTask({
    toAgent,
    title,
    instructions,
    context = null,
    priority = 'normal',
    dependencies = []
  }) {
    return this.executeTool('bridge_delegate_task', {
      fromAgent: this.agentId,
      toAgent,
      title,
      instructions,
      context,
      priority,
      dependencies
    });
  }

  async getTaskStatus(taskId) {
    return this.executeTool('bridge_get_task_status', { taskId });
  }

  /** Request Explanation & Observability */
  async explainRequest(requestId) {
    return this.executeTool('bridge_explain_request', { requestId });
  }

  /** Answering & Messaging */
  async answerRequest({ requestId, response }) {
    return this.executeTool('bridge_answer_request', {
      requestId,
      agentId: this.agentId,
      response
    });
  }

  async sendMessage({ toAgent, subject, content }) {
    return this.executeTool('bridge_send_message', {
      fromAgent: this.agentId,
      toAgent,
      subject,
      content
    });
  }

  async checkInbox({ unreadOnly = false, limit = 20 } = {}) {
    return this.executeTool('bridge_check_inbox', {
      agentId: this.agentId,
      unreadOnly,
      limit
    });
  }

  /** Code Review & Collaboration */
  async requestReview({ toAgent, filePath, description = '' }) {
    return this.executeTool('bridge_request_review', {
      fromAgent: this.agentId,
      toAgent,
      filePath,
      description
    });
  }

  async createCollaboration({ title, objective }) {
    return this.executeTool('bridge_create_collaboration', {
      ownerAgent: this.agentId,
      title,
      objective
    });
  }

  /** Generic Tool Execution Endpoint */
  async executeTool(toolName, args = {}) {
    const payload = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: {
          agentId: this.agentId,
          ...args
        }
      }
    };

    return this._request('/api/mcp/call', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }
}
