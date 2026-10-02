import crypto from 'node:crypto';
import { TaskManager } from './task-manager.js';

export class MailboxHub {
  constructor(auditLogger, taskManager = null) {
    this.logger = auditLogger;
    this.db = auditLogger.db;
    this.tasks = taskManager || new TaskManager(auditLogger);
    this.agentHandlers = new Map(); // agentId -> async (question, context) => response
  }

  registerAgentHandler(agentId, handler) {
    this.agentHandlers.set(agentId, handler);
  }

  sendMessage({ fromAgent, toAgent, subject, content, replyToId = null }) {
    const id = `msg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = new Date().toISOString();

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
      details: { messageId: id, toAgent, subject }
    });

    return { id, timestamp, fromAgent, toAgent, subject, content, replyToId };
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
    dependencies = []
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

    // Also send an inbox message notifying the agent
    this.sendMessage({
      fromAgent,
      toAgent,
      subject: `[Task Delegation] ${title}`,
      content: `New task assigned (${task.id}): ${instructions}`,
      replyToId: null
    });

    return task;
  }

  async askAgent({ fromAgent, toAgent, question, context = null }) {
    const timestamp = new Date().toISOString();

    // If target agent has a registered handler (e.g. Antigravity peer or automated mock), call it synchronously
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

    // Otherwise, post as asynchronous task to the target agent's mailbox
    const task = this.delegateTask({
      fromAgent,
      toAgent,
      title: `Query from ${fromAgent}`,
      instructions: question,
      context
    });

    return {
      mode: 'queued_in_mailbox',
      fromAgent,
      toAgent,
      taskId: task.id,
      status: 'pending',
      note: `Query queued in ${toAgent}'s mailbox for processing.`
    };
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

  submitTaskResult({ taskId, agentId, status = 'completed', result = null, error = null }) {
    const updated = this.tasks.updateTaskStatus({
      taskId,
      agentId,
      status,
      result,
      error
    });

    // Automatically send notification message back to task creator!
    const task = this.tasks.getTask(taskId, false);
    if (task && task.creator && task.creator !== agentId) {
      this.sendMessage({
        fromAgent: agentId,
        toAgent: task.creator,
        subject: `[Task Result] Re: ${task.title}`,
        content: JSON.stringify({
          taskId,
          status,
          result: task.result,
          error: task.error
        })
      });
    }

    return updated;
  }

  claimNextTask(agentId) {
    return this.tasks.claimNextTask(agentId);
  }

  failTask({ taskId, agentId, error, allowRetry = true }) {
    return this.tasks.failTask({ taskId, agentId, error, allowRetry });
  }

  cancelTask({ taskId, agentId, reason }) {
    return this.tasks.cancelTask({ taskId, agentId, reason });
  }

  getTask(taskId, compact = true) {
    return this.tasks.getTask(taskId, compact);
  }

  listTasks({ agentId = null, status = null, limit = 20, compact = true } = {}) {
    return this.tasks.listTasks({ agentId, status, limit, compact });
  }
}
