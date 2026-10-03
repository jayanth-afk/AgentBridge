import crypto from 'node:crypto';

/**
 * Request Lifecycle States
 * Fully represents the 12-state delivery semantics and failure classifications.
 */
export const RequestState = Object.freeze({
  // Core Lifecycle
  CREATED: 'CREATED',
  ROUTING: 'ROUTING',
  TRANSPORT_CONNECTED: 'TRANSPORT_CONNECTED',
  UI_TARGET_VERIFIED: 'UI_TARGET_VERIFIED',
  INPUT_ACCEPTED: 'INPUT_ACCEPTED',
  SENT: 'SENT',
  SUBMITTED: 'SUBMITTED',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  MODEL_TURN_CONFIRMED: 'MODEL_TURN_CONFIRMED',
  ASSISTANT_STARTED: 'ASSISTANT_STARTED',
  ASSISTANT_STREAMING: 'ASSISTANT_STREAMING',
  PROCESSING: 'PROCESSING',
  ASSISTANT_COMPLETED: 'ASSISTANT_COMPLETED',
  RESPONSE_CORRELATED: 'RESPONSE_CORRELATED',
  COMPLETED: 'COMPLETED',
  DELIVERED: 'DELIVERED',

  // Failure & Reconciliation States
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
  TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
  APP_OFFLINE: 'APP_OFFLINE',
  WINDOW_UNAVAILABLE: 'WINDOW_UNAVAILABLE',
  TRANSPORT_FAILED: 'TRANSPORT_FAILED',
  SUBMISSION_UNCERTAIN: 'SUBMISSION_UNCERTAIN',
  MODEL_TURN_NOT_CONFIRMED: 'MODEL_TURN_NOT_CONFIRMED',
  RESPONSE_TIMEOUT: 'RESPONSE_TIMEOUT',
  RESPONSE_AMBIGUOUS: 'RESPONSE_AMBIGUOUS'
});

/**
 * Request Priority Levels
 */
export const PriorityLevel = Object.freeze({
  URGENT: 'urgent',
  NORMAL: 'normal',
  BACKGROUND: 'background'
});

/**
 * A2A / ACP Compliant Request Envelope
 */
export class RequestEnvelope {
  constructor({
    requestId = null,
    conversationId = null,
    fromAgent,
    toAgent,
    taskId = null,
    capability = 'chat',
    message,
    context = {},
    deadline = null,
    replyTo = null,
    priority = PriorityLevel.NORMAL
  }) {
    if (!fromAgent) throw new Error('fromAgent is required');
    if (!toAgent) throw new Error('toAgent is required');
    if (message === undefined || message === null) throw new Error('message is required');

    this.requestId = requestId || `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.conversationId = conversationId || `conv_${Date.now()}`;
    this.fromAgent = fromAgent;
    this.toAgent = toAgent;
    this.taskId = taskId || null;
    this.capability = capability;
    this.message = typeof message === 'string' ? message : JSON.stringify(message);
    this.context = context;
    this.deadline = deadline ? new Date(deadline).toISOString() : null;
    this.replyTo = replyTo || fromAgent;
    this.priority = Object.values(PriorityLevel).includes(priority) ? priority : PriorityLevel.NORMAL;
    this.state = RequestState.CREATED;
    this.createdAt = new Date().toISOString();
    this.stateHistory = [{ state: RequestState.CREATED, timestamp: this.createdAt }];
  }

  transition(newState, details = null) {
    if (!Object.values(RequestState).includes(newState)) {
      throw new Error(`Invalid RequestState: ${newState}`);
    }
    this.state = newState;
    this.stateHistory.push({
      state: newState,
      timestamp: new Date().toISOString(),
      ...(details ? { details } : {})
    });
    return this;
  }

  isTerminal() {
    return [
      RequestState.COMPLETED,
      RequestState.DELIVERED,
      RequestState.FAILED,
      RequestState.UNKNOWN,
      RequestState.TARGET_AMBIGUOUS,
      RequestState.APP_OFFLINE,
      RequestState.WINDOW_UNAVAILABLE,
      RequestState.TRANSPORT_FAILED,
      RequestState.SUBMISSION_UNCERTAIN,
      RequestState.MODEL_TURN_NOT_CONFIRMED,
      RequestState.RESPONSE_TIMEOUT,
      RequestState.RESPONSE_AMBIGUOUS
    ].includes(this.state);
  }

  toJSON() {
    return {
      requestId: this.requestId,
      conversationId: this.conversationId,
      fromAgent: this.fromAgent,
      toAgent: this.toAgent,
      taskId: this.taskId,
      capability: this.capability,
      message: this.message,
      context: this.context,
      deadline: this.deadline,
      replyTo: this.replyTo,
      priority: this.priority,
      state: this.state,
      createdAt: this.createdAt,
      stateHistory: this.stateHistory
    };
  }

  static fromJSON(data) {
    if (typeof data === 'string') data = JSON.parse(data);
    const env = new RequestEnvelope(data);
    env.state = data.state || RequestState.CREATED;
    if (Array.isArray(data.stateHistory)) env.stateHistory = data.stateHistory;
    return env;
  }
}

/**
 * PriorityQueue with Fair Scheduling across priority tiers
 */
export class PriorityScheduler {
  constructor() {
    this.queues = {
      [PriorityLevel.URGENT]: [],
      [PriorityLevel.NORMAL]: [],
      [PriorityLevel.BACKGROUND]: []
    };
    // Weighted fair dispatch: 4 urgent, 2 normal, 1 background to avoid starvation
    this.dispatchWeights = {
      [PriorityLevel.URGENT]: 4,
      [PriorityLevel.NORMAL]: 2,
      [PriorityLevel.BACKGROUND]: 1
    };
    this.currentCounts = {
      [PriorityLevel.URGENT]: 0,
      [PriorityLevel.NORMAL]: 0,
      [PriorityLevel.BACKGROUND]: 0
    };
  }

  enqueue(envelope) {
    const p = envelope.priority || PriorityLevel.NORMAL;
    this.queues[p].push(envelope);
  }

  dequeue() {
    // Check urgent if within quota
    if (this.queues[PriorityLevel.URGENT].length > 0 &&
        this.currentCounts[PriorityLevel.URGENT] < this.dispatchWeights[PriorityLevel.URGENT]) {
      this.currentCounts[PriorityLevel.URGENT]++;
      return this.queues[PriorityLevel.URGENT].shift();
    }

    // Check normal if within quota
    if (this.queues[PriorityLevel.NORMAL].length > 0 &&
        this.currentCounts[PriorityLevel.NORMAL] < this.dispatchWeights[PriorityLevel.NORMAL]) {
      this.currentCounts[PriorityLevel.NORMAL]++;
      return this.queues[PriorityLevel.NORMAL].shift();
    }

    // Check background if within quota
    if (this.queues[PriorityLevel.BACKGROUND].length > 0 &&
        this.currentCounts[PriorityLevel.BACKGROUND] < this.dispatchWeights[PriorityLevel.BACKGROUND]) {
      this.currentCounts[PriorityLevel.BACKGROUND]++;
      return this.queues[PriorityLevel.BACKGROUND].shift();
    }

    // Reset quota cycle
    this.currentCounts = {
      [PriorityLevel.URGENT]: 0,
      [PriorityLevel.NORMAL]: 0,
      [PriorityLevel.BACKGROUND]: 0
    };

    // Fallback: return highest available non-empty queue
    for (const p of [PriorityLevel.URGENT, PriorityLevel.NORMAL, PriorityLevel.BACKGROUND]) {
      if (this.queues[p].length > 0) {
        return this.queues[p].shift();
      }
    }

    return null;
  }

  get size() {
    return this.queues[PriorityLevel.URGENT].length +
           this.queues[PriorityLevel.NORMAL].length +
           this.queues[PriorityLevel.BACKGROUND].length;
  }
}
