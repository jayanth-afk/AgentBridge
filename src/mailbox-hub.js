import crypto from 'node:crypto';
import { TaskManager } from './task-manager.js';
import { EventBus } from './event-bus.js';
import { RequestTracer, LifecycleStage } from './diagnostics/request-tracer.js';
import {
  isSensitiveCredentialRequest,
  isVerificationTokenRequest,
  getRegisteredVerificationToken,
  SECURITY_DENIAL_MESSAGE
} from './security/verification-tokens.js';
import { ResponsePreserver, detectResponseMode, ResponseMode } from './artifacts/response-preserver.js';
import { ArtifactStore } from './artifacts/artifact-store.js';
import { TokenAccountant } from './telemetry/token-accountant.js';
import { CONFIG } from './config.js';
import { normalizeAgentId } from './agent-identity.js';

export const TERMINAL_REQUEST_STATES = Object.freeze(new Set([
  'completed',
  'failed',
  'cancelled',
  'quarantined'
]));

export class MailboxHub {
  constructor(auditLogger, taskManager = null, eventBus = null) {
    this.logger = auditLogger;
    this.db = auditLogger?.db;
    this.eventBus = eventBus || new EventBus(auditLogger);
    this.tasks = taskManager || new TaskManager(auditLogger, null, this.eventBus);
    if (!this.tasks.eventBus && this.eventBus) {
      this.tasks.eventBus = this.eventBus;
      if (this.tasks.outbox) {
        this.tasks.outbox.eventBus = this.eventBus;
      }
    }
    this.agentHandlers = new Map(); // agentId -> async (question, context) => response

    // Durable response preservation and token accounting.
    // Response payloads are canonicalized into ArtifactStore (bridge_artifacts)
    // when a durable database + root are available; otherwise ResponsePreserver
    // falls back to inline text (in-memory/mock usage).
    this.artifactStore = (this.db && auditLogger?.dbPath)
      ? new ArtifactStore(auditLogger)
      : null;
    this.responsePreserver = new ResponsePreserver(this.db, { artifactStore: this.artifactStore });
    this.tokenAccountant = new TokenAccountant();

    // Structured, correlated request lifecycle tracing (observability only;
    // never influences delivery semantics).
    this.tracer = new RequestTracer(auditLogger);
    if (this.eventBus && !this.eventBus.tracer) {
      this.eventBus.tracer = this.tracer;
    }
  }

  registerAgentHandler(agentId, handler) {
    this.agentHandlers.set(agentId, handler);
  }

  pruneRequestLifecycle(options) {
    return this.tracer ? this.tracer.prune(options) : { pruned: 0, hasMore: false, cutoff: null };
  }

  getRequestLifecycleStats() {
    return this.tracer ? this.tracer.getStats() : { totalRecords: 0, oldest: null, newest: null };
  }

  sendMessage({
    fromAgent,
    toAgent,
    subject,
    content,
    replyToId = null,
    conversationId = null,
    requestId = null,
    emitEvent = true,
    dedupKey = null
  }) {
    const normFrom = normalizeAgentId(fromAgent) || fromAgent;
    const normTo = normalizeAgentId(toAgent) || toAgent;

    const id = `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = new Date().toISOString();
    const convId = conversationId || `conv_msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const eventDedupKey = dedupKey || `msg_event_${id}`;

    let resultMsg = null;

    const insertWork = (targetDb, stageEventFn = null) => {
      const stmt = targetDb.prepare(`
        INSERT INTO messages (id, timestamp, from_agent, to_agent, subject, content, reply_to_id, read_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `);
      stmt.run(id, timestamp, normFrom, normTo, subject, content, replyToId);

      this.logger?.log({
        agentId: normFrom,
        action: 'send_message',
        targetPath: null,
        command: null,
        status: 'success',
        details: { messageId: id, toAgent: normTo, subject, conversationId: convId, requestId }
      });

      if (emitEvent && stageEventFn) {
        stageEventFn({
          type: 'message_sent',
          agentId: normTo,
          fromAgent: normFrom,
          conversationId: convId,
          requestId,
          status: 'unread',
          payload: {
            messageId: id,
            subject: subject ? (subject.length > 80 ? subject.slice(0, 80) + '...' : subject) : ''
          },
          dedupKey: eventDedupKey
        });
      }

      resultMsg = { id, timestamp, fromAgent: normFrom, toAgent: normTo, subject, content, replyToId, conversationId: convId, requestId };
    };

    if (this.eventBus && typeof this.eventBus.runInTransaction === 'function') {
      this.eventBus.runInTransaction((tx) => {
        insertWork(tx.db, tx.stageEvent);
      });
    } else {
      insertWork(this.db, null);
      if (emitEvent && this.eventBus) {
        this.eventBus.publish({
          type: 'message_sent',
          agentId: toAgent,
          fromAgent,
          conversationId: convId,
          requestId,
          status: 'unread',
          payload: {
            messageId: id,
            subject: subject ? (subject.length > 80 ? subject.slice(0, 80) + '...' : subject) : ''
          },
          dedupKey: eventDedupKey
        });
      }
    }

    return resultMsg;
  }

  async broadcastMessage({ fromAgent, toAgents, subject, content, replyToId = null }) {
    const recipients = [...new Set(Array.isArray(toAgents) ? toAgents : [])];
    const settled = await Promise.allSettled(
      recipients.map(async (toAgent) => this.sendMessage({ fromAgent, toAgent, subject, content, replyToId }))
    );
    const delivered = [];
    const failed = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') delivered.push(r.value);
      else failed.push({ toAgent: recipients[i], error: r.reason?.message || String(r.reason) });
    });
    return { delivered, failed };
  }

  getInbox({ agentId, unreadOnly = false, compact = false, limit = 50 }) {
    const normAgent = normalizeAgentId(agentId) || agentId;
    let query = `SELECT * FROM messages WHERE to_agent = ?`;
    if (unreadOnly) {
      query += ` AND read_at IS NULL`;
    }
    query += ` ORDER BY timestamp DESC LIMIT ?`;

    const stmt = this.db.prepare(query);
    const messages = stmt.all(normAgent, limit);

    this.logger.log({
      agentId: normAgent,
      action: 'check_inbox',
      targetPath: null,
      command: null,
      status: 'success',
      details: { count: messages.length, unreadOnly }
    });

    if (compact) {
      return messages.map(m => ({
        id: m.id,
        timestamp: m.timestamp,
        from_agent: m.from_agent,
        subject: m.subject,
        read_at: m.read_at,
        snippet: m.content ? (m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content) : ''
      }));
    }

    return messages;
  }

  markMessageRead({ messageId, agentId }) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE messages SET read_at = ? WHERE id = ? AND to_agent = ?
    `);
    const info = stmt.run(now, messageId, agentId);
    return { success: info.changes > 0, readAt: now };
  }

  delegateTask({
    fromAgent,
    toAgent,
    title,
    instructions,
    context = null,
    parentTaskId = null,
    priority = 'normal',
    dependencies = [],
    conversationId = null,
    requestId = null,
    notifyInbox = true,
    emitEvent = true,
    dedupKey = null
  }) {
    if (!toAgent) {
      const err = new Error('VALIDATION_ERROR: Target agent must be specified');
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    const normFrom = normalizeAgentId(fromAgent) || fromAgent || null;
    const normTo = normalizeAgentId(toAgent) || toAgent || null;

    const effectiveDedupKey = dedupKey || (
      typeof context === 'object' && context !== null ? context.dedupKey : null
    ) || null;

    const resolvedReqId = requestId || `req_task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const convId = conversationId || (resolvedReqId ? `conv_${resolvedReqId}` : null);

    const runWork = () => {
      const task = this.tasks.createTask({
        fromAgent: normFrom,
        toAgent: normTo,
        title,
        instructions,
        context,
        parentTaskId,
        priority,
        dependencies,
        conversationId: convId,
        requestId: resolvedReqId,
        emitEvent,
        dedupKey: effectiveDedupKey
      });

      // Check if task already existed (deduplicated)
      let alreadyExisted = false;
      if (this.db) {
        try {
          const reqRow = this.db.prepare('SELECT request_id FROM bridge_requests WHERE task_id = ?').get(task.id);
          if (reqRow) {
            alreadyExisted = true;
          }
        } catch {}
      }

      // Establish uniform request-task correlation in bridge_requests so desktop and autonomous workers can uniformly claim and track all tasks
      if (this.db && !alreadyExisted) {
        try {
          const existing = this.db.prepare('SELECT request_id FROM bridge_requests WHERE request_id = ?').get(resolvedReqId);
          if (!existing) {
            const now = new Date().toISOString();
            const ctxStr = typeof context === 'object' && context !== null ? JSON.stringify(context) : context;
            this.db.prepare(`
              INSERT INTO bridge_requests (
                request_id, conversation_id, from_agent, to_agent, question, context,
                task_id, status, response, error, timeout_ms, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, 60000, ?, ?)
            `).run(resolvedReqId, convId, normFrom, normTo, instructions || title, ctxStr, task.id, now, now);
          }
        } catch (reqInsErr) {
          this.logger?.debug?.('Failed to create matching bridge_request in delegateTask', reqInsErr);
        }
      }

      const actualConvId = convId || `conv_task_${task.id}`;

      // Send an inbox message for durable mail fallback only if requested and task is freshly created
      if (notifyInbox && !alreadyExisted) {
        this.sendMessage({
          fromAgent: normFrom,
          toAgent: normTo,
          subject: `[Task Delegation] ${title}`,
          content: `New task assigned (${task.id}): ${instructions}`,
          replyToId: null,
          conversationId: actualConvId,
          requestId,
          emitEvent: true
        });
      }

      return task;
    };

    if (this.eventBus && typeof this.eventBus.runInTransaction === 'function') {
      return this.eventBus.runInTransaction(() => runWork());
    }
    return runWork();
  }

  /**
   * Active Request/Response Channel with cross-process waiter:
   * Keeps caller attached to correlated response channel without manual polling.
   */
  async askAgent({
    fromAgent,
    toAgent,
    question,
    context = null,
    conversationId = null,
    requestId = null,
    // Desktop model turns can legitimately take longer than 30s. Keep the waiter
    // attached long enough to capture the real correlated response while still
    // allowing callers to override the timeout explicitly.
    timeoutMs = 90000,
    asyncMode = false,
    responseMode = null
  }) {
    const normFrom = normalizeAgentId(fromAgent) || fromAgent;
    const normTo = normalizeAgentId(toAgent) || toAgent;

    if (fromAgent && normFrom !== fromAgent) {
      this.logger?.log?.({
        agentId: normFrom,
        action: 'agent_alias_normalized',
        status: 'info',
        details: { raw: fromAgent, normalized: normFrom, context: 'askAgent.fromAgent' }
      });
    }
    if (toAgent && normTo !== toAgent) {
      this.logger?.log?.({
        agentId: normTo,
        action: 'agent_alias_normalized',
        status: 'info',
        details: { raw: toAgent, normalized: normTo, context: 'askAgent.toAgent' }
      });
    }

    if (!toAgent) {
      return {
        mode: 'request_failed',
        fromAgent: normFrom,
        toAgent: null,
        requestId: requestId || `req_missing_target_${Date.now()}`,
        conversationId,
        taskId: null,
        question,
        status: 'failed',
        error: 'EXECUTION_UNSUPPORTED: Target agent must be specified'
      };
    }

    const timestamp = new Date().toISOString();
    const resolvedMode = detectResponseMode({ question, explicitMode: responseMode });

    // 1. If target agent has a registered local handler (e.g. test peer or in-memory mock), call synchronously
    const handler = this.agentHandlers.get(normTo) || this.agentHandlers.get(toAgent);
    if (handler) {
      const syncRespondingId = this.agentHandlers.has(toAgent) ? toAgent : normTo;
      const syncRequestingId = normFrom;

      const sensitive = isSensitiveCredentialRequest(question);
      if (sensitive.sensitive) {
        return {
          mode: 'request_failed',
          fromAgent: syncRequestingId,
          toAgent: syncRespondingId,
          requestId: requestId || `req_denied_${Date.now()}`,
          conversationId,
          taskId: null,
          question,
          status: 'failed',
          error: sensitive.reason || SECURITY_DENIAL_MESSAGE
        };
      }

      let response;
      if (isVerificationTokenRequest(question)) {
        response = getRegisteredVerificationToken(syncRespondingId) || getRegisteredVerificationToken(toAgent);
      } else {
        response = await handler(question, context);
      }

      this.sendMessage({
        fromAgent: syncRequestingId,
        toAgent: syncRespondingId,
        subject: `[Direct Query] ${question.slice(0, 40)}...`,
        content: question
      });
      this.sendMessage({
        fromAgent: syncRespondingId,
        toAgent: syncRequestingId,
        subject: `[Direct Response] Re: ${question.slice(0, 40)}...`,
        content: typeof response === 'string' ? response : JSON.stringify(response)
      });

      const respText = typeof response === 'string' ? response : JSON.stringify(response);
      const reqIdSync = requestId || `req_sync_${Date.now()}`;
      const nowSync = new Date().toISOString();
      if (this.db) {
        try {
          this.db.prepare(`
            INSERT OR REPLACE INTO bridge_requests (
              request_id, conversation_id, from_agent, to_agent, question, context,
              task_id, status, response, error, timeout_ms, created_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'completed', ?, NULL, ?, ?, ?, ?)
          `).run(
            reqIdSync,
            conversationId || `conv_sync_${Date.now()}`,
            syncRequestingId,
            syncRespondingId,
            question,
            typeof context === 'object' && context !== null ? JSON.stringify(context) : context,
            respText,
            timeoutMs,
            nowSync,
            nowSync,
            nowSync
          );
        } catch (reqSyncErr) {
          this.logger?.debug?.('Failed to insert bridge_request in askAgent', reqSyncErr);
        }
      }

      let artifact = null;
      let envelope = null;
      let tokenMetrics = null;
      try {
        artifact = this.responsePreserver.preserveResponse({
          requestId: reqIdSync,
          respondingAgentId: syncRespondingId,
          requestingAgentId: syncRequestingId,
          responseText: respText,
          responseMode: resolvedMode,
          executionMetadata: {
            correlationTier: 'direct_session',
            attemptEpoch: 1,
            originRoute: 'sync_peer'
          }
        });
        envelope = this.responsePreserver.createCompactEnvelope(artifact);
        tokenMetrics = this.tokenAccountant.recordTurn({
          requestId: reqIdSync,
          responseMode: resolvedMode,
          requestingAgent: syncRequestingId,
          respondingAgent: syncRespondingId,
          promptText: question,
          responseText: respText
        });
      } catch (err) {
        this.logger?.debug?.('Failed to preserve synchronous peer response', err);
      }

      const isQuarantined = Boolean(artifact?.quarantined);

      return {
        mode: 'synchronous_peer_response',
        fromAgent: syncRequestingId,
        toAgent: syncRespondingId,
        requestId: reqIdSync,
        conversationId: conversationId || `conv_sync_${Date.now()}`,
        question,
        response: isQuarantined ? null : response,
        status: isQuarantined ? 'quarantined' : 'completed',
        error: isQuarantined ? artifact.quarantineReason : null,
        responseMode: resolvedMode,
        responseId: artifact?.responseId || null,
        envelope,
        tokenMetrics,
        bridgeUnaltered: !isQuarantined && (resolvedMode === ResponseMode.DIRECT),
        untrustedData: true,
        quarantined: isQuarantined,
        additionalModelCalls: 0,
        modelRegenerationTokens: 0,
        timestamp
      };
    }

    // 2. Correlated Request Generation (clean REQUEST semantics: 1 request row, 1 task row, 1 event)
    const reqId = requestId || `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const convId = conversationId || `conv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();

    // Idempotent reconnect check: if this request already exists in bridge_requests,
    // attach to existing request rather than inserting a duplicate and failing.
    let existingReq = null;
    if (requestId) {
      try {
        existingReq = this.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(requestId);
      } catch {}
    }

    if (existingReq) {
      const normCaller = fromAgent ? (normalizeAgentId(fromAgent) || String(fromAgent).trim().toLowerCase()) : null;
      const normOwner = existingReq.from_agent ? (normalizeAgentId(existingReq.from_agent) || String(existingReq.from_agent).trim().toLowerCase()) : null;
      if (normCaller !== normOwner) {
        throw new Error(`Security Violation: Agent '${fromAgent}' cannot reattach to requestId '${existingReq.request_id}' owned by '${existingReq.from_agent}'.`);
      }

      if (existingReq.status === 'completed') {
        this.tracer?.mark({
          requestId: existingReq.request_id,
          stage: LifecycleStage.RESPONSE_RETURNED,
          taskId: existingReq.task_id,
          agentId: fromAgent,
          meta: { outcome: 'completed', reconnected: true }
        });
        const artifact = this.responsePreserver.getByRequestId(existingReq.request_id);
        const envelope = artifact ? this.responsePreserver.createCompactEnvelope(artifact) : null;
        const tokenMetrics = this.tokenAccountant.getMetrics(existingReq.request_id);
        const reqMode = artifact?.responseMode || resolvedMode;
        const isQuarantined = Boolean(artifact?.quarantined);

        return {
          mode: 'autonomous_correlated_response',
          fromAgent: existingReq.from_agent,
          toAgent: existingReq.to_agent,
          requestId: existingReq.request_id,
          conversationId: existingReq.conversation_id,
          taskId: existingReq.task_id,
          question: existingReq.question,
          response: isQuarantined ? null : existingReq.response,
          status: isQuarantined ? 'quarantined' : 'completed',
          error: isQuarantined ? artifact.quarantineReason : null,
          responseMode: reqMode,
          responseId: artifact?.responseId || null,
          envelope,
          tokenMetrics,
          bridgeUnaltered: !isQuarantined && (reqMode === ResponseMode.DIRECT),
          untrustedData: true,
          quarantined: isQuarantined,
          additionalModelCalls: 0,
          modelRegenerationTokens: 0,
          timestamp: existingReq.completed_at || existingReq.updated_at
        };
      }
      if (existingReq.status === 'failed') {
        return {
          mode: 'request_failed',
          fromAgent: existingReq.from_agent,
          toAgent: existingReq.to_agent,
          requestId: existingReq.request_id,
          conversationId: existingReq.conversation_id,
          taskId: existingReq.task_id,
          question: existingReq.question,
          status: 'failed',
          error: existingReq.error || 'Request failed'
        };
      }
      if (existingReq.status === 'quarantined') {
        const artifact = this.responsePreserver.getByRequestId(existingReq.request_id);
        return {
          mode: 'request_quarantined',
          fromAgent: existingReq.from_agent,
          toAgent: existingReq.to_agent,
          requestId: existingReq.request_id,
          conversationId: existingReq.conversation_id,
          taskId: existingReq.task_id,
          question: existingReq.question,
          status: 'quarantined',
          response: null,
          error: artifact?.quarantineReason || existingReq.error || 'Response quarantined',
          quarantined: true,
          untrustedData: true
        };
      }
      if (existingReq.status === 'cancelled') {
        return {
          mode: 'request_cancelled',
          fromAgent: existingReq.from_agent,
          toAgent: existingReq.to_agent,
          requestId: existingReq.request_id,
          conversationId: existingReq.conversation_id,
          taskId: existingReq.task_id,
          question: existingReq.question,
          status: 'cancelled',
          response: null,
          error: existingReq.error || 'Request cancelled'
        };
      }
      if (asyncMode) {
        return {
          mode: 'queued_in_mailbox',
          fromAgent: existingReq.from_agent,
          toAgent: existingReq.to_agent,
          requestId: existingReq.request_id,
          conversationId: existingReq.conversation_id,
          taskId: existingReq.task_id,
          status: existingReq.status,
          note: `Re-attached to existing request (${existingReq.status}) in ${existingReq.to_agent}'s mailbox.`
        };
      }
      // Re-attach sync waiter to existing in-flight request
      const outcome = await this.eventBus.waitForResponse({
        requestId: existingReq.request_id,
        agentId: fromAgent,
        taskId: existingReq.task_id,
        timeoutMs
      });
      this.tracer?.mark({
        requestId: existingReq.request_id,
        stage: LifecycleStage.RESPONSE_RETURNED,
        taskId: existingReq.task_id,
        agentId: fromAgent,
        meta: { outcome: outcome.status, reconnected: true }
      });
      if (outcome.status === 'completed') {
        let finalResponse = outcome.response;
        if (finalResponse === undefined || finalResponse === null) {
          const row = this.db.prepare('SELECT response FROM bridge_requests WHERE request_id = ?').get(existingReq.request_id);
          finalResponse = row?.response;
        }

        const artifact = this.responsePreserver.getByRequestId(existingReq.request_id);
        const envelope = artifact ? this.responsePreserver.createCompactEnvelope(artifact) : null;
        const tokenMetrics = this.tokenAccountant.getMetrics(existingReq.request_id);
        const reqMode = artifact?.responseMode || resolvedMode;
        const isQuarantined = Boolean(artifact?.quarantined);

        return {
          mode: 'autonomous_correlated_response',
          fromAgent: existingReq.from_agent,
          toAgent: existingReq.to_agent,
          requestId: existingReq.request_id,
          conversationId: existingReq.conversation_id,
          taskId: existingReq.task_id,
          question: existingReq.question,
          response: isQuarantined ? null : finalResponse,
          status: isQuarantined ? 'quarantined' : 'completed',
          error: isQuarantined ? artifact.quarantineReason : null,
          responseMode: reqMode,
          responseId: artifact?.responseId || null,
          envelope,
          tokenMetrics,
          bridgeUnaltered: !isQuarantined && (reqMode === ResponseMode.DIRECT),
          untrustedData: true,
          quarantined: isQuarantined,
          additionalModelCalls: 0,
          modelRegenerationTokens: 0,
          timestamp: outcome.completedAt || new Date().toISOString()
        };
      } else if (outcome.status === 'timeout') {
        return {
          mode: 'request_timeout',
          fromAgent: existingReq.from_agent,
          toAgent: existingReq.to_agent,
          requestId: existingReq.request_id,
          conversationId: existingReq.conversation_id,
          taskId: existingReq.task_id,
          question: existingReq.question,
          status: 'timeout',
          error: outcome.error || `Timed out after ${timeoutMs}ms waiting for response from ${existingReq.to_agent}`,
          recoverable: true
        };
      } else {
        return {
          mode: 'request_failed',
          fromAgent: existingReq.from_agent,
          toAgent: existingReq.to_agent,
          requestId: existingReq.request_id,
          conversationId: existingReq.conversation_id,
          taskId: existingReq.task_id,
          question: existingReq.question,
          status: 'failed',
          error: outcome.error || 'Request failed'
        };
      }
    }

    // Store request in bridge_requests table for full durability
    const ctxString = typeof context === 'object' && context !== null ? JSON.stringify(context) : context;
    const taskContext = {
      requestId: reqId,
      conversationId: convId,
      originalContext: context,
      question,
      responseMode: resolvedMode
    };

    let task = null;

    const stageRequestWork = (targetDb, stageEventFn = null) => {
      targetDb.prepare(`
        INSERT INTO bridge_requests (
          request_id, conversation_id, from_agent, to_agent, question, context,
          task_id, status, response, error, timeout_ms, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, ?, ?, ?)
      `).run(reqId, convId, normFrom, normTo, question, ctxString, timeoutMs, now, now);

      task = this.delegateTask({
        fromAgent: normFrom,
        toAgent: normTo,
        title: `Query from ${normFrom}`,
        instructions: question,
        context: taskContext,
        priority: 'high',
        conversationId: convId,
        requestId: reqId,
        notifyInbox: false,
        emitEvent: false
      });

      targetDb.prepare(`
        UPDATE bridge_requests SET task_id = ? WHERE request_id = ?
      `).run(task.id, reqId);

      if (stageEventFn) {
        stageEventFn({
          type: 'request_created',
          agentId: normTo,
          fromAgent: normFrom,
          conversationId: convId,
          requestId: reqId,
          taskId: task.id,
          status: 'pending',
          payload: {
            question: question ? (question.length > 100 ? question.slice(0, 100) + '...' : question) : ''
          },
          dedupKey: `req_created_${reqId}`
        });
      }
    };

    if (this.eventBus && typeof this.eventBus.runInTransaction === 'function') {
      this.eventBus.runInTransaction((tx) => {
        stageRequestWork(tx.db, tx.stageEvent);
      });
    } else {
      stageRequestWork(this.db, null);
      if (this.eventBus) {
        this.eventBus.publish({
          type: 'request_created',
          agentId: normTo,
          fromAgent: normFrom,
          conversationId: convId,
          requestId: reqId,
          taskId: task.id,
          status: 'pending',
          payload: {
            question: question ? (question.length > 100 ? question.slice(0, 100) + '...' : question) : ''
          },
          dedupKey: `req_created_${reqId}`
        });
      }
    }

    // Lifecycle: request + backing task durably created (post-commit).
    this.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.REQUEST_CREATED,
      taskId: task ? task.id : null,
      agentId: normTo,
      meta: { fromAgent: normFrom, conversationId: convId, asyncMode }
    });
    if (task) {
      this.tracer.mark({
        requestId: reqId,
        stage: LifecycleStage.TASK_CREATED,
        taskId: task.id,
        agentId: normTo
      });
    }

    // If explicit asynchronous mode requested, return immediately with correlation IDs
    if (asyncMode) {
      return {
        mode: 'queued_in_mailbox',
        fromAgent: normFrom,
        toAgent: normTo,
        requestId: reqId,
        conversationId: convId,
        taskId: task.id,
        status: 'pending',
        note: `Query queued in ${normTo}'s mailbox for processing.`
      };
    }

    // Default: Synchronous / Correlated Waiter loop
    // Originating agent stays attached to correlated response channel waiting for B's answer
    const outcome = await this.eventBus.waitForResponse({
      requestId: reqId,
      agentId: normFrom,
      taskId: task ? task.id : null,
      timeoutMs
    });

    // Lifecycle: the correlated response (or a truthful timeout) reached the caller.
    this.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.RESPONSE_RETURNED,
      taskId: task ? task.id : null,
      agentId: normFrom,
      meta: { outcome: outcome.status }
    });

    if (outcome.status === 'completed') {
      let finalResponse = outcome.response;
      if (finalResponse === undefined || finalResponse === null) {
        const row = this.db.prepare('SELECT response FROM bridge_requests WHERE request_id = ?').get(reqId);
        finalResponse = row?.response;
      }

      const artifact = this.responsePreserver.getByRequestId(reqId);
      const envelope = artifact ? this.responsePreserver.createCompactEnvelope(artifact) : null;
      const tokenMetrics = this.tokenAccountant.getMetrics(reqId);
      const isQuarantined = Boolean(artifact?.quarantined);

      return {
        mode: 'autonomous_correlated_response',
        fromAgent: normFrom,
        toAgent: normTo,
        requestId: reqId,
        conversationId: convId,
        taskId: task.id,
        question,
        response: isQuarantined ? null : finalResponse,
        status: isQuarantined ? 'quarantined' : 'completed',
        error: isQuarantined ? artifact.quarantineReason : null,
        responseMode: resolvedMode,
        responseId: artifact?.responseId || null,
        envelope,
        tokenMetrics,
        bridgeUnaltered: !isQuarantined && (resolvedMode === ResponseMode.DIRECT),
        untrustedData: true,
        quarantined: isQuarantined,
        additionalModelCalls: 0,
        modelRegenerationTokens: 0,
        timestamp: outcome.completedAt || new Date().toISOString()
      };
    } else if (outcome.status === 'timeout') {
      // A caller's wait deadline is not the task's execution deadline.  In
      // particular, native desktop turns may keep generating after this
      // waiter returns.  Do not overwrite the durable request state here:
      // doing so made a still-deliverable request look terminal to readers
      // and obscured its eventual correlated result.

      return {
        mode: 'request_timeout',
        fromAgent: normFrom,
        toAgent: normTo,
        requestId: reqId,
        conversationId: convId,
        taskId: task.id,
        question,
        status: 'timeout',
        error: outcome.error || `Timed out after ${timeoutMs}ms waiting for response from ${normTo}`,
        recoverable: true
      };
    } else {
      return {
        mode: 'request_failed',
        fromAgent: normFrom,
        toAgent: normTo,
        requestId: reqId,
        conversationId: convId,
        taskId: task.id,
        question,
        status: 'failed',
        error: outcome.error || `Request failed`
      };
    }
  }

  requestReview({ fromAgent, toAgent, filePath, description }) {
    return this.delegateTask({
      fromAgent,
      toAgent,
      title: `Code Review: ${filePath}`,
      instructions: `Please review changes to ${filePath}. Details: ${description}`,
      context: JSON.stringify({ filePath, description, reviewType: 'code_review' })
    });
  }

  updateTaskStatus({ taskId, agentId, status, result = null, error = null }) {
    return this.tasks.updateTaskStatus({
      taskId,
      agentId,
      status,
      result,
      error
    });
  }

  /**
   * Submits completion or failure outcome for an assigned task.
   * Atomically updates task, resolves any correlated bridge_requests,
   * emits live response event on event bus, and delivers durable mailbox message.
   */
  submitTaskResult({ taskId, agentId, status = 'completed', result = null, error = null, attemptId = null, epoch = null }) {
    let updated = null;
    let lifecycle = null;

    const submitWork = (targetDb, stageEventFn = null) => {
      updated = this.tasks.updateTaskStatus({
        taskId,
        agentId,
        status,
        result,
        error,
        attemptId,
        epoch
      });

      const task = this.tasks.getTask(taskId, false);

      // Check if task is linked to a correlated bridge_request
      let reqRow = null;
      try {
        reqRow = targetDb.prepare('SELECT * FROM bridge_requests WHERE task_id = ? OR request_id = ?').get(taskId, taskId);
      } catch {}

      let requestId = reqRow?.request_id;
      let conversationId = reqRow?.conversation_id;

      if (!requestId && task?.context) {
        try {
          const ctxObj = typeof task.context === 'string' ? JSON.parse(task.context) : task.context;
          requestId = ctxObj?.requestId;
          conversationId = ctxObj?.conversationId;
        } catch {}
      }

      const now = new Date().toISOString();
      const resultStr = typeof result === 'string' ? result : (result ? JSON.stringify(result) : null);

      if (requestId) {
        if (reqRow && TERMINAL_REQUEST_STATES.has(reqRow.status)) {
          // Terminal state protection: terminal requests are immutable
          const isIdempotentCompletion = reqRow.status === 'completed' && status === 'completed' && (reqRow.response === resultStr || resultStr === null);
          if (!isIdempotentCompletion) {
            // Conflicting result or late submission on terminal request: quarantine payload
            if (this.tasks?.attempts && (result || error || attemptId)) {
              try {
                this.tasks.attempts.quarantineLateResponse({
                  attemptId: attemptId || `late_on_${taskId}`,
                  requestId,
                  epoch: epoch || 0,
                  payload: result || error,
                  reason: `Late ${status} submitted after request was already terminal '${reqRow.status}'`
                });
              } catch (qErr) {
                this.logger?.debug?.('Failed to quarantine late response in submitTaskResult', qErr);
              }
            }
            this.logger?.log({
              agentId,
              action: 'terminal_request_mutation_blocked',
              status: 'quarantined',
              details: { requestId, taskId, terminalStatus: reqRow.status, submittedStatus: status }
            });
          }
        } else {
          try {
            targetDb.prepare(`
              UPDATE bridge_requests
              SET status = ?, response = ?, error = ?, updated_at = ?, completed_at = ?
              WHERE request_id = ?
            `).run(status, resultStr, error, now, now, requestId);
          } catch (updErr) {
            this.logger?.debug?.('Failed to update bridge_requests in submitTaskResult', updErr);
          }
        }
      }

      if (status === 'completed' && resultStr && (!reqRow || !TERMINAL_REQUEST_STATES.has(reqRow.status) || reqRow.response === resultStr)) {
        try {
          const recipientAgent = task ? task.creator : (reqRow ? reqRow.from_agent : '*');
          const reqMode = reqRow?.context ? (() => {
            try {
              const parsed = JSON.parse(reqRow.context);
              return parsed?.responseMode || 'direct';
            } catch { return 'direct'; }
          })() : 'direct';

          const artifact = this.responsePreserver.preserveResponse({
            requestId: requestId || `req_task_${taskId}`,
            taskId,
            respondingAgentId: agentId,
            requestingAgentId: recipientAgent,
            responseText: resultStr,
            responseMode: reqMode,
            executionMetadata: {
              attemptEpoch: epoch || 1,
              correlationTier: attemptId ? 'crypto_nonce' : 'direct_session',
              originRoute: 'task_mailbox'
            }
          });

          this.tokenAccountant.recordTurn({
            requestId: requestId || `req_task_${taskId}`,
            taskId,
            responseMode: reqMode,
            requestingAgent: recipientAgent,
            respondingAgent: agentId,
            promptText: task?.instructions || reqRow?.question || '',
            responseText: resultStr
          });
        } catch (err) {
          this.logger?.debug?.('Failed to preserve response artifact in submitTaskResult', err);
        }
      }

      // Record persistence inside the same transaction as the authoritative
      // terminal row. The trace record becomes visible only when this transaction
      // commits, and is inserted before outbox events are dispatched; this keeps
      // RESULT_PERSISTED ordered before WAITER_RESOLVED in same-process traces.
      lifecycle = { requestId, taskId, agentId, status };
      if (requestId) {
        this.tracer.mark({
          requestId,
          stage: LifecycleStage.RESULT_PERSISTED,
          taskId,
          attemptId,
          agentId,
          meta: { status }
        });
      }

      const recipient = task ? task.creator : (reqRow ? reqRow.from_agent : '*');
      const snippet = resultStr ? (resultStr.length > 100 ? resultStr.slice(0, 100) + '...' : resultStr) : null;

      if (stageEventFn) {
        if (requestId) {
          stageEventFn({
            type: 'response_delivered',
            agentId: recipient,
            fromAgent: agentId,
            conversationId: conversationId || `conv_task_${taskId}`,
            requestId,
            taskId,
            status,
            payload: {
              snippet,
              status,
              error: error ? (error.length > 80 ? error.slice(0, 80) + '...' : error) : null
            },
            dedupKey: `resp_delivered_${requestId}_${status}`
          });
        } else {
          stageEventFn({
            type: status === 'completed' ? 'task_completed' : 'task_failed',
            agentId: recipient,
            fromAgent: agentId,
            conversationId: conversationId || `conv_task_${taskId}`,
            requestId: null,
            taskId,
            status,
            payload: {
              snippet,
              status,
              error: error ? (error.length > 80 ? error.slice(0, 80) + '...' : error) : null
            },
            dedupKey: `task_${status}_${taskId}`
          });
        }
      }

      // Durable mailbox notification fallback for standalone tasks (not active correlated requests)
      const isStandaloneTask = !requestId || requestId.startsWith('req_task_');
      if (isStandaloneTask && task && task.creator && task.creator !== agentId) {
        this.sendMessage({
          fromAgent: agentId,
          toAgent: task.creator,
          subject: `[Task Result] Re: ${task.title}`,
          content: JSON.stringify({
            taskId,
            status,
            result: task.result,
            error: task.error,
            requestId,
            conversationId
          }),
          conversationId,
          requestId
        });
      }
    };

    if (this.eventBus && typeof this.eventBus.runInTransaction === 'function') {
      this.eventBus.runInTransaction((tx) => {
        submitWork(tx.db, tx.stageEvent);
      });
    } else {
      submitWork(this.db, null);
    }

    // Lifecycle: completion event publication occurs only after the transaction
    // commits and the outbox flushes. RESULT_PERSISTED was recorded atomically
    // with the terminal row above, before any waiter can be woken.
    if (lifecycle && lifecycle.requestId) {
      this.tracer.mark({
        requestId: lifecycle.requestId,
        stage: LifecycleStage.COMPLETION_EVENT_COMMITTED,
        taskId: lifecycle.taskId,
        attemptId,
        agentId: lifecycle.agentId,
        meta: { status: lifecycle.status }
      });
    }

    return updated;
  }

  claimNextTask(agentId) {
    const norm = normalizeAgentId(agentId) || agentId;
    return this.tasks.claimNextTask(norm);
  }

  failTask({ taskId, agentId, error, allowRetry = true, attemptId = null, epoch = null }) {
    const res = this.tasks.failTask({ taskId, agentId, error, allowRetry, attemptId, epoch });
    if (res.status === 'failed') {
      this.submitTaskResult({ taskId, agentId, status: 'failed', error });
    }
    return res;
  }

  cancelTask({ taskId, agentId, reason }) {
    const res = this.tasks.cancelTask({ taskId, agentId, reason });
    this.submitTaskResult({ taskId, agentId, status: 'cancelled', error: reason });
    return res;
  }

  _isAuthorizedParty(fromAgent, toAgent, caller) {
    if (!caller) return true; // Direct internal / unauthenticated library call
    if (typeof caller === 'object' && (caller.isPrivileged === true || caller.isInternal === true)) {
      return true;
    }
    const callerId = typeof caller === 'string' ? caller : caller.agentId;
    if (!callerId) return true;
    const normCaller = normalizeAgentId(callerId) || String(callerId).trim().toLowerCase();
    const normFrom = fromAgent ? (normalizeAgentId(fromAgent) || String(fromAgent).trim().toLowerCase()) : null;
    const normTo = toAgent ? (normalizeAgentId(toAgent) || String(toAgent).trim().toLowerCase()) : null;
    return normCaller === normFrom || normCaller === normTo;
  }

  getTask(taskId, compact = true, caller = null) {
    return this.tasks.getTask(taskId, compact, caller);
  }

  listTasks({ agentId = null, status = null, limit = 20, compact = true } = {}) {
    return this.tasks.listTasks({ agentId, status, limit, compact });
  }

  getRequest(requestId, caller = null) {
    if (!requestId || typeof requestId !== 'string') {
      throw new Error('requestId is required and must be a non-empty string.');
    }
    const row = this.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(requestId);
    if (!row) return null;

    if (caller && !this._isAuthorizedParty(row.from_agent, row.to_agent, caller)) {
      const callerId = typeof caller === 'string' ? caller : caller.agentId;
      throw new Error(`Unauthorized: Agent '${callerId}' is not authorized to access request '${requestId}'.`);
    }

    const art = this.responsePreserver?.getByRequestId(requestId) || null;
    const isQuarantined = Boolean(art?.quarantined);
    const respMode = art?.responseMode || 'direct';

    return {
      requestId: row.request_id,
      conversationId: row.conversation_id,
      fromAgent: row.from_agent,
      toAgent: row.to_agent,
      question: row.question,
      context: row.context ? (() => { try { return JSON.parse(row.context); } catch { return row.context; } })() : null,
      taskId: row.task_id,
      status: isQuarantined ? 'quarantined' : row.status,
      response: isQuarantined ? null : row.response,
      error: isQuarantined ? art.quarantineReason : row.error,
      timeoutMs: row.timeout_ms,
      responseMode: respMode,
      responseId: art?.responseId || null,
      artifact: art,
      envelope: art ? this.responsePreserver.createCompactEnvelope(art) : null,
      tokenMetrics: this.tokenAccountant?.getMetrics(requestId) || null,
      bridgeUnaltered: !isQuarantined && (respMode === 'direct'),
      untrustedData: true,
      quarantined: isQuarantined,
      quarantineReason: art?.quarantineReason || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at
    };
  }

  getResponse(responseId, caller = null) {
    if (!responseId) throw new Error('responseId is required');
    const art = this.responsePreserver ? this.responsePreserver.getByResponseId(responseId) : null;
    if (!art) return null;

    if (caller && !this._isAuthorizedParty(art.requestingAgentId, art.respondingAgentId, caller)) {
      const callerId = typeof caller === 'string' ? caller : caller.agentId;
      throw new Error(`Unauthorized: Agent '${callerId}' is not authorized to access response '${responseId}'.`);
    }
    if (art.quarantined) {
      return {
        ...art,
        responseText: null,
        response: null,
        status: 'quarantined',
        error: art.quarantineReason,
        bridgeUnaltered: false,
        untrustedData: true
      };
    }
    return {
      ...art,
      response: art.responseText,
      bridgeUnaltered: art.responseMode === 'direct',
      untrustedData: true
    };
  }

  getPendingRequests(agentId, limit = 10) {
    try {
      const rows = this.db.prepare(`
        SELECT request_id, conversation_id, from_agent, to_agent, question, context, task_id, status, created_at
        FROM bridge_requests
        WHERE to_agent = ? AND status = 'pending'
        ORDER BY created_at ASC
        LIMIT ?
      `).all(agentId, limit);
      return rows.map(r => ({
        requestId: r.request_id,
        conversationId: r.conversation_id,
        fromAgent: r.from_agent,
        toAgent: r.to_agent,
        question: r.question,
        context: r.context ? (() => { try { return JSON.parse(r.context); } catch { return r.context; } })() : null,
        taskId: r.task_id,
        status: r.status,
        createdAt: r.created_at
      }));
    } catch {
      return [];
    }
  }

  answerRequest({ requestId, agentId, response, status = 'completed', error = null, attemptId = null, epoch = null }) {
    if (!requestId) throw new Error('requestId is required');
    if (!agentId) throw new Error('agentId is required');

    let reqRow = null;
    try {
      reqRow = this.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(requestId);
    } catch {}

    if (!reqRow) {
      throw new Error(`Request not found: ${requestId}`);
    }

    // 1. Authorization check: recipient agent matching
    if (reqRow.to_agent && reqRow.to_agent !== '*' && agentId.toLowerCase() !== reqRow.to_agent.toLowerCase()) {
      const errMsg = `Unauthorized: agent '${agentId}' cannot answer request intended for '${reqRow.to_agent}'`;
      if (this.tasks?.attempts) {
        try {
          this.tasks.attempts.quarantineLateResponse({
            attemptId: attemptId || `unauth_${agentId}`,
            requestId,
            epoch: epoch || 0,
            payload: response || error,
            reason: errMsg
          });
        } catch (qErr) {
          this.logger?.debug?.('Failed to quarantine unauth response in answerRequest', qErr);
        }
      }
      return {
        status: 'quarantined',
        quarantined: true,
        requestId,
        answeredBy: agentId,
        error: errMsg
      };
    }

    // 2. Terminal request protection: terminal requests are immutable
    const resultStr = typeof response === 'string' ? response : (response ? JSON.stringify(response) : null);
    if (TERMINAL_REQUEST_STATES.has(reqRow.status)) {
      if (reqRow.status === 'completed' && status === 'completed' && (reqRow.response === resultStr || resultStr === null)) {
        return {
          status: 'completed',
          requestId,
          answeredBy: reqRow.to_agent,
          result: reqRow.response
        };
      }
      // Late submission on already terminal request: quarantine payload
      if (this.tasks?.attempts) {
        try {
          this.tasks.attempts.quarantineLateResponse({
            attemptId: attemptId || `late_on_${requestId}`,
            requestId,
            epoch: epoch || 0,
            payload: response || error,
            reason: `Late submission on already terminal request (${reqRow.status})`
          });
        } catch (qErr) {
          this.logger?.debug?.('Failed to quarantine late response on terminal request in answerRequest', qErr);
        }
      }
      return {
        status: 'quarantined',
        quarantined: true,
        requestId,
        answeredBy: agentId,
        error: `Request '${requestId}' is already terminal ('${reqRow.status}'); late response quarantined.`
      };
    }

    if (reqRow.task_id) {
      return this.submitTaskResult({
        taskId: reqRow.task_id,
        agentId,
        status,
        result: response,
        error,
        attemptId,
        epoch
      });
    }

    // 3. Fencing validation if attemptId provided
    if (attemptId && (epoch === null || epoch === undefined)) {
      throw new Error(`Fencing Error: epoch token is required when attemptId is provided for request '${requestId}'.`);
    }
    if (attemptId && (epoch !== null && epoch !== undefined) && this.tasks?.attempts) {
      try {
        this.tasks.attempts.validateFencing({ taskId: reqRow.task_id || requestId, attemptId, epoch: Number(epoch), agentId });
      } catch (fencingErr) {
        try {
          this.tasks.attempts.quarantineLateResponse({
            attemptId,
            requestId,
            epoch: Number(epoch) || 0,
            payload: response || error,
            reason: fencingErr.message
          });
        } catch (qErr) {
          this.logger?.debug?.('Failed to quarantine fenced late response in answerRequest', qErr);
        }
        return {
          status: 'quarantined',
          quarantined: true,
          requestId,
          attemptId,
          epoch,
          error: fencingErr.message
        };
      }
    }

    const now = new Date().toISOString();

    const directWork = (targetDb, stageEventFn = null) => {
      targetDb.prepare(`
        UPDATE bridge_requests
        SET status = ?, response = ?, error = ?, updated_at = ?, completed_at = ?
        WHERE request_id = ?
      `).run(status, resultStr, error, now, now, requestId);

      if (status === 'completed' && resultStr) {
        try {
          const reqMode = reqRow?.context ? (() => {
            try {
              const parsed = JSON.parse(reqRow.context);
              return parsed?.responseMode || 'direct';
            } catch { return 'direct'; }
          })() : 'direct';

          this.responsePreserver.preserveResponse({
            requestId,
            taskId: null,
            respondingAgentId: agentId,
            requestingAgentId: reqRow?.from_agent || '*',
            responseText: resultStr,
            responseMode: reqMode,
            executionMetadata: {
              attemptEpoch: epoch || 1,
              correlationTier: attemptId ? 'crypto_nonce' : 'direct_session',
              originRoute: 'direct_answer'
            }
          });

          this.tokenAccountant.recordTurn({
            requestId,
            taskId: null,
            responseMode: reqMode,
            requestingAgent: reqRow?.from_agent || '*',
            respondingAgent: agentId,
            promptText: reqRow?.question || '',
            responseText: resultStr
          });
        } catch (err) {
          this.logger?.debug?.('Failed to preserve response artifact in answerRequest', err);
        }
      }

      if (stageEventFn) {
        stageEventFn({
          type: 'response_delivered',
          agentId: reqRow.from_agent,
          fromAgent: agentId,
          conversationId: reqRow.conversation_id,
          requestId,
          taskId: null,
          status,
          payload: {
            snippet: resultStr ? (resultStr.length > 100 ? resultStr.slice(0, 100) + '...' : resultStr) : null,
            status,
            error: error ? (error.length > 80 ? error.slice(0, 80) + '...' : error) : null
          },
          dedupKey: `direct_resp_${requestId}_${status}`
        });
      }
    };

    if (this.eventBus && typeof this.eventBus.runInTransaction === 'function') {
      this.eventBus.runInTransaction((tx) => {
        directWork(tx.db, tx.stageEvent);
      });
    } else {
      directWork(this.db, null);
      if (this.eventBus) {
        this.eventBus.publish({
          type: 'response_delivered',
          agentId: reqRow.from_agent,
          fromAgent: agentId,
          conversationId: reqRow.conversation_id,
          requestId,
          taskId: null,
          status,
          payload: {
            snippet: resultStr ? (resultStr.length > 100 ? resultStr.slice(0, 100) + '...' : resultStr) : null,
            status,
            error: error ? (error.length > 80 ? error.slice(0, 80) + '...' : error) : null
          },
          dedupKey: `direct_resp_${requestId}_${status}`
        });
      }
    }

    return {
      status: 'success',
      requestId,
      answeredBy: agentId,
      result: response
    };
  }
}
