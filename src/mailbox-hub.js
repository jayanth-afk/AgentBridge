import crypto from 'node:crypto';

export class MailboxHub {
  constructor(auditLogger) {
    this.logger = auditLogger;
    this.db = auditLogger.db;
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

  // Fan out one message to many agents. Recipients are dispatched independently
  // (allSettled), so one failing recipient never aborts delivery to the others
  // and nobody waits on anybody else. Every outcome is reported per recipient.
  // Note: each insert is a sub-millisecond synchronous SQLite write; there is no
  // per-recipient network wait to overlap, so dispatch is effectively immediate.
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

  getInbox({ agentId, unreadOnly = false }) {
    let query = `SELECT * FROM messages WHERE to_agent = ?`;
    if (unreadOnly) {
      query += ` AND read_at IS NULL`;
    }
    query += ` ORDER BY timestamp DESC`;

    const stmt = this.db.prepare(query);
    const messages = stmt.all(agentId);

    this.logger.log({
      agentId,
      action: 'check_inbox',
      targetPath: null,
      command: null,
      status: 'success',
      details: { count: messages.length, unreadOnly }
    });

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

  delegateTask({ fromAgent, toAgent, title, instructions, context = null }) {
    const id = `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, created_at, updated_at, from_agent, to_agent, title, instructions, context, status, result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)
    `);
    stmt.run(id, timestamp, timestamp, fromAgent, toAgent, title, instructions, context);

    this.logger.log({
      agentId: fromAgent,
      action: 'delegate_task',
      targetPath: null,
      command: null,
      status: 'success',
      details: { taskId: id, toAgent, title }
    });

    // Also send an inbox message notifying the agent
    this.sendMessage({
      fromAgent,
      toAgent,
      subject: `[Task Delegation] ${title}`,
      content: `New task assigned (${id}): ${instructions}`,
      replyToId: null
    });

    return { id, createdAt: timestamp, fromAgent, toAgent, title, instructions, status: 'pending' };
  }

  async askAgent({ fromAgent, toAgent, question, context = null }) {
    const timestamp = new Date().toISOString();

    // If target agent has a registered handler (e.g. Antigravity peer or automated mock), call it synchronously!
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

  updateTaskStatus({ taskId, agentId, status, result = null }) {
    const timestamp = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE tasks
      SET status = ?, result = ?, updated_at = ?
      WHERE id = ? AND (to_agent = ? OR from_agent = ?)
    `);
    const info = stmt.run(status, result, timestamp, taskId, agentId, agentId);

    if (info.changes === 0) {
      throw new Error(`Task '${taskId}' not found or agent '${agentId}' is not authorized.`);
    }

    this.logger.log({
      agentId,
      action: 'update_task_status',
      targetPath: null,
      command: null,
      status: 'success',
      details: { taskId, status }
    });

    return { taskId, status, result, updatedAt: timestamp };
  }

  getTask(taskId) {
    const stmt = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`);
    return stmt.get(taskId);
  }

  listTasks({ agentId = null, status = null } = {}) {
    let query = `SELECT * FROM tasks WHERE 1=1`;
    const params = [];
    if (agentId) {
      query += ` AND (to_agent = ? OR from_agent = ?)`;
      params.push(agentId, agentId);
    }
    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }
    query += ` ORDER BY updated_at DESC`;
    const stmt = this.db.prepare(query);
    return stmt.all(...params);
  }
}
