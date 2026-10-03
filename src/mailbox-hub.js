import crypto from 'node:crypto';
import { TaskManager } from './task-manager.js';
import { EventBus } from './event-bus.js';

export class MailboxHub {
  constructor(auditLogger, taskManager = null, eventBus = null) {
    this.logger = auditLogger;
    this.db = auditLogger.db;
    this.tasks = taskManager || new TaskManager(auditLogger);
    this.eventBus = eventBus || new EventBus(auditLogger);
    this.agentHandlers = new Map(); // agentId -> async (question, context) => response
  }

  registerAgentHandler(agentId, handler) {
    this.agentHandlers.set(agentId, handler);
  }

  sendMessage({
    fromAgent,
    toAgent,
    subject,
    content,
    replyToId = null,
    conversationId = null,
    requestId = null
  }) {
    const id = `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = new Date().toISOString();
    const convId = conversationId || `conv_msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    const stmt = this.db.prepare(`
      INSERT INTO messages (id, timestamp, from_agent, to_agent, subject, content, reply_to_id, read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `);
    stmt.run(id, timestamp, fromAgent, toAgent, subject, content, replyToId);

    this.logger.log({
      agentId: fromAgent,
      action: 'send_message',
      targetPath: null,
      command: null,
      status: 'success',
      details: { messageId: id, toAgent, subject, conversationId: convId, requestId }
    });

    // Cross-process event notification
    if (this.eventBus) {
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
        }
      });
    }

    return { id, timestamp, fromAgent, toAgent, subject, content, replyToId, conversationId: convId, requestId };
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
    requestId = null
  }) {
    const task = this.tasks.createTask({
      fromAgent,
      toAgent,
      title,
      instructions,
      context,
      parentTaskId,
      priority,
      dependencies
    });

    const convId = conversationId || `conv_task_${task.id}`;

    // Send an inbox message for durable mail fallback
    this.sendMessage({
      fromAgent,
      toAgent,
      subject: `[Task Delegation] ${title}`,
      content: `New task assigned (${task.id}): ${instructions}`,
      replyToId: null,
      conversationId: convId,
      requestId
    });

    // Cross-process event bus notification for instant wakeup
    if (this.eventBus) {
      this.eventBus.publish({
        type: 'task_created',
        agentId: toAgent,
        fromAgent,
        conversationId: convId,
        requestId,
        taskId: task.id,
        status: task.status,
        payload: {
          title: title ? (title.length > 80 ? title.slice(0, 80) + '...' : title) : '',
          priority
        }
      });
    }

    return task;
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
    timeoutMs = 30000,
    asyncMode = false
  }) {
    const timestamp = new Date().toISOString();

    // 1. If target agent has a registered local handler (e.g. test peer or in-memory mock), call synchronously
    const handler = this.agentHandlers.get(toAgent);
    if (handler) {
      const response = await handler(question, context);
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
        timestamp
      };
    }

    // 2. Correlated Request Generation
    const reqId = requestId || `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const convId = conversationId || `conv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();

    // Store request in bridge_requests table for full durability
    const ctxString = typeof context === 'object' && context !== null ? JSON.stringify(context) : context;
    const taskContext = {
      requestId: reqId,
      conversationId: convId,
      originalContext: context,
      question
    };

    this.db.prepare(`
      INSERT INTO bridge_requests (
        request_id, conversation_id, from_agent, to_agent, question, context,
        task_id, status, response, error, timeout_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, ?, ?, ?)
    `).run(reqId, convId, fromAgent, toAgent, question, ctxString, timeoutMs, now, now);

    // Create backing task
    const task = this.delegateTask({
      fromAgent,
      toAgent,
      title: `Query from ${fromAgent}`,
      instructions: question,
      context: taskContext,
      priority: 'high',
      conversationId: convId,
      requestId: reqId
    });

    // Update request with backing task id
    this.db.prepare(`
      UPDATE bridge_requests SET task_id = ? WHERE request_id = ?
    `).run(task.id, reqId);

    // Emit request_created event
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
        }
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
      timeoutMs
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
      // Mark request as timed out in DB
      try {
        this.db.prepare(`
          UPDATE bridge_requests SET status = 'timeout', updated_at = ? WHERE request_id = ?
        `).run(new Date().toISOString(), reqId);
      } catch {}

      return {
        mode: 'request_timeout',
        fromAgent,
        toAgent,
        requestId: reqId,
        conversationId: convId,
        taskId: task.id,
        question,
        status: 'timeout',
        error: outcome.error || `Timed out after ${timeoutMs}ms waiting for response from ${toAgent}`
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
  submitTaskResult({ taskId, agentId, status = 'completed', result = null, error = null }) {
    const updated = this.tasks.updateTaskStatus({
      taskId,
      agentId,
      status,
      result,
      error
    });

    const task = this.tasks.getTask(taskId, false);

    // Check if task is linked to a correlated bridge_request
    let reqRow = null;
    try {
      reqRow = this.db.prepare('SELECT * FROM bridge_requests WHERE task_id = ? OR request_id = ?').get(taskId, taskId);
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
      try {
        this.db.prepare(`
          UPDATE bridge_requests
          SET status = ?, response = ?, error = ?, updated_at = ?, completed_at = ?
          WHERE request_id = ?
        `).run(status, resultStr, error, now, now, requestId);
      } catch {}
    }

    // 1. Live event bus response delivery
    if (this.eventBus) {
      const recipient = task ? task.creator : (reqRow ? reqRow.from_agent : '*');
      const snippet = resultStr ? (resultStr.length > 100 ? resultStr.slice(0, 100) + '...' : resultStr) : null;

      if (requestId) {
        this.eventBus.publish({
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
          }
        });
      }

      this.eventBus.publish({
        type: status === 'completed' ? 'task_completed' : 'task_failed',
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
        }
      });
    }

    // 2. Durable mailbox notification fallback
    if (task && task.creator && task.creator !== agentId) {
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

    return updated;
  }

  claimNextTask(agentId) {
    return this.tasks.claimNextTask(agentId);
  }

  failTask({ taskId, agentId, error, allowRetry = true }) {
    const res = this.tasks.failTask({ taskId, agentId, error, allowRetry });
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
}
