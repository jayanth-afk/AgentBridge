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
      stmt.run(id, timestamp, fromAgent, toAgent, subject, content, replyToId);

      this.logger?.log({
        agentId: fromAgent,
        action: 'send_message',
        targetPath: null,
        command: null,
        status: 'success',
        details: { messageId: id, toAgent, subject, conversationId: convId, requestId }
      });

      if (emitEvent && stageEventFn) {
        stageEventFn({
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

      resultMsg = { id, timestamp, fromAgent, toAgent, subject, content, replyToId, conversationId: convId, requestId };
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
    let query = `SELECT * FROM messages WHERE to_agent = ?`;
    if (unreadOnly) {
      query += ` AND read_at IS NULL`;
    }
    query += ` ORDER BY timestamp DESC LIMIT ?`;

    const stmt = this.db.prepare(query);
    const messages = stmt.all(agentId, limit);

    this.logger.log({
      agentId,
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
    emitEvent = true
  }) {
    const resolvedReqId = requestId || `req_task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const convId = conversationId || (resolvedReqId ? `conv_${resolvedReqId}` : null);

    const runWork = () => {
      const task = this.tasks.createTask({
        fromAgent,
        toAgent,
        title,
        instructions,
        context,
        parentTaskId,
        priority,
        dependencies,
        conversationId: convId,
        requestId: resolvedReqId,
        emitEvent
      });

      // Establish uniform request-task correlation in bridge_requests so desktop and autonomous workers can uniformly claim and track all tasks
      if (this.db) {
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
            `).run(resolvedReqId, convId, fromAgent, toAgent, instructions || title, ctxStr, task.id, now, now);
          }
        } catch {}
      }

      const actualConvId = convId || `conv_task_${task.id}`;

      // Send an inbox message for durable mail fallback only if requested
      if (notifyInbox) {
        this.sendMessage({
          fromAgent,
          toAgent,
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
    asyncMode = false
  }) {
    const timestamp = new Date().toISOString();

    // 1. If target agent has a registered local handler (e.g. test peer or in-memory mock), call synchronously
    const handler = this.agentHandlers.get(toAgent);
    if (handler) {
      const sensitive = isSensitiveCredentialRequest(question);
      if (sensitive.sensitive) {
        return {
          mode: 'request_failed',
          fromAgent,
          toAgent,
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
        response = getRegisteredVerificationToken(toAgent);
      } else {
        response = await handler(question, context);
      }

      this.sendMessage({
        fromAgent,
        toAgent,
        subject: `[Direct Query] ${question.slice(0, 40)}...`,
        content: question
      });
      this.sendMessage({
        fromAgent: toAgent,
        toAgent: fromAgent,
        subject: `[Direct Response] Re: ${question.slice(0, 40)}...`,
        content: typeof response === 'string' ? response : JSON.stringify(response)
      });
      return {
        mode: 'synchronous_peer_response',
        fromAgent,
        toAgent,
        question,
        response,
        status: 'completed',
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
      if (existingReq.status === 'completed') {
        this.tracer?.mark({
          requestId: existingReq.request_id,
          stage: LifecycleStage.RESPONSE_RETURNED,
          taskId: existingReq.task_id,
          agentId: fromAgent,
          meta: { outcome: 'completed', reconnected: true }
        });
        return {
          mode: 'autonomous_correlated_response',
          fromAgent: existingReq.from_agent,
          toAgent: existingReq.to_agent,
          requestId: existingReq.request_id,
          conversationId: existingReq.conversation_id,
          taskId: existingReq.task_id,
          question: existingReq.question,
          response: existingReq.response,
          status: 'completed',
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
        return {
          mode: 'autonomous_correlated_response',
          fromAgent: existingReq.from_agent,
          toAgent: existingReq.to_agent,
          requestId: existingReq.request_id,
          conversationId: existingReq.conversation_id,
          taskId: existingReq.task_id,
          question: existingReq.question,
          response: finalResponse,
          status: 'completed',
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
      question
    };

    let task = null;

    const stageRequestWork = (targetDb, stageEventFn = null) => {
      targetDb.prepare(`
        INSERT INTO bridge_requests (
          request_id, conversation_id, from_agent, to_agent, question, context,
          task_id, status, response, error, timeout_ms, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, ?, ?, ?)
      `).run(reqId, convId, fromAgent, toAgent, question, ctxString, timeoutMs, now, now);

      task = this.delegateTask({
        fromAgent,
        toAgent,
        title: `Query from ${fromAgent}`,
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
          agentId: toAgent,
          fromAgent,
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
          agentId: toAgent,
          fromAgent,
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
      agentId: toAgent,
      meta: { fromAgent, conversationId: convId, asyncMode }
    });
    if (task) {
      this.tracer.mark({
        requestId: reqId,
        stage: LifecycleStage.TASK_CREATED,
        taskId: task.id,
        agentId: toAgent
      });
    }

    // If explicit asynchronous mode requested, return immediately with correlation IDs
    if (asyncMode) {
      return {
        mode: 'queued_in_mailbox',
        fromAgent,
        toAgent,
        requestId: reqId,
        conversationId: convId,
        taskId: task.id,
        status: 'pending',
        note: `Query queued in ${toAgent}'s mailbox for processing.`
      };
    }

    // Default: Synchronous / Correlated Waiter loop
    // Originating agent stays attached to correlated response channel waiting for B's answer
    const outcome = await this.eventBus.waitForResponse({
      requestId: reqId,
      agentId: fromAgent,
      taskId: task ? task.id : null,
      timeoutMs
    });

    // Lifecycle: the correlated response (or a truthful timeout) reached the caller.
    this.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.RESPONSE_RETURNED,
      taskId: task ? task.id : null,
      agentId: fromAgent,
      meta: { outcome: outcome.status }
    });

    if (outcome.status === 'completed') {
      let finalResponse = outcome.response;
      if (finalResponse === undefined || finalResponse === null) {
        const row = this.db.prepare('SELECT response FROM bridge_requests WHERE request_id = ?').get(reqId);
        finalResponse = row?.response;
      }

      return {
        mode: 'autonomous_correlated_response',
        fromAgent,
        toAgent,
        requestId: reqId,
        conversationId: convId,
        taskId: task.id,
        question,
        response: finalResponse,
        status: 'completed',
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
        fromAgent,
        toAgent,
        requestId: reqId,
        conversationId: convId,
        taskId: task.id,
        question,
        status: 'timeout',
        error: outcome.error || `Timed out after ${timeoutMs}ms waiting for response from ${toAgent}`,
        recoverable: true
      };
    } else {
      return {
        mode: 'request_failed',
        fromAgent,
        toAgent,
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
        // If request is already terminal completed, do NOT downgrade or overwrite it with failure
        const isAlreadyCompleted = reqRow?.status === 'completed';
        if (!isAlreadyCompleted || status === 'completed') {
          try {
            targetDb.prepare(`
              UPDATE bridge_requests
              SET status = ?, response = ?, error = ?, updated_at = ?, completed_at = ?
              WHERE request_id = ?
            `).run(status, resultStr, error, now, now, requestId);
          } catch {}
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
    return this.tasks.claimNextTask(agentId);
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

  getTask(taskId, compact = true) {
    return this.tasks.getTask(taskId, compact);
  }

  listTasks({ agentId = null, status = null, limit = 20, compact = true } = {}) {
    return this.tasks.listTasks({ agentId, status, limit, compact });
  }

  getRequest(requestId) {
    if (!requestId || typeof requestId !== 'string') {
      throw new Error('requestId is required and must be a non-empty string.');
    }
    const row = this.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(requestId);
    if (!row) return null;
    return {
      requestId: row.request_id,
      conversationId: row.conversation_id,
      fromAgent: row.from_agent,
      toAgent: row.to_agent,
      question: row.question,
      context: row.context ? (() => { try { return JSON.parse(row.context); } catch { return row.context; } })() : null,
      taskId: row.task_id,
      status: row.status,
      response: row.response,
      error: row.error,
      timeoutMs: row.timeout_ms,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at
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

    // Direct request without backing task
    if (reqRow.status === 'completed' && status !== 'completed') {
      return {
        status: 'completed',
        requestId,
        answeredBy: reqRow.to_agent,
        result: reqRow.response
      };
    }

    // Direct request without backing task
    const now = new Date().toISOString();
    const resultStr = typeof response === 'string' ? response : (response ? JSON.stringify(response) : null);

    const directWork = (targetDb, stageEventFn = null) => {
      targetDb.prepare(`
        UPDATE bridge_requests
        SET status = ?, response = ?, error = ?, updated_at = ?, completed_at = ?
        WHERE request_id = ?
      `).run(status, resultStr, error, now, now, requestId);

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
