import crypto from 'node:crypto';

/**
 * Attempt Lifecycle States
 */
export const AttemptState = Object.freeze({
  CREATED: 'created',
  ACQUIRED: 'acquired',
  ACTIVE: 'active',
  COMPLETED: 'completed',     // Terminal
  FAILED: 'failed',           // Terminal
  TIMED_OUT: 'timed_out',     // Terminal
  FENCED: 'fenced',           // Terminal: superseded by newer epoch
  QUARANTINED: 'quarantined'  // Terminal: response rejected / quarantined
});

export const TERMINAL_ATTEMPT_STATES = new Set([
  AttemptState.COMPLETED,
  AttemptState.FAILED,
  AttemptState.TIMED_OUT,
  AttemptState.FENCED,
  AttemptState.QUARANTINED
]);

export class AttemptLedger {
  constructor(auditLogger) {
    this.logger = auditLogger;
    this.db = auditLogger.db;
    this.initTables();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_epochs (
        task_id TEXT PRIMARY KEY,
        current_epoch INTEGER NOT NULL DEFAULT 0,
        active_attempt_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bridge_attempts (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        nonce TEXT NOT NULL,
        grant TEXT,
        worktree_path TEXT,
        state TEXT NOT NULL,
        lease_timeout_ms INTEGER NOT NULL DEFAULT 60000,
        lease_expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        heartbeat_at TEXT,
        completed_at TEXT,
        result TEXT,
        error TEXT,
        correlation_info TEXT
      );

      CREATE TABLE IF NOT EXISTS bridge_quarantined_responses (
        quarantine_id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        payload TEXT NOT NULL,
        reason TEXT NOT NULL,
        quarantined_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_attempts_task ON bridge_attempts(task_id, attempt_number);
      CREATE INDEX IF NOT EXISTS idx_attempts_req ON bridge_attempts(request_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_state ON bridge_attempts(state);
      CREATE INDEX IF NOT EXISTS idx_quarantined_req ON bridge_quarantined_responses(request_id);
    `);
  }

  /**
   * Create a new execution try (Attempt) for a task.
   * Monotonically bumps epoch and automatically fences any prior active attempts.
   */
  createAttempt({
    taskId,
    requestId = null,
    agentId,
    routeId = 'default',
    grant = {},
    worktreePath = null,
    leaseTimeoutMs = 60000
  }) {
    if (!taskId) throw new Error('taskId is required to create an attempt');
    if (!agentId) throw new Error('agentId is required to create an attempt');

    const now = new Date().toISOString();
    const resolvedReqId = requestId || `req_for_${taskId}`;

    // 1. Transactional epoch advancement and fencing of prior attempts
    const attemptId = `att_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const nonce = crypto.randomBytes(16).toString('hex');

    // Retrieve or initialize task_epochs
    const epochRow = this.db.prepare(`
      SELECT current_epoch, active_attempt_id FROM task_epochs WHERE task_id = ?
    `).get(taskId);

    const nextEpoch = (epochRow ? epochRow.current_epoch : 0) + 1;

    // Fence prior active attempts for this task
    if (epochRow?.active_attempt_id) {
      this.db.prepare(`
        UPDATE bridge_attempts
        SET state = 'fenced',
            completed_at = ?,
            error = 'Fenced by newer attempt epoch ' || ?
        WHERE task_id = ? AND state IN ('created', 'acquired', 'active')
      `).run(now, nextEpoch, taskId);

      this.logger?.log({
        agentId: 'system',
        action: 'fence_attempt',
        status: 'fenced',
        details: { taskId, priorAttemptId: epochRow.active_attempt_id, supersededByEpoch: nextEpoch }
      });
    }

    // Determine attempt_number
    const countRow = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM bridge_attempts WHERE task_id = ?
    `).get(taskId);
    const attemptNumber = (countRow?.cnt || 0) + 1;

    // Lease expiration calculation
    const expiresAt = new Date(Date.now() + leaseTimeoutMs).toISOString();
    const grantStr = typeof grant === 'object' ? JSON.stringify(grant) : String(grant);

    // Insert new attempt
    this.db.prepare(`
      INSERT INTO bridge_attempts (
        attempt_id, request_id, task_id, attempt_number, agent_id, route_id,
        epoch, nonce, grant, worktree_path, state, lease_timeout_ms,
        lease_expires_at, created_at, started_at, heartbeat_at, completed_at,
        result, error, correlation_info
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)
    `).run(
      attemptId,
      resolvedReqId,
      taskId,
      attemptNumber,
      agentId,
      routeId,
      nextEpoch,
      nonce,
      grantStr,
      worktreePath,
      leaseTimeoutMs,
      expiresAt,
      now
    );

    // Update task_epochs
    this.db.prepare(`
      INSERT INTO task_epochs (task_id, current_epoch, active_attempt_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        current_epoch = excluded.current_epoch,
        active_attempt_id = excluded.active_attempt_id,
        updated_at = excluded.updated_at
    `).run(taskId, nextEpoch, attemptId, now);

    this.logger?.log({
      agentId,
      action: 'create_attempt',
      status: 'created',
      details: { attemptId, taskId, requestId: resolvedReqId, epoch: nextEpoch, attemptNumber }
    });

    return this.getAttempt(attemptId);
  }

  /**
   * Activate / acquire the attempt when execution starts
   */
  acquireAttempt(attemptId, agentId) {
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new Error(`Attempt '${attemptId}' not found.`);

    if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
      throw new Error(`Cannot acquire attempt '${attemptId}': already in terminal state '${attempt.state}'.`);
    }

    this.validateFencing({ taskId: attempt.taskId, attemptId, epoch: attempt.epoch, agentId });

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + attempt.leaseTimeoutMs).toISOString();

    this.db.prepare(`
      UPDATE bridge_attempts
      SET state = 'active', started_at = COALESCE(started_at, ?), heartbeat_at = ?, lease_expires_at = ?
      WHERE attempt_id = ?
    `).run(now, now, expiresAt, attemptId);

    return this.getAttempt(attemptId);
  }

  /**
   * Heartbeat renewal of attempt lease
   */
  touchAttempt(attemptId, epoch, agentId) {
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new Error(`Attempt '${attemptId}' not found.`);

    this.validateFencing({ taskId: attempt.taskId, attemptId, epoch, agentId });

    if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
      throw new Error(`Cannot heartbeat attempt '${attemptId}': already in terminal state '${attempt.state}'.`);
    }

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + attempt.leaseTimeoutMs).toISOString();

    this.db.prepare(`
      UPDATE bridge_attempts
      SET heartbeat_at = ?, lease_expires_at = ?
      WHERE attempt_id = ?
    `).run(now, expiresAt, attemptId);

    return { attemptId, epoch, renewed: true, expiresAt };
  }

  /**
   * CORE HARD INVARIANT: Monotonic epoch validation.
   * Stale or fenced attempt CAN NEVER produce protected effects.
   */
  validateFencing({ taskId, attemptId, epoch, agentId = null }) {
    const epochRow = this.db.prepare(`
      SELECT current_epoch, active_attempt_id FROM task_epochs WHERE task_id = ?
    `).get(taskId);

    if (!epochRow) {
      throw new Error(`Fencing Error: Task '${taskId}' has no active epoch record.`);
    }

    if (epoch !== epochRow.current_epoch) {
      const err = new Error(
        `FENCED_ATTEMPT_ERROR: Attempt '${attemptId}' with epoch ${epoch} has been superseded by current epoch ${epochRow.current_epoch}. Execution blocked.`
      );
      err.code = 'FENCED_ATTEMPT_ERROR';
      err.taskId = taskId;
      err.attemptId = attemptId;
      err.attemptEpoch = epoch;
      err.currentEpoch = epochRow.current_epoch;
      throw err;
    }

    if (epochRow.active_attempt_id !== attemptId) {
      const err = new Error(
        `FENCED_ATTEMPT_ERROR: Attempt '${attemptId}' is not the active attempt for task '${taskId}' (active is '${epochRow.active_attempt_id}').`
      );
      err.code = 'FENCED_ATTEMPT_ERROR';
      throw err;
    }

    const row = this.db.prepare(`SELECT state, agent_id FROM bridge_attempts WHERE attempt_id = ?`).get(attemptId);
    if (row && row.state === AttemptState.FENCED) {
      const err = new Error(`FENCED_ATTEMPT_ERROR: Attempt '${attemptId}' is marked FENCED.`);
      err.code = 'FENCED_ATTEMPT_ERROR';
      throw err;
    }

    if (agentId && row && row.agent_id !== agentId) {
      const err = new Error(`Attempt '${attemptId}' belongs to agent '${row.agent_id}', not '${agentId}'.`);
      err.code = 'IMPERSONATION_ERROR';
      throw err;
    }

    return { valid: true, currentEpoch: epochRow.current_epoch };
  }

  /**
   * Complete an attempt successfully
   */
  completeAttempt({ attemptId, epoch, result = null, correlationInfo = null }) {
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new Error(`Attempt '${attemptId}' not found.`);

    // If attempt has already been fenced or timed out, quarantine the late result!
    try {
      this.validateFencing({ taskId: attempt.taskId, attemptId, epoch, agentId: attempt.agentId });
    } catch (fencingErr) {
      this.quarantineLateResponse({
        attemptId,
        requestId: attempt.requestId,
        epoch,
        payload: result,
        reason: fencingErr.message
      });
      return {
        attemptId,
        status: AttemptState.QUARANTINED,
        quarantined: true,
        reason: fencingErr.message
      };
    }

    if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
      this.quarantineLateResponse({
        attemptId,
        requestId: attempt.requestId,
        epoch,
        payload: result,
        reason: `Late completion on terminal state ${attempt.state}`
      });
      return {
        attemptId,
        status: AttemptState.QUARANTINED,
        quarantined: true,
        reason: `Late completion on terminal state ${attempt.state}`
      };
    }

    const now = new Date().toISOString();
    const serializedResult = typeof result === 'object' && result !== null ? JSON.stringify(result) : result;
    const serializedCorr = typeof correlationInfo === 'object' && correlationInfo !== null ? JSON.stringify(correlationInfo) : correlationInfo;

    this.db.prepare(`
      UPDATE bridge_attempts
      SET state = 'completed', completed_at = ?, result = ?, correlation_info = ?
      WHERE attempt_id = ?
    `).run(now, serializedResult, serializedCorr, attemptId);

    this.logger?.log({
      agentId: attempt.agentId,
      action: 'complete_attempt',
      status: 'completed',
      details: { attemptId, taskId: attempt.taskId, epoch }
    });

    return this.getAttempt(attemptId);
  }

  /**
   * Fail an attempt
   */
  failAttempt({ attemptId, epoch, error }) {
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new Error(`Attempt '${attemptId}' not found.`);

    try {
      this.validateFencing({ taskId: attempt.taskId, attemptId, epoch, agentId: attempt.agentId });
    } catch {}

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE bridge_attempts
      SET state = 'failed', completed_at = ?, error = ?
      WHERE attempt_id = ?
    `).run(now, error, attemptId);

    this.logger?.log({
      agentId: attempt.agentId,
      action: 'fail_attempt',
      status: 'failed',
      details: { attemptId, taskId: attempt.taskId, epoch, error }
    });

    return this.getAttempt(attemptId);
  }

  /**
   * Quarantine a late or unauthorized response without mutating authoritative state
   */
  quarantineLateResponse({ attemptId, requestId, epoch, payload, reason }) {
    const qId = `quar_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const payloadStr = typeof payload === 'object' && payload !== null ? JSON.stringify(payload) : String(payload ?? '');

    this.db.prepare(`
      INSERT INTO bridge_quarantined_responses (
        quarantine_id, attempt_id, request_id, epoch, payload, reason, quarantined_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(qId, attemptId, requestId, epoch, payloadStr, reason, now);

    this.logger?.log({
      agentId: 'system',
      action: 'quarantine_late_response',
      status: 'quarantined',
      details: { quarantineId: qId, attemptId, requestId, epoch, reason }
    });

    return {
      quarantineId: qId,
      attemptId,
      requestId,
      reason,
      quarantinedAt: now
    };
  }

  /**
   * Sweep and fence expired leases
   */
  recoverExpiredAttempts() {
    const now = new Date().toISOString();
    const expired = this.db.prepare(`
      SELECT * FROM bridge_attempts
      WHERE state IN ('created', 'acquired', 'active') AND lease_expires_at < ?
    `).all(now);

    const recovered = [];
    for (const att of expired) {
      this.db.prepare(`
        UPDATE bridge_attempts
        SET state = 'timed_out', completed_at = ?, error = 'Attempt lease expired'
        WHERE attempt_id = ?
      `).run(now, att.attempt_id);

      recovered.push({ attemptId: att.attempt_id, taskId: att.task_id, epoch: att.epoch });
    }
    return recovered;
  }

  getAttempt(attemptId) {
    const row = this.db.prepare(`SELECT * FROM bridge_attempts WHERE attempt_id = ?`).get(attemptId);
    if (!row) return null;

    return {
      attemptId: row.attempt_id,
      requestId: row.request_id,
      taskId: row.task_id,
      attemptNumber: row.attempt_number,
      agentId: row.agent_id,
      routeId: row.route_id,
      epoch: row.epoch,
      nonce: row.nonce,
      grant: row.grant ? (() => { try { return JSON.parse(row.grant); } catch { return row.grant; } })() : null,
      worktreePath: row.worktree_path,
      state: row.state,
      leaseTimeoutMs: row.lease_timeout_ms,
      leaseExpiresAt: row.lease_expires_at,
      createdAt: row.created_at,
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
      completedAt: row.completed_at,
      result: row.result,
      error: row.error,
      correlationInfo: row.correlation_info
    };
  }

  getActiveAttemptForTask(taskId) {
    const epochRow = this.db.prepare(`
      SELECT active_attempt_id FROM task_epochs WHERE task_id = ?
    `).get(taskId);
    if (!epochRow?.active_attempt_id) return null;
    return this.getAttempt(epochRow.active_attempt_id);
  }

  listAttemptsForTask(taskId) {
    const rows = this.db.prepare(`
      SELECT attempt_id FROM bridge_attempts WHERE task_id = ? ORDER BY epoch ASC
    `).all(taskId);
    return rows.map(r => this.getAttempt(r.attempt_id));
  }

  getQuarantinedResponses(requestId = null) {
    let query = `SELECT * FROM bridge_quarantined_responses`;
    const params = [];
    if (requestId) {
      query += ` WHERE request_id = ?`;
      params.push(requestId);
    }
    query += ` ORDER BY quarantined_at DESC`;
    return this.db.prepare(query).all(...params);
  }
}
