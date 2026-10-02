import crypto from 'node:crypto';
import EventEmitter from 'node:events';

export const TASK_STATUSES = [
  'pending',
  'claimed',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
  'blocked',
  'waiting_for_agent'
];

export class TaskManager extends EventEmitter {
  constructor(auditLogger) {
    super();
    this.logger = auditLogger;
    this.db = auditLogger.db;
    this.initTables();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        context TEXT,
        status TEXT NOT NULL,
        result TEXT
      );
    `);

    // Ensure all modern columns exist via safe migrations
    const tableInfo = this.db.prepare(`PRAGMA table_info(tasks)`).all();
    const existingCols = new Set(tableInfo.map(c => c.name));

    const newCols = [
      { name: 'parent_task_id', type: 'TEXT' },
      { name: 'priority', type: 'TEXT DEFAULT "normal"' },
      { name: 'started_at', type: 'TEXT' },
      { name: 'completed_at', type: 'TEXT' },
      { name: 'retry_count', type: 'INTEGER DEFAULT 0' },
      { name: 'max_retries', type: 'INTEGER DEFAULT 3' },
      { name: 'timeout_ms', type: 'INTEGER DEFAULT 60000' },
      { name: 'error', type: 'TEXT' },
      { name: 'dependencies', type: 'TEXT' } // JSON array of task IDs
    ];

    for (const col of newCols) {
      if (!existingCols.has(col.name)) {
        try {
          this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col.name} ${col.type}`);
        } catch {}
      }
    }

    // Indexes for fast querying
    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_to_agent_status ON tasks(to_agent, status);
        CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_task_id);
      `);
    } catch {}
  }

  createTask({
    fromAgent,
    toAgent,
    title,
    instructions,
    context = null,
    parentTaskId = null,
    priority = 'normal',
    timeoutMs = 60000,
    maxRetries = 3,
    dependencies = []
  }) {
    const id = `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = new Date().toISOString();
    const depsJson = Array.isArray(dependencies) ? JSON.stringify(dependencies) : null;
    const initialStatus = (dependencies && dependencies.length > 0) ? 'blocked' : 'pending';

    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, created_at, updated_at, from_agent, to_agent, title, instructions,
        context, status, result, parent_task_id, priority, timeout_ms, max_retries, dependencies
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      timestamp,
      timestamp,
      fromAgent,
      toAgent,
      title,
      instructions,
      typeof context === 'object' && context !== null ? JSON.stringify(context) : context,
      initialStatus,
      parentTaskId,
      priority,
      timeoutMs,
      maxRetries,
      depsJson
    );

    this.logger.log({
      agentId: fromAgent,
      action: 'delegate_task',
      status: 'success',
      details: { taskId: id, toAgent, title, priority, parentTaskId }
    });

    const task = {
      id,
      parentTaskId,
      creator: fromAgent,
      assignee: toAgent,
      title,
      instructions,
      status: initialStatus,
      priority,
      createdAt: timestamp,
      updatedAt: timestamp,
      dependencies
    };

    this.emit('taskCreated', task);
    return task;
  }

  claimNextTask(agentId) {
    // Recover abandoned leases before claiming new work.
    this.recoverExpiredTasks(agentId);

    // Check if there are blocked tasks whose dependencies are now completed
    this.refreshBlockedTasks(agentId);

    const now = new Date().toISOString();
    // Claim oldest pending task ordered by priority (urgent > high > normal > low)
    const row = this.db.prepare(`
      SELECT id, title, instructions, from_agent, to_agent, priority, context
      FROM tasks
      WHERE to_agent = ? AND status = 'pending'
      ORDER BY 
        CASE priority 
          WHEN 'urgent' THEN 1 
          WHEN 'high' THEN 2 
          WHEN 'normal' THEN 3 
          ELSE 4 
        END,
        created_at ASC
      LIMIT 1
    `).get(agentId);

    if (!row) return null;

    const update = this.db.prepare(`
      UPDATE tasks
      SET status = 'claimed', started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(now, now, row.id);

    if (update.changes === 0) return null;

    this.logger.log({
      agentId,
      action: 'claim_task',
      status: 'success',
      details: { taskId: row.id, title: row.title }
    });

    const claimedTask = this.getTask(row.id, false);
    this.emit('taskClaimed', claimedTask);
    return claimedTask;
  }

  recoverExpiredTasks(agentId = null) {
    const params = [];
    let query = `SELECT * FROM tasks WHERE status IN ('claimed', 'in_progress') AND started_at IS NOT NULL`;
    if (agentId) {
      query += ' AND to_agent = ?';
      params.push(agentId);
    }

    const rows = this.db.prepare(query).all(...params);
    const nowMs = Date.now();
    const recovered = [];

    for (const task of rows) {
      const startedMs = Date.parse(task.updated_at || task.started_at);
      const timeoutMs = Number(task.timeout_ms) || 60000;
      if (!Number.isFinite(startedMs) || nowMs - startedMs < timeoutMs) continue;

      const retryCount = (task.retry_count || 0) + 1;
      const maxRetries = task.max_retries || 3;
      const now = new Date().toISOString();
      const error = `Task lease expired after ${'${'}timeoutMs}ms`;

      if (retryCount <= maxRetries) {
        this.db.prepare(`
          UPDATE tasks
          SET status = 'pending', retry_count = ?, error = ?, updated_at = ?, started_at = NULL
          WHERE id = ? AND status IN ('claimed', 'in_progress')
        `).run(retryCount, error, now, task.id);
        recovered.push({ taskId: task.id, status: 'pending', retryCount });
        this.logger.log({
          agentId: agentId || task.to_agent,
          action: 'recover_expired_task',
          status: 'retry',
          details: { taskId: task.id, retryCount, maxRetries, timeoutMs }
        });
      } else {
        this.db.prepare(`
          UPDATE tasks
          SET status = 'failed', retry_count = ?, error = ?, updated_at = ?, completed_at = ?
          WHERE id = ? AND status IN ('claimed', 'in_progress')
        `).run(retryCount, `Failed after ${'${'}retryCount} attempts: ${'${'}error}`, now, now, task.id);
        recovered.push({ taskId: task.id, status: 'failed', retryCount });
        this.logger.log({
          agentId: agentId || task.to_agent,
          action: 'recover_expired_task',
          status: 'failed',
          details: { taskId: task.id, retryCount, maxRetries, timeoutMs }
        });
      }
    }

    return recovered;
  }

  touchTask({ taskId, agentId }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE tasks
      SET status = CASE WHEN status = 'claimed' THEN 'in_progress' ELSE status END,
          started_at = COALESCE(started_at, ?),
          updated_at = ?
      WHERE id = ? AND to_agent = ? AND status IN ('claimed', 'in_progress')
    `).run(now, now, taskId, agentId);

    if (result.changes === 0) {
      throw new Error(`Task '${'${'}taskId}' is not actively owned by '${'${'}agentId}'.`);
    }

    return this.getTask(taskId, true);
  }

  refreshBlockedTasks(agentId) {
    const blocked = this.db.prepare(`
      SELECT id, dependencies FROM tasks
      WHERE to_agent = ? AND status = 'blocked'
    `).all(agentId);

    const now = new Date().toISOString();
    for (const b of blocked) {
      if (!b.dependencies) {
        this.db.prepare(`UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?`).run(now, b.id);
        continue;
      }
      try {
        const deps = JSON.parse(b.dependencies);
        if (Array.isArray(deps) && deps.length > 0) {
          const placeholders = deps.map(() => '?').join(',');
          const completedCount = this.db.prepare(`
            SELECT COUNT(*) as count FROM tasks WHERE id IN (${placeholders}) AND status = 'completed'
          `).get(...deps).count;

          if (completedCount === deps.length) {
            this.db.prepare(`UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?`).run(now, b.id);
            this.emit('taskUnblocked', b.id);
          }
        }
      } catch {}
    }
  }

  updateTaskStatus({ taskId, agentId, status, result = null, error = null }) {
    if (!TASK_STATUSES.includes(status)) {
      throw new Error(`Invalid status '${status}'. Must be one of: ${TASK_STATUSES.join(', ')}`);
    }

    const now = new Date().toISOString();
    const task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found.`);
    }

    let startedAt = task.started_at;
    let completedAt = task.completed_at;

    if (status === 'in_progress' && !startedAt) {
      startedAt = now;
    }
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      completedAt = now;
    }

    const stmt = this.db.prepare(`
      UPDATE tasks
      SET status = ?, result = COALESCE(?, result), error = ?, updated_at = ?,
          started_at = ?, completed_at = ?
      WHERE id = ?
    `);

    stmt.run(status, result, error, now, startedAt, completedAt, taskId);

    this.logger.log({
      agentId,
      action: 'update_task_status',
      status: 'success',
      details: { taskId, newStatus: status }
    });

    const updated = this.getTask(taskId, false);

    // If completed or failed, notify parent or unblock dependents
    if (status === 'completed') {
      this.refreshBlockedTasks(task.to_agent);
      this.emit('taskCompleted', updated);
    } else if (status === 'failed') {
      this.emit('taskFailed', updated);
    }

    return updated;
  }

  failTask({ taskId, agentId, error, allowRetry = true }) {
    const task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found.`);

    const now = new Date().toISOString();
    const retryCount = (task.retry_count || 0) + 1;
    const maxRetries = task.max_retries || 3;

    if (allowRetry && retryCount <= maxRetries) {
      // Re-queue task as pending
      this.db.prepare(`
        UPDATE tasks
        SET status = 'pending', retry_count = ?, error = ?, updated_at = ?
        WHERE id = ?
      `).run(retryCount, error, now, taskId);

      this.logger.log({
        agentId,
        action: 'retry_task',
        status: 'retry',
        details: { taskId, retryCount, maxRetries, error }
      });

      return { taskId, status: 'pending', retryCount, willRetry: true, error };
    }

    // Exceeded retries -> mark as failed
    return this.updateTaskStatus({
      taskId,
      agentId,
      status: 'failed',
      error: `Failed after ${retryCount} attempts: ${error}`
    });
  }

  cancelTask({ taskId, agentId, reason = 'Cancelled by user or system' }) {
    return this.updateTaskStatus({
      taskId,
      agentId,
      status: 'cancelled',
      error: reason
    });
  }

  getTask(taskId, compact = true) {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
    if (!row) return null;

    if (compact) {
      return {
        id: row.id,
        status: row.status,
        creator: row.from_agent,
        assignee: row.to_agent,
        title: row.title,
        priority: row.priority || 'normal',
        result: row.result ? (row.result.length > 200 ? row.result.slice(0, 200) + '... (truncated)' : row.result) : null,
        error: row.error,
        updatedAt: row.updated_at
      };
    }

    return {
      id: row.id,
      parentTaskId: row.parent_task_id,
      creator: row.from_agent,
      assignee: row.to_agent,
      title: row.title,
      instructions: row.instructions,
      context: row.context ? (() => { try { return JSON.parse(row.context); } catch { return row.context; } })() : null,
      status: row.status,
      priority: row.priority || 'normal',
      retryCount: row.retry_count || 0,
      maxRetries: row.max_retries || 3,
      timeoutMs: row.timeout_ms || 60000,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      dependencies: row.dependencies ? (() => { try { return JSON.parse(row.dependencies); } catch { return []; } })() : [],
      result: row.result,
      error: row.error
    };
  }

  listTasks({ agentId = null, status = null, limit = 20, compact = true } = {}) {
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

    query += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(query).all(...params);

    if (compact) {
      return rows.map(r => ({
        id: r.id,
        status: r.status,
        creator: r.from_agent,
        assignee: r.to_agent,
        title: r.title,
        priority: r.priority || 'normal',
        result: r.result ? (r.result.length > 100 ? r.result.slice(0, 100) + '...' : r.result) : null,
        updatedAt: r.updated_at
      }));
    }

    return rows.map(r => ({
      id: r.id,
      parentTaskId: r.parent_task_id,
      creator: r.from_agent,
      assignee: r.to_agent,
      title: r.title,
      instructions: r.instructions,
      status: r.status,
      priority: r.priority || 'normal',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      result: r.result,
      error: r.error
    }));
  }
}
