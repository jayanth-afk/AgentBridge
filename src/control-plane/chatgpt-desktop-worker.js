import EventEmitter from 'node:events';
import { ChatGptAutonomousSession } from './chatgpt-autonomous-session.js';

export const ChatGptWorkerStatus = Object.freeze({
  IDLE: 'IDLE',
  DELIVERING: 'DELIVERING',
  PROCESSING: 'PROCESSING',
  RECOVERING: 'RECOVERING',
  STOPPED: 'STOPPED'
});

/**
 * ChatGptDesktopWorker
 *
 * This is the missing autonomous layer: it subscribes to the durable
 * cross-process EventBus as the `chatgpt-desktop` agent. When a request or task
 * is created for ChatGPT, the EventBus (SQLite outbox + fs.watch wake) pushes
 * the event here, and this worker drives the REAL ChatGPT Desktop app through
 * the accessibility session, waits for the real correlated model response, and
 * routes that response back through the existing correlated request channel
 * (bridge_requests + response_delivered event).
 *
 * Guarantees:
 *  - Event-driven (no tight polling loop; the bus provides wake notifications).
 *  - Idempotent: a requestId is delivered at most once.
 *  - Truthful completion: the backing task/request is only marked completed
 *    after a real correlated model response is observed. Delivery-only outcomes
 *    are recorded as failures with explicit status codes, never as success.
 */
export class ChatGptDesktopWorker extends EventEmitter {
  constructor({
    agentId = 'chatgpt-desktop',
    mailboxHub,
    eventBus = null,
    session = null,
    logger = null,
    options = {}
  } = {}) {
    super();
    this.agentId = agentId;
    this.mailbox = mailboxHub || null;
    this.eventBus = eventBus || mailboxHub?.eventBus || null;
    this.logger = logger || mailboxHub?.logger || null;
    this.session = session || new ChatGptAutonomousSession(options.chatgptDesktop || options);

    this.status = ChatGptWorkerStatus.STOPPED;
    this.subscription = null;
    this.inFlight = new Set();     // requestIds currently being delivered
    this.delivered = new Set();    // requestIds already answered (idempotency)
    this.stats = { received: 0, delivered: 0, failed: 0, duplicatesSuppressed: 0 };
  }

  /**
   * Start the worker: subscribe to the event bus and recover pending work.
   */
  async start({ recoverPending = true } = {}) {
    if (!this.eventBus) throw new Error('ChatGptDesktopWorker requires an EventBus');
    if (this.subscription) return this;

    this.subscription = this.eventBus.subscribe(this.agentId, (event) => {
      this._onEvent(event);
    });
    this.status = ChatGptWorkerStatus.IDLE;
    this.emit('started', { agentId: this.agentId });

    if (recoverPending) {
      // Fire-and-forget recovery so startup is not blocked, but surface errors.
      this.recoverPendingRequests().catch((err) => this.emit('error', err));
    }
    return this;
  }

  stop() {
    if (this.subscription) {
      try { this.subscription.unsubscribe(); } catch {}
      this.subscription = null;
    }
    this.status = ChatGptWorkerStatus.STOPPED;
    this.emit('stopped', { agentId: this.agentId });
  }

  _onEvent(event) {
    if (!event) return;
    if (event.type !== 'request_created' && event.type !== 'task_created') return;
    if (!event.requestId) return;
    if (event.status && ['completed', 'failed', 'cancelled'].includes(event.status)) return;
    // Never react to our own delivery events.
    if (event.fromAgent === this.agentId) return;

    this.handleRequest(event.requestId).catch((err) => this.emit('error', err));
  }

  /**
   * Deliver a single correlated request to the real ChatGPT Desktop app and
   * route the real response back. Idempotent and concurrency-guarded.
   */
  async handleRequest(requestId) {
    if (!requestId) return { handled: false, error: 'MISSING_REQUEST_ID' };
    if (this.inFlight.has(requestId)) {
      return { handled: false, requestId, duplicate: true, reason: 'IN_FLIGHT' };
    }
    if (this.delivered.has(requestId)) {
      this.stats.duplicatesSuppressed++;
      return { handled: false, requestId, duplicate: true, reason: 'ALREADY_DELIVERED' };
    }

    const request = this.mailbox?.getRequest ? this.mailbox.getRequest(requestId) : null;
    if (!request) {
      return { handled: false, requestId, error: 'REQUEST_NOT_FOUND' };
    }
    if (['completed', 'failed', 'cancelled'].includes(request.status)) {
      this.delivered.add(requestId);
      return { handled: false, requestId, error: 'REQUEST_ALREADY_TERMINAL', status: request.status };
    }
    if (request.toAgent && request.toAgent !== this.agentId) {
      return { handled: false, requestId, error: 'WRONG_AGENT', expected: this.agentId, actual: request.toAgent };
    }

    this.inFlight.add(requestId);
    this.status = ChatGptWorkerStatus.DELIVERING;
    this.stats.received++;
    const t0 = Date.now();
    this.emit('delivering', { requestId });

    try {
      this.status = ChatGptWorkerStatus.PROCESSING;
      const result = await this.session.send({
        text: request.question || '',
        requestId
      });

      if (result.success && result.response) {
        // Route the REAL model response back through the correlated channel.
        this._settle(request, { status: 'completed', result: result.response });
        this.delivered.add(requestId);
        this.stats.delivered++;
        const payload = { requestId, response: result.response, latencyMs: Date.now() - t0, status: result.status };
        this.emit('delivered', payload);
        return { handled: true, ...payload };
      }

      // Explicit, honest failure states. Never mark completed on delivery-only.
      const error = result.error || result.status || 'CHATGPT_RESPONSE_FAILED';
      this._settle(request, { status: 'failed', error });
      this.stats.failed++;
      this.emit('failed', { requestId, error, status: result.status });
      return { handled: true, requestId, success: false, error, status: result.status };
    } catch (err) {
      this.stats.failed++;
      try {
        this._settle(request, { status: 'failed', error: err.message });
      } catch {}
      this.emit('error', err);
      return { handled: true, requestId, success: false, error: err.message };
    } finally {
      this.inFlight.delete(requestId);
      this.status = ChatGptWorkerStatus.IDLE;
    }
  }

  /**
   * Settle a request through the task/request channel. Prefers the backing task
   * (which also resolves the correlated bridge_request); falls back to the
   * request channel directly for tasks created without a backing task row.
   */
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

  /**
   * Reconcile any pending requests left over from a previous worker lifetime.
   */
  async recoverPendingRequests() {
    if (!this.mailbox?.getPendingRequests) return [];
    const pending = this.mailbox.getPendingRequests(this.agentId, 50) || [];
    this.status = ChatGptWorkerStatus.RECOVERING;
    const results = [];
    for (const req of pending) {
      if (this.delivered.has(req.requestId)) continue;
      results.push(await this.handleRequest(req.requestId));
    }
    this.status = ChatGptWorkerStatus.IDLE;
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
