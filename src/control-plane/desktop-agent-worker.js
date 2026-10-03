import EventEmitter from 'node:events';

export const DesktopAgentWorkerStatus = Object.freeze({
  IDLE: 'IDLE',
  DELIVERING: 'DELIVERING',
  PROCESSING: 'PROCESSING',
  RECOVERING: 'RECOVERING',
  STOPPED: 'STOPPED'
});

/**
 * DesktopAgentWorker
 *
 * Generic autonomous layer for a desktop model participant (ChatGPT Desktop,
 * Claude Desktop, ...). It subscribes to the durable cross-process EventBus as
 * its own agent id. When a correlated request/task is created for that agent,
 * the EventBus (SQLite outbox + fs.watch wake) pushes the event here; the worker
 * drives the REAL desktop application through its accessibility session, waits
 * for the REAL correlated model response, and routes that response back through
 * the existing correlated request channel (bridge_requests + response_delivered).
 *
 * Guarantees:
 *  - Event-driven: no tight polling; the bus provides wake notifications.
 *  - Idempotent: a requestId is delivered at most once (in-flight + delivered sets).
 *  - Truthful: backing task/request is completed ONLY after a real correlated
 *    model response is observed. Delivery-only outcomes are recorded as failures.
 *  - Lease-aware: refreshes the task lease while the model is generating so long
 *    real turns are not reclaimed as abandoned work.
 */
export class DesktopAgentWorker extends EventEmitter {
  constructor({
    agentId,
    mailboxHub = null,
    eventBus = null,
    session = null,
    logger = null,
    leaseRefreshMs = 5000
  } = {}) {
    super();
    if (!agentId) throw new Error('DesktopAgentWorker requires an agentId');
    if (!session) throw new Error(`DesktopAgentWorker(${agentId}) requires a session`);
    this.agentId = agentId;
    this.mailbox = mailboxHub;
    this.eventBus = eventBus || mailboxHub?.eventBus || null;
    this.session = session;
    this.logger = logger || mailboxHub?.logger || null;
    this.leaseRefreshMs = leaseRefreshMs;

    this.status = DesktopAgentWorkerStatus.STOPPED;
    this.subscription = null;
    this.inFlight = new Set();
    this.delivered = new Set();
    this.stats = { received: 0, delivered: 0, failed: 0, duplicatesSuppressed: 0 };
    // Serial model-turn chain. A desktop app has a single composer, so
    // concurrent turns would corrupt each other's correlation. All deliveries
    // run one-at-a-time through this chain.
    this._turnChain = Promise.resolve();
  }

  async start({ recoverPending = true } = {}) {
    if (!this.eventBus) throw new Error(`${this.constructor.name} requires an EventBus`);
    if (this.subscription) return this;

    this.subscription = this.eventBus.subscribe(this.agentId, (event) => {
      this._onEvent(event);
    });
    this.status = DesktopAgentWorkerStatus.IDLE;
    this.emit('started', { agentId: this.agentId });

    if (recoverPending) {
      this.recoverPendingRequests().catch((err) => this.emit('error', err));
    }
    return this;
  }

  stop() {
    if (this.subscription) {
      try { this.subscription.unsubscribe(); } catch {}
      this.subscription = null;
    }
    this.status = DesktopAgentWorkerStatus.STOPPED;
    this.emit('stopped', { agentId: this.agentId });
  }

  _onEvent(event) {
    if (!event) return;
    if (event.type !== 'request_created' && event.type !== 'task_created') return;
    if (!event.requestId) return;
    if (event.status && ['completed', 'failed', 'cancelled'].includes(event.status)) return;
    if (event.fromAgent === this.agentId) return;
    this.handleRequest(event.requestId).catch((err) => this.emit('error', err));
  }

  async handleRequest(requestId) {
    if (!requestId) return { handled: false, error: 'MISSING_REQUEST_ID' };
    if (this.inFlight.has(requestId)) {
      return { handled: false, requestId, duplicate: true, reason: 'IN_FLIGHT' };
    }
    if (this.delivered.has(requestId)) {
      this.stats.duplicatesSuppressed++;
      return { handled: false, requestId, duplicate: true, reason: 'ALREADY_DELIVERED' };
    }

    // Mark in-flight immediately so a queued duplicate is rejected, then run
    // the actual turn through the serial chain (single composer per app).
    this.inFlight.add(requestId);
    const run = this._turnChain.then(() => this._deliver(requestId));
    this._turnChain = run.then(() => undefined, () => undefined);
    try {
      return await run;
    } finally {
      this.inFlight.delete(requestId);
    }
  }

  async _deliver(requestId) {
    const request = this.mailbox?.getRequest ? this.mailbox.getRequest(requestId) : null;
    if (!request) return { handled: false, requestId, error: 'REQUEST_NOT_FOUND' };
    if (['completed', 'failed', 'cancelled'].includes(request.status)) {
      this.delivered.add(requestId);
      return { handled: false, requestId, error: 'REQUEST_ALREADY_TERMINAL', status: request.status };
    }
    if (request.toAgent && request.toAgent !== this.agentId) {
      return { handled: false, requestId, error: 'WRONG_AGENT', expected: this.agentId, actual: request.toAgent };
    }

    this.status = DesktopAgentWorkerStatus.DELIVERING;
    this.stats.received++;
    const t0 = Date.now();
    this.emit('delivering', { requestId });

    // Keep the task lease fresh while a long real model turn is in progress so
    // the task manager does not reclaim/re-deliver the work underneath us.
    let leaseTimer = null;
    if (request.taskId && this.mailbox?.tasks?.touchTask) {
      leaseTimer = setInterval(() => {
        try { this.mailbox.tasks.touchTask({ taskId: request.taskId, agentId: this.agentId }); } catch {}
      }, this.leaseRefreshMs);
      if (leaseTimer.unref) leaseTimer.unref();
    }

    try {
      this.status = DesktopAgentWorkerStatus.PROCESSING;
      const result = await this.session.send({ text: request.question || '', requestId });

      const hasResponse = Boolean(result.success) && typeof result.response === 'string' && result.response.trim().length > 0;
      if (hasResponse) {
        this._settle(request, { status: 'completed', result: result.response });
        this.delivered.add(requestId);
        this.stats.delivered++;
        const payload = { requestId, response: result.response, latencyMs: Date.now() - t0, status: result.status };
        this.emit('delivered', payload);
        return { handled: true, ...payload };
      }

      const error = result.error || result.status || (result.response === '' ? 'MODEL_RESPONSE_EMPTY' : 'MODEL_RESPONSE_FAILED');
      this._settle(request, { status: 'failed', error });
      this.stats.failed++;
      this.emit('failed', { requestId, error, status: result.status });
      return { handled: true, requestId, success: false, error, status: result.status };
    } catch (err) {
      this.stats.failed++;
      try { this._settle(request, { status: 'failed', error: err.message }); } catch {}
      this.emit('error', err);
      return { handled: true, requestId, success: false, error: err.message };
    } finally {
      if (leaseTimer) clearInterval(leaseTimer);
      this.status = DesktopAgentWorkerStatus.IDLE;
    }
  }

  _settle(request, { status, result = null, error = null }) {
    if (request.taskId) {
      return this.mailbox.submitTaskResult({
        taskId: request.taskId,
        agentId: this.agentId,
        status,
        result,
        error
      });
    }
    return this.mailbox.answerRequest({
      requestId: request.requestId,
      agentId: this.agentId,
      response: result,
      status,
      error
    });
  }

  async recoverPendingRequests() {
    if (!this.mailbox?.getPendingRequests) return [];
    const pending = this.mailbox.getPendingRequests(this.agentId, 50) || [];
    this.status = DesktopAgentWorkerStatus.RECOVERING;
    const results = [];
    for (const req of pending) {
      if (this.delivered.has(req.requestId)) continue;
      results.push(await this.handleRequest(req.requestId));
    }
    this.status = DesktopAgentWorkerStatus.IDLE;
    return results;
  }

  async capabilities() {
    const sessionCaps = await this.session.capabilities();
    return {
      agentId: this.agentId,
      autonomousExecution: true,
      externalModelWakeup: true,
      idleWakeupSupported: true,
      requiresUserPrompt: false,
      eventDriven: true,
      transport: sessionCaps.transport,
      engine: sessionCaps.engine,
      session: sessionCaps
    };
  }

  getStatus() {
    return {
      agentId: this.agentId,
      status: this.status,
      inFlight: this.inFlight.size,
      delivered: this.delivered.size,
      stats: { ...this.stats }
    };
  }
}
