import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import { AttemptLedger } from './attempts/attempt-ledger.js';
import { TransactionalOutbox } from './events/transactional-outbox.js';

export function runInImmediateTx(db, fn) {
  let started = false;
  try {
    db.exec('BEGIN IMMEDIATE;');
    started = true;
  } catch (err) {
    if (err.message && err.message.includes('cannot start a transaction')) {
      return fn();
    }
    throw err;
  }
  try {
    const res = fn();
    if (started) db.exec('COMMIT;');
    return res;
  } catch (err) {
    if (started) {
      try { db.exec('ROLLBACK;'); } catch {}
    }
    throw err;
  }
}

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
  constructor(auditLogger, attemptLedger = null, eventBus = null) {
    super();
    this.logger = auditLogger;
    this.db = auditLogger?.db;
    this.attempts = attemptLedger || (auditLogger ? new AttemptLedger(auditLogger) : null);
    this.eventBus = eventBus || null;
    this.outbox = this.eventBus?.outbox || (auditLogger ? new TransactionalOutbox(auditLogger, this.eventBus) : null);
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
    dependencies = [],
    conversationId = null,
    requestId = null,
    emitEvent = true,
    dedupKey = null
  }) {
    const id = `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = new Date().toISOString();
    const depsJson = Array.isArray(dependencies) ? JSON.stringify(dependencies) : null;
    const initialStatus = (dependencies && dependencies.length > 0) ? 'blocked' : 'pending';
    const resolvedContext = typeof context === 'object' && context !== null ? JSON.stringify(context) : context;

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

    const insertWork = (targetDb, stageEventFn = null) => {
      const stmt = targetDb.prepare(`
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
        resolvedContext,
        initialStatus,
        parentTaskId,
        priority,
        timeoutMs,
        maxRetries,
        depsJson
      );

      this.logger?.log({
        agentId: fromAgent,
        action: 'delegate_task',
        status: 'success',
        details: { taskId: id, toAgent, title, priority, parentTaskId }
      });

      if (emitEvent && stageEventFn) {
        stageEventFn({
          type: 'task_created',
          agentId: toAgent,
          fromAgent,
          conversationId: conversationId || `conv_task_${id}`,
          requestId,
          taskId: id,
          status: initialStatus,
          payload: {
            title: title ? (title.length > 80 ? title.slice(0, 80) + '...' : title) : '',
            priority
          },
          dedupKey: dedupKey || `task_created_${id}`
        });
      }
    };

    const outboxToUse = this.eventBus?.outbox || this.outbox;
    if (outboxToUse) {
      outboxToUse.runInTransaction((tx) => {
        insertWork(tx.db, tx.stageEvent);
      });
    } else {
      runInImmediateTx(this.db, () => {
        insertWork(this.db, null);
      });
    }

    this.emit('taskCreated', task);
    return task;
  }

  claimNextTask(agentId) {
    // Recover abandoned leases before claiming new work.
    this.recoverExpiredTasks(agentId);

    // Check if there are blocked tasks whose dependencies are now completed
    this.refreshBlockedTasks(agentId);

    const now = new Date().toISOString();
    let row = null;

    runInImmediateTx(this.db, () => {
      row = this.db.prepare(`
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

      if (!row) return;

      const update = this.db.prepare(`
        UPDATE tasks
        SET status = 'claimed', started_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(now, now, row.id);

      if (update.changes === 0) {
        row = null;
      }
    });

    if (!row) return null;

    this.logger?.log({
      agentId,
      action: 'claim_task',
      status: 'success',
      details: { taskId: row.id, title: row.title }
    });

    const claimedTask = this.getTask(row.id, false);
    if (this.attempts) {
      try {
        const att = this.attempts.createAttempt({
          taskId: row.id,
          agentId,
          routeId: 'claimed_task'
        });
        this.attempts.acquireAttempt(att.attemptId, agentId);
        claimedTask.attemptId = att.attemptId;
        claimedTask.epoch = att.epoch;
        claimedTask.nonce = att.nonce;
      } catch {}
    }
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

    const nowMs = Date.now();
    const recovered = [];

    runInImmediateTx(this.db, () => {
      const rows = this.db.prepare(query).all(...params);
      for (const task of rows) {
        const startedMs = Date.parse(task.updated_at || task.started_at);
        const timeoutMs = Number(task.timeout_ms) || 60000;
        if (!Number.isFinite(startedMs) || nowMs - startedMs < timeoutMs) continue;

        const retryCount = (task.retry_count || 0) + 1;
        const maxRetries = task.max_retries || 3;
        const now = new Date().toISOString();
        const error = `Task lease expired after ${timeoutMs}ms`;

        if (retryCount <= maxRetries) {
          this.db.prepare(`
            UPDATE tasks
            SET status = 'pending', retry_count = ?, error = ?, updated_at = ?, started_at = NULL
            WHERE id = ? AND status IN ('claimed', 'in_progress')
          `).run(retryCount, error, now, task.id);
          recovered.push({ taskId: task.id, status: 'pending', retryCount });
        } else {
          this.db.prepare(`
            UPDATE tasks
            SET status = 'failed', retry_count = ?, error = ?, updated_at = ?, completed_at = ?
            WHERE id = ? AND status IN ('claimed', 'in_progress')
          `).run(retryCount, `Failed after ${retryCount} attempts: ${error}`, now, now, task.id);
          recovered.push({ taskId: task.id, status: 'failed', retryCount });
        }
      }
    });

    for (const rec of recovered) {
      this.logger?.log({
        agentId: agentId || 'system',
        action: 'recover_expired_task',
        status: rec.status,
        details: rec
      });
    }

    return recovered;
  }

  touchTask({ taskId, agentId, attemptId = null, epoch = null }) {
    if (attemptId && epoch && this.attempts) {
      this.attempts.touchAttempt(attemptId, epoch, agentId);
    }

    const now = new Date().toISOString();
    let result = null;
    runInImmediateTx(this.db, () => {
      result = this.db.prepare(`
        UPDATE tasks
        SET status = CASE WHEN status = 'claimed' THEN 'in_progress' ELSE status END,
            started_at = COALESCE(started_at, ?),
            updated_at = ?
        WHERE id = ? AND to_agent = ? AND status IN ('claimed', 'in_progress')
      `).run(now, now, taskId, agentId);
    });

    if (result.changes === 0) {
      throw new Error(`Task '${taskId}' is not actively owned by '${agentId}'.`);
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

  updateTaskStatus({ taskId, agentId, status, result = null, error = null, attemptId = null, epoch = null }) {
    if (!TASK_STATUSES.includes(status)) {
      throw new Error(`Invalid status '${status}'. Must be one of: ${TASK_STATUSES.join(', ')}`);
    }

    const now = new Date().toISOString();
    let task = null;

    runInImmediateTx(this.db, () => {
      task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
      if (!task) {
        throw new Error(`Task '${taskId}' not found.`);
      }

      // Fencing invariant: validate attempt if attemptId or epoch provided
      if (attemptId && (epoch === null || epoch === undefined)) {
        throw new Error(`Fencing Error: epoch token is required when attemptId is provided for task '${taskId}'.`);
      }
      if ((epoch !== null && epoch !== undefined) && this.attempts) {
        if (attemptId) {
          this.attempts.validateFencing({ taskId, attemptId, epoch, agentId });
        } else {
          const epochRow = this.db.prepare(`
            SELECT current_epoch, active_attempt_id FROM task_epochs WHERE task_id = ?
          `).get(taskId);
          if (epochRow && epoch !== epochRow.current_epoch) {
            const err = new Error(
              `FENCED_ATTEMPT_ERROR: Stale epoch ${epoch} for task '${taskId}'. Current epoch is ${epochRow.current_epoch}. Execution blocked.`
            );
            err.code = 'FENCED_ATTEMPT_ERROR';
            throw err;
          }
        }
      }

      // Authorization: only the assignee (owner) or the creator may move a task
      // into a terminal state. Prevents an unrelated agent from completing or
      // failing someone else's task by guessing its id.
      if (['completed', 'failed', 'cancelled'].includes(status)) {
        const actor = agentId ? String(agentId).trim().toLowerCase() : null;
        const owner = task.to_agent ? String(task.to_agent).trim().toLowerCase() : null;
        const creator = task.from_agent ? String(task.from_agent).trim().toLowerCase() : null;
        if (actor && owner && actor !== owner && actor !== creator) {
          throw new Error(`Forbidden: task '${taskId}' is owned by '${task.to_agent}'; '${agentId}' may not mark it '${status}'.`);
        }
      }

      let startedAt = task.started_at;
      let completedAt = task.completed_at;

      if (status === 'in_progress' && !startedAt) {
        startedAt = now;
      }
      if (['completed', 'failed', 'cancelled'].includes(status)) {
        completedAt = now;
      }

      const serializedResult = (result !== null && typeof result === 'object') ? JSON.stringify(result) : result;
      const stmt = this.db.prepare(`
        UPDATE tasks
        SET status = ?, result = COALESCE(?, result), error = ?, updated_at = ?,
            started_at = ?, completed_at = ?
        WHERE id = ?
      `);

      stmt.run(status, serializedResult, error, now, startedAt, completedAt, taskId);

      if (this.attempts) {
        if (attemptId && epoch) {
          if (status === 'completed') {
            this.attempts.completeAttempt({ attemptId, epoch, result: serializedResult });
          } else if (['failed', 'cancelled'].includes(status)) {
            this.attempts.failAttempt({ attemptId, epoch, error: error || status });
          }
        } else {
          const activeAtt = this.attempts.getActiveAttemptForTask(taskId);
          if (activeAtt) {
            try {
              if (status === 'completed') {
                this.attempts.completeAttempt({ attemptId: activeAtt.attemptId, epoch: activeAtt.epoch, result: serializedResult });
              } else if (['failed', 'cancelled'].includes(status)) {
                this.attempts.failAttempt({ attemptId: activeAtt.attemptId, epoch: activeAtt.epoch, error: error || status });
              }
            } catch {}
          }
        }
      }

      this.logger?.log({
        agentId,
        action: 'update_task_status',
        status: 'success',
        details: { taskId, newStatus: status }
      });
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
