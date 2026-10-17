import crypto from 'node:crypto';
import { TaskManager, runInImmediateTx } from './task-manager.js';
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
import { normalizeAgentId, canonicalizeTargetAgent, getAliasesFor } from './agent-identity.js';
import { isEffectfulTool } from './effects/effects-ledger.js';
import { CheapFirstRouter } from './routing/cheap-first-router.js';
import { SemanticCache } from './cache/semantic-cache.js';
import { CompletionEvidenceTier } from './control-plane/route-interface.js';
import { CONFIG } from './config.js';

export const CONFIDENCE_RANK = Object.freeze({
  UNKNOWN: 0,
  STABILITY_HEURISTIC: 1,
  INDICATOR_BASED: 2,
  EXPLICIT_END_OF_TURN: 3,
  AUTHENTICATED_SUBMIT: 4
});

export const TERMINAL_REQUEST_STATES = Object.freeze(new Set([
  'completed',
  'failed',
  'cancelled',
  'quarantined',
  'delivery_uncertain'
]));

export class MailboxHub {
  constructor(auditLogger, taskManager = null, eventBus = null, presenceManager = null) {
    this.logger = auditLogger;
    this.db = auditLogger?.db;
    this.eventBus = eventBus || new EventBus(auditLogger);
    this.presence = presenceManager || null;
    this.tasks = taskManager || new TaskManager(auditLogger, null, this.eventBus);
    if (!this.tasks.eventBus && this.eventBus) {
      this.tasks.eventBus = this.eventBus;
      if (this.tasks.outbox) {
        this.tasks.outbox.eventBus = this.eventBus;
      }
    }
    if (this.tasks) {
      this.tasks.mailboxHub = this;
    }
    this.maxPendingAgeMs = CONFIG?.MAX_PENDING_AGE_MS !== undefined ? CONFIG.MAX_PENDING_AGE_MS : (24 * 60 * 60 * 1000);
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
    this.cheapRouter = new CheapFirstRouter({ auditLogger });
    this.semanticCache = new SemanticCache();
    this._recoveryTimer = null;
    this._recoverySweepErrors = 0;
    this._ensureRequestColumns();
    if (this.db) {
      this.startRecoveryTimer(Number(process.env.AGENT_BRIDGE_RECOVERY_INTERVAL_MS) || 2000);
    }
  }

  get recoverySweepErrors() {
    return this._recoverySweepErrors;
  }

  _ensureRequestColumns() {
    if (this.db) {
      try {
        const reqCols = this.db.prepare(`PRAGMA table_info(bridge_requests)`).all();
        const colNames = new Set(reqCols.map(c => c.name));
        if (!colNames.has('claimed_by')) {
          this.db.exec(`ALTER TABLE bridge_requests ADD COLUMN claimed_by TEXT;`);
        }
        if (!colNames.has('lease_expires_at')) {
          this.db.exec(`ALTER TABLE bridge_requests ADD COLUMN lease_expires_at TEXT;`);
        }
        if (!colNames.has('attempt_id')) {
          this.db.exec(`ALTER TABLE bridge_requests ADD COLUMN attempt_id TEXT;`);
        }
        if (!colNames.has('epoch')) {
          this.db.exec(`ALTER TABLE bridge_requests ADD COLUMN epoch INTEGER;`);
        }
        if (!colNames.has('submitted_to_provider')) {
          this.db.exec(`ALTER TABLE bridge_requests ADD COLUMN submitted_to_provider INTEGER DEFAULT 0;`);
        }
        if (!colNames.has('delivery_state')) {
          this.db.exec(`ALTER TABLE bridge_requests ADD COLUMN delivery_state TEXT;`);
        }
        if (!colNames.has('is_idempotent')) {
          this.db.exec(`ALTER TABLE bridge_requests ADD COLUMN is_idempotent INTEGER DEFAULT 0;`);
        }
        if (!colNames.has('nonce')) {
          this.db.exec(`ALTER TABLE bridge_requests ADD COLUMN nonce TEXT;`);
        }
      } catch  {
      // swallow-ok: DDL schema idempotency check
    }
    }
  }

  claimTask(taskId, agentId) {
    return this.tasks.claimTask(taskId, agentId);
  }

  claimRequest({ requestId, agentId, workerId = null, leaseMs = 30000 }) {
    if (!requestId) throw new Error('requestId is required');
    if (!agentId) throw new Error('agentId is required');
    const claimerId = workerId || agentId;
    this._ensureRequestColumns();

    let reqRow = null;
    try {
      reqRow = this.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(requestId);
    } catch  {
      // swallow-ok: optional record lookup fallback
    }

    if (!reqRow) {
      if (this.tasks) {
        let taskIdCandidate = null;
        if (requestId.startsWith('req_task_')) {
          const stripped = requestId.slice('req_task_'.length);
          taskIdCandidate = stripped.startsWith('task_') ? stripped : `task_${stripped}`;
        } else if (requestId.startsWith('task_')) {
          taskIdCandidate = requestId;
        }
        if (taskIdCandidate) {
          const taskRow = this.tasks.getTask(taskIdCandidate, false);
          if (taskRow) {
            try {
              const claimedTask = this.tasks.claimTask(taskRow.id, agentId);
              return {
                claimed: true,
                requestId,
                taskId: taskRow.id,
                attemptId: claimedTask.attemptId,
                epoch: claimedTask.epoch,
                claimedBy: claimerId,
                leaseExpiresAt: claimedTask.leaseExpiresAt || new Date(Date.now() + leaseMs).toISOString()
              };
            } catch (tClaimErr) {
              return { claimed: false, error: tClaimErr.message };
            }
          }
        }
      }
      return { claimed: false, error: 'REQUEST_NOT_FOUND' };
    }

    if (reqRow.to_agent && reqRow.to_agent !== '*' && agentId.toLowerCase() !== reqRow.to_agent.toLowerCase()) {
      return { claimed: false, error: 'WRONG_AGENT', expected: reqRow.to_agent, actual: agentId };
    }

    if (TERMINAL_REQUEST_STATES.has(reqRow.status)) {
      return { claimed: false, error: 'REQUEST_ALREADY_TERMINAL', status: reqRow.status };
    }

    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();

    // Check if currently actively claimed by a DIFFERENT worker with valid lease
    if (reqRow.status === 'in_progress' || reqRow.status === 'claimed') {
      if (reqRow.lease_expires_at && reqRow.lease_expires_at > now && reqRow.claimed_by && reqRow.claimed_by !== claimerId) {
        return {
          claimed: false,
          error: 'LEASE_ACTIVE',
          claimedBy: reqRow.claimed_by,
          leaseExpiresAt: reqRow.lease_expires_at
        };
      }
    }

    let attemptId = null;
    let epoch = 1;
    let nonce = null;

    // If backing task exists, integrate with TaskManager attempt tracking
    if (reqRow.task_id && this.tasks) {
      try {
        const claimedTask = this.tasks.claimTask(reqRow.task_id, agentId);
        if (claimedTask) {
          attemptId = claimedTask.attemptId || null;
          epoch = claimedTask.epoch || 1;
          nonce = claimedTask.nonce || null;
        } else if (this.tasks.attempts) {
          const att = this.tasks.attempts.createAttempt({
            taskId: reqRow.task_id,
            agentId,
            routeId: 'claim_request'
          });
          this.tasks.attempts.acquireAttempt(att.attemptId, agentId);
          attemptId = att.attemptId;
          epoch = att.epoch;
          nonce = att.nonce;
        }
      } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }
    }

    if (!attemptId) {
      attemptId = `req_att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      epoch = (reqRow.epoch || 0) + 1;
    }
    if (!nonce) {
      nonce = `non_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }

    // Atomic conditional update on bridge_requests
    let updatedRow = null;
    try {
      const updateStmt = this.db.prepare(`
        UPDATE bridge_requests
        SET status = 'in_progress',
            claimed_by = ?,
            lease_expires_at = ?,
            attempt_id = ?,
            epoch = ?,
            nonce = ?,
            updated_at = ?
        WHERE request_id = ?
          AND (
            status = 'pending'
            OR (status IN ('claimed', 'in_progress') AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR claimed_by = ?))
          )
      `);
      const res = updateStmt.run(claimerId, leaseExpiresAt, attemptId, epoch, nonce, now, requestId, now, claimerId);
      if (res.changes === 0) {
        return { claimed: false, error: 'CONCURRENT_CLAIM_LOST' };
      }
      updatedRow = this.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(requestId);
    } catch (err) {
      return { claimed: false, error: err.message };
    }

    return {
      claimed: true,
      requestId,
      taskId: reqRow.task_id,
      attemptId,
      epoch,
      nonce,
      claimedBy: claimerId,
      leaseExpiresAt,
      request: updatedRow
    };
  }

  touchRequest({ requestId, workerId = null, leaseMs = 30000 }) {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    try {
      const stmt = workerId
        ? this.db.prepare(`
            UPDATE bridge_requests
            SET lease_expires_at = ?, updated_at = ?
            WHERE request_id = ? AND claimed_by = ? AND status IN ('claimed', 'in_progress')
          `)
        : this.db.prepare(`
            UPDATE bridge_requests
            SET lease_expires_at = ?, updated_at = ?
            WHERE request_id = ? AND status IN ('claimed', 'in_progress')
          `);
      const res = workerId ? stmt.run(leaseExpiresAt, now, requestId, workerId) : stmt.run(leaseExpiresAt, now, requestId);
      return res.changes > 0;
    } catch {
      return false;
    }
  }

  markPromptSubmitted(requestId) {
    if (!requestId || !this.db) return false;
    this._ensureRequestColumns();
    const now = new Date().toISOString();
    try {
      const res = this.db.prepare(`
        UPDATE bridge_requests
        SET submitted_to_provider = 1,
            delivery_state = 'PROMPT_SUBMITTED',
            updated_at = ?
        WHERE request_id = ? AND status IN ('claimed', 'in_progress')
      `).run(now, requestId);
      return res.changes > 0;
    } catch {
      return false;
    }
  }

  markPromptSettled(requestId) {
    if (!requestId || !this.db) return false;
    this._ensureRequestColumns();
    const now = new Date().toISOString();
    try {
      const res = this.db.prepare(`
        UPDATE bridge_requests
        SET submitted_to_provider = 0,
            delivery_state = 'SETTLED',
            updated_at = ?
        WHERE request_id = ?
      `).run(now, requestId);
      return res.changes > 0;
    } catch {
      return false;
    }
  }

  recoverExpiredRequests(agentIdOrOpts = null) {
    if (!this.db) return { changes: 0, recovered: [], uncertain: [], expiredPending: [] };
    this._ensureRequestColumns();
    const now = new Date().toISOString();
    const recovered = [];
    const uncertain = [];
    const expiredPending = [];

    let agentId = null;
    let maxPendingAgeMs = this.maxPendingAgeMs;
    if (typeof agentIdOrOpts === 'object' && agentIdOrOpts !== null) {
      agentId = agentIdOrOpts.agentId || null;
      if (agentIdOrOpts.maxPendingAgeMs !== undefined) {
        maxPendingAgeMs = agentIdOrOpts.maxPendingAgeMs;
      }
    } else if (typeof agentIdOrOpts === 'string') {
      agentId = agentIdOrOpts;
    }

    try {
      runInImmediateTx(this.db, () => {
        let query = `
          SELECT * FROM bridge_requests
          WHERE status IN ('claimed', 'in_progress')
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at < ?
        `;
        const params = [now];
        if (agentId) {
          const canonicalAgentId = canonicalizeTargetAgent(agentId, { required: false }) || normalizeAgentId(agentId);
          const candidates = getAliasesFor(canonicalAgentId);
          const placeholders = candidates.map(() => '?').join(', ');
          query += ` AND to_agent IN (${placeholders})`;
          params.push(...candidates);
        }

        const rows = this.db.prepare(query).all(...params);
        for (const row of rows) {
          let isIdempotent = Boolean(row.is_idempotent);
          if (!isIdempotent && row.context) {
            try {
              const parsedCtx = typeof row.context === 'string' ? JSON.parse(row.context) : row.context;
              if (parsedCtx?.isIdempotent === true || parsedCtx?.originalContext?.isIdempotent === true) {
                isIdempotent = true;
              }
            } catch  {
      // swallow-ok: safe fallback for plaintext or non-JSON input
    }
          }

          const nextEpoch = (row.epoch || 1) + 1;

          if (row.submitted_to_provider || row.delivery_state === 'PROMPT_SUBMITTED') {
            if (!isIdempotent) {
              const errorMsg = `DELIVERY_UNCERTAIN: Worker lease expired after prompt was submitted to provider. Blind re-injection denied because request is not declared idempotent.`;
              const res = this.db.prepare(`
                UPDATE bridge_requests
                SET status = 'delivery_uncertain',
                    delivery_state = 'DELIVERY_UNCERTAIN',
                    error = ?,
                    epoch = ?,
                    claimed_by = NULL,
                    lease_expires_at = NULL,
                    updated_at = ?
                WHERE request_id = ? AND status IN ('claimed', 'in_progress')
              `).run(errorMsg, nextEpoch, now, row.request_id);

              if (res.changes > 0) {
                uncertain.push({ requestId: row.request_id, epoch: nextEpoch, error: errorMsg });
                if (row.task_id) {
                  try {
                    this.db.prepare(`
                      UPDATE tasks
                      SET status = 'delivery_uncertain',
                          error = ?,
                          updated_at = ?
                      WHERE id = ? AND status IN ('claimed', 'in_progress')
                    `).run(errorMsg, now, row.task_id);

                    this.db.prepare(`
                      UPDATE task_epochs
                      SET active_attempt_id = NULL,
                          updated_at = ?
                      WHERE task_id = ?
                    `).run(now, row.task_id);
                  } catch {
                    // swallow-ok
                  }
                }
                this.logger?.log?.({
                  agentId: row.to_agent || 'system',
                  action: 'request_delivery_uncertain',
                  status: 'delivery_uncertain',
                  details: { requestId: row.request_id, epoch: nextEpoch, reason: errorMsg }
                });
              }
              continue;
            }
          }

          const res = this.db.prepare(`
            UPDATE bridge_requests
            SET status = 'pending',
                delivery_state = 'RECOVERED_PENDING',
                submitted_to_provider = 0,
                claimed_by = NULL,
                lease_expires_at = NULL,
                epoch = ?,
                updated_at = ?
            WHERE request_id = ? AND status IN ('claimed', 'in_progress')
          `).run(nextEpoch, now, row.request_id);

          if (res.changes > 0) {
            recovered.push({ requestId: row.request_id, epoch: nextEpoch });
            if (row.task_id) {
              try {
                this.db.prepare(`
                  UPDATE tasks
                  SET status = 'pending',
                      updated_at = ?
                  WHERE id = ? AND status IN ('claimed', 'in_progress')
                `).run(now, row.task_id);

                this.db.prepare(`
                  UPDATE task_epochs
                  SET active_attempt_id = NULL,
                      updated_at = ?
                  WHERE task_id = ?
                `).run(now, row.task_id);
              } catch {
                // swallow-ok
              }
            }
            this.logger?.log?.({
              agentId: row.to_agent || 'system',
              action: 'recover_expired_request',
              status: 'pending',
              details: { requestId: row.request_id, epoch: nextEpoch }
            });
          }
        }

        // 2. Expire stale pending requests that were never claimed (AR-03)
        if (typeof maxPendingAgeMs === 'number' && maxPendingAgeMs > 0) {
          const cutoffIso = new Date(Date.now() - maxPendingAgeMs).toISOString();
          let pendingQuery = `
            SELECT * FROM bridge_requests
            WHERE status = 'pending'
              AND created_at IS NOT NULL
              AND created_at < ?
          `;
          const pendingParams = [cutoffIso];
          if (agentId) {
            const canonicalAgentId = canonicalizeTargetAgent(agentId, { required: false }) || normalizeAgentId(agentId);
            const candidates = getAliasesFor(canonicalAgentId);
            const placeholders = candidates.map(() => '?').join(', ');
            pendingQuery += ` AND to_agent IN (${placeholders})`;
            pendingParams.push(...candidates);
          }

          const staleRows = this.db.prepare(pendingQuery).all(...pendingParams);
          for (const row of staleRows) {
            const errorMsg = `TARGET_UNREACHABLE: Request expired in pending state without being claimed after ${maxPendingAgeMs}ms (created at ${row.created_at}).`;
            const res = this.db.prepare(`
              UPDATE bridge_requests
              SET status = 'failed',
                  delivery_state = 'PENDING_EXPIRED',
                  error = ?,
                  updated_at = ?
              WHERE request_id = ? AND status = 'pending'
            `).run(errorMsg, now, row.request_id);

            if (res.changes > 0) {
              expiredPending.push({ requestId: row.request_id, error: errorMsg, createdAt: row.created_at });
              this.logger?.log?.({
                agentId: row.to_agent || 'system',
                action: 'pending_request_expired',
                status: 'failed',
                details: {
                  requestId: row.request_id,
                  fromAgent: row.from_agent,
                  toAgent: row.to_agent,
                  createdAt: row.created_at,
                  reason: errorMsg,
                  code: 'TARGET_UNREACHABLE'
                }
              });

              if (this.eventBus?.publish) {
                try {
                  this.eventBus.publish({
                    type: 'request:failed',
                    requestId: row.request_id,
                    fromAgent: row.from_agent,
                    toAgent: row.to_agent,
                    status: 'failed',
                    error: errorMsg,
                    errorCode: 'TARGET_UNREACHABLE'
                  });
                } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }
              }
            }
          }
        }
      });
    } catch (err) {
      this.logger?.debug?.('Error in recoverExpiredRequests', err);
      throw err;
    }

    const totalChanges = recovered.length + uncertain.length + expiredPending.length;
    return { changes: totalChanges, recovered, uncertain, expiredPending };
  }

  startRecoveryTimer(intervalMs = 2000) {
    if (this._recoveryTimer) return this._recoveryTimer;
    try {
      this.runRecoverySweep();
    } catch (err) {
      // already recorded in runRecoverySweep
    }

    this._recoveryTimer = setInterval(() => {
      try {
        this.runRecoverySweep();
      } catch (err) {
        // already recorded in runRecoverySweep
      }
    }, intervalMs);

    if (this._recoveryTimer.unref) {
      this._recoveryTimer.unref();
    }
    return this._recoveryTimer;
  }

  stopRecoveryTimer() {
    if (this._recoveryTimer) {
      clearInterval(this._recoveryTimer);
      this._recoveryTimer = null;
    }
  }

  runRecoverySweep() {
    try {
      const sweep = {
        requests: this.recoverExpiredRequests(),
        tasks: this.tasks?.recoverExpiredTasks ? this.tasks.recoverExpiredTasks() : [],
        attempts: (this.tasks?.attempts?.recoverExpiredAttempts) ? this.tasks.attempts.recoverExpiredAttempts() : []
      };
      return sweep;
    } catch (err) {
      this._recoverySweepErrors++;
      this.logger?.log?.({
        agentId: 'system',
        action: 'recovery_sweep_error',
        status: 'error',
        details: { error: err?.message || String(err) }
      });
      throw err;
    }
  }

  close() {
    this.stopRecoveryTimer();
    if (this.tasks?.close) {
      try { this.tasks.close(); } catch  {
      // swallow-ok: best-effort disposal cleanup
    }
    }
  }

  async askAgentAsync(options) {
    return this.askAgent({ ...options, asyncMode: true });
  }

  async waitForResponse(requestId, timeoutMs = 90000) {
    return this.eventBus.waitForResponse({ requestId, timeoutMs });
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
    const normTo = canonicalizeTargetAgent(toAgent, { required: true });

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
    const normTo = canonicalizeTargetAgent(toAgent, { required: true });

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
        } catch  {
      // swallow-ok: optional record lookup fallback
    }
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

  _resolveModelCounters(tokenMetrics, responseMode) {
    if (!tokenMetrics) {
      return {
        additionalModelCalls: null,
        additionalModelCallsReason: 'UNMEASURED_NO_TOKEN_METRICS',
        modelRegenerationTokens: null,
        modelRegenerationTokensReason: 'UNMEASURED_NO_TOKEN_METRICS'
      };
    }

    const isDirect = (responseMode === ResponseMode.DIRECT || responseMode === 'direct');
    const additionalModelCalls = tokenMetrics.savings?.directDeliveryBypassedModelCall
      ? 0
      : (tokenMetrics.categories?.D_receivingAgentReasoning > 0 ? 1 : (isDirect ? 0 : null));

    const modelRegenerationTokens = tokenMetrics.categories?.E_receivingAgentRegeneration !== undefined
      ? tokenMetrics.categories.E_receivingAgentRegeneration
      : (isDirect ? 0 : null);

    return {
      additionalModelCalls,
      additionalModelCallsReason: additionalModelCalls === null ? 'UNMEASURED_POST_PROCESSING' : null,
      modelRegenerationTokens,
      modelRegenerationTokensReason: modelRegenerationTokens === null ? 'UNMEASURED_POST_PROCESSING' : null
    };
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
    responseMode = null,
    isIdempotent = false
  }) {
    const normFrom = normalizeAgentId(fromAgent) || fromAgent;

    let resolvedTo = null;
    if (toAgent) {
      try {
        resolvedTo = canonicalizeTargetAgent(toAgent, { required: true });
      } catch (err) {
        return {
          mode: 'request_failed',
          fromAgent: normFrom,
          toAgent,
          requestId: requestId || `req_unknown_target_${Date.now()}`,
          conversationId,
          taskId: null,
          question,
          status: 'failed',
          error: err.message,
          errorCode: err.code || 'UNKNOWN_AGENT_ID'
        };
      }
    }

    if (fromAgent && normFrom !== fromAgent) {
      this.logger?.log?.({
        agentId: normFrom,
        action: 'agent_alias_normalized',
        status: 'info',
        details: { raw: fromAgent, normalized: normFrom, context: 'askAgent.fromAgent' }
      });
    }
    if (toAgent && resolvedTo !== toAgent) {
      this.logger?.log?.({
        agentId: resolvedTo,
        action: 'agent_alias_normalized',
        status: 'info',
        details: { raw: toAgent, normalized: resolvedTo, context: 'askAgent.toAgent' }
      });
    }

    if (!resolvedTo && this.cheapRouter && this.cheapRouter.enabled) {
      const decision = this.cheapRouter.selectAgent({ toAgent: null, type: arguments[0]?.taskType }, ['gemini', 'freebuff', 'claude-desktop']);
      if (decision?.selectedAgent) {
        resolvedTo = decision.selectedAgent;
      }
    }

    if (!resolvedTo) {
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

    const normTo = resolvedTo;

    // Semantic read-only query cache (strictly opt-in, disabled by default)
    if (this.semanticCache && this.semanticCache.enabled && this.semanticCache.isCacheable('READ', question)) {
      const hit = this.semanticCache.get(question);
      if (hit && hit.hit) {
        return {
          mode: 'direct',
          fromAgent: normFrom,
          toAgent: resolvedTo,
          requestId: requestId || `req_cache_${Date.now()}`,
          conversationId,
          taskId: null,
          question,
          status: 'completed',
          cached: true,
          response: hit.response,
          result: { response: hit.response, cached: true }
        };
      }
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
        completionConfidence: 'EXPLICIT_END_OF_TURN',
        ...this._resolveModelCounters(tokenMetrics, resolvedMode),
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
      } catch  {
      // swallow-ok: optional record lookup fallback
    }
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
          completionConfidence: artifact?.executionMetadata?.completionConfidence || 'UNKNOWN',
          ...this._resolveModelCounters(tokenMetrics, reqMode),
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
          completionConfidence: outcome?.completionConfidence || artifact?.executionMetadata?.completionConfidence || 'UNKNOWN',
          ...this._resolveModelCounters(tokenMetrics, reqMode),
          timestamp: outcome.completedAt || new Date().toISOString()
        };
      } else if (outcome.status === 'timeout') {
        const isAgentOnline = this.presence && typeof this.presence.isAgentOnline === 'function'
          ? this.presence.isAgentOnline(existingReq.to_agent)
          : true;
        let timeoutReason = 'REMOTE_EXECUTION_TIMEOUT';
        if (!isAgentOnline) {
          timeoutReason = 'REMOTE_AGENT_OFFLINE';
        } else {
          const curTask = this.tasks ? this.tasks.getTask(existingReq.task_id, false) : null;
          if (curTask?.status === 'completed') {
            timeoutReason = 'DELIVERY_PENDING';
          } else if (curTask?.status === 'in_progress' || curTask?.status === 'claimed') {
            timeoutReason = 'REMOTE_STILL_EXECUTING';
          } else if (curTask?.status === 'pending') {
            timeoutReason = 'DISPATCH_PENDING_UNCLAIMED';
          }
        }

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
          timeoutReason,
          remoteAgentOnline: isAgentOnline,
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

      const isIdempotentReq = Boolean(isIdempotent || context?.isIdempotent);
      if (isIdempotentReq) {
        try {
          targetDb.prepare(`UPDATE bridge_requests SET is_idempotent = 1 WHERE request_id = ?`).run(reqId);
        } catch  {
      // swallow-ok: optional record lookup fallback
    }
      }

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
    const questionBytes = Buffer.byteLength(question || '', 'utf8');
    const estTokensIn = Math.ceil(questionBytes / 4);
    this.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.REQUEST_CREATED,
      taskId: task ? task.id : null,
      agentId: normTo,
      meta: {
        fromAgent: normFrom,
        toAgent: normTo,
        conversationId: convId,
        asyncMode,
        bodySizeBytes: questionBytes,
        tokensIn: estTokensIn,
        toolSchemaOverheadTokens: 6740
      }
    });
    if (task) {
      this.tracer.mark({
        requestId: reqId,
        stage: LifecycleStage.TASK_CREATED,
        taskId: task.id,
        agentId: normTo,
        meta: { fromAgent: normFrom, toAgent: normTo, bodySizeBytes: questionBytes }
      });
    }

    // If explicit asynchronous mode requested, return immediately with correlation IDs
    if (asyncMode) {
      return {
        mode: 'queued_in_mailbox',
        deliveryState: 'queued-awaiting-pull',
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
    if (outcome.status === 'timeout' || outcome.timedOut) {
      this.tracer.mark({
        requestId: reqId,
        stage: LifecycleStage.TIMEOUT,
        taskId: task ? task.id : null,
        agentId: normFrom,
        meta: { outcome: 'timeout', timeoutMs, error: outcome.error }
      });
    } else if (outcome.status === 'failed') {
      this.tracer.mark({
        requestId: reqId,
        stage: LifecycleStage.FAILED,
        taskId: task ? task.id : null,
        agentId: normFrom,
        meta: { outcome: 'failed', error: outcome.error }
      });
    } else {
      const respBytes = Buffer.byteLength(outcome.response || '', 'utf8');
      this.tracer.mark({
        requestId: reqId,
        stage: LifecycleStage.RESPONSE_RETURNED,
        taskId: task ? task.id : null,
        agentId: normFrom,
        meta: { outcome: outcome.status, tokensOut: Math.ceil(respBytes / 4), bodySizeBytes: respBytes }
      });
    }

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
        completionConfidence: outcome?.completionConfidence || artifact?.executionMetadata?.completionConfidence || 'UNKNOWN',
        ...this._resolveModelCounters(tokenMetrics, resolvedMode),
        timestamp: outcome.completedAt || new Date().toISOString()
      };
    } else if (outcome.status === 'timeout') {
      const isAgentOnline = this.presence && typeof this.presence.isAgentOnline === 'function'
        ? this.presence.isAgentOnline(normTo)
        : true;
      let timeoutReason = 'REMOTE_EXECUTION_TIMEOUT';
      if (!isAgentOnline) {
        timeoutReason = 'REMOTE_AGENT_OFFLINE';
      } else {
        const curTask = this.tasks ? this.tasks.getTask(task.id, false) : null;
        if (curTask?.status === 'completed') {
          timeoutReason = 'DELIVERY_PENDING';
        } else if (curTask?.status === 'in_progress' || curTask?.status === 'claimed') {
          timeoutReason = 'REMOTE_STILL_EXECUTING';
        } else if (curTask?.status === 'pending') {
          timeoutReason = 'DISPATCH_PENDING_UNCLAIMED';
        }
      }

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
        timeoutReason,
        remoteAgentOnline: isAgentOnline,
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
  submitTaskResult({
    taskId,
    agentId,
    status = 'completed',
    result = null,
    error = null,
    attemptId = null,
    epoch = null,
    nonce = null,
    completionConfidence = null,
    observedSignals = null,
    stableTicks = null,
    graceRecheck = null
  }) {
    let updated = null;
    let lifecycle = null;

    // Confidence and side-effects gating for tasks
    if (status === 'completed') {
      const existingTask = this.tasks?.getTask ? this.tasks.getTask(taskId, false) : null;
      let ctxObj = null;
      if (existingTask?.context) {
        try {
          ctxObj = typeof existingTask.context === 'string' ? JSON.parse(existingTask.context) : existingTask.context;
        } catch  {
      // swallow-ok: safe fallback for plaintext or non-JSON input
    }
      }
      const hasSideEffects = Boolean(
        existingTask?.hasSideEffects ||
        ctxObj?.hasSideEffects ||
        ctxObj?.originalContext?.hasSideEffects ||
        (ctxObj?.tool && isEffectfulTool(ctxObj.tool)) ||
        (ctxObj?.originalContext?.tool && isEffectfulTool(ctxObj.originalContext.tool)) ||
        (existingTask?.tool && isEffectfulTool(existingTask.tool))
      );
      const reqConfidence = existingTask?.requiredConfidence || ctxObj?.requiredConfidence || ctxObj?.originalContext?.requiredConfidence || (hasSideEffects ? 'INDICATOR_BASED' : null);
      const effectiveConfidence = completionConfidence || 'UNKNOWN';

      const CONFIDENCE_RANK = {
        'UNKNOWN': 0,
        'STABILITY_HEURISTIC': 1,
        'INDICATOR_BASED': 2,
        'EXPLICIT_END_OF_TURN': 3,
        'AUTHENTICATED_SUBMIT': 4
      };

      if (hasSideEffects && (effectiveConfidence === 'STABILITY_HEURISTIC' || effectiveConfidence === 'UNKNOWN')) {
        const errMsg = `INSUFFICIENT_COMPLETION_CONFIDENCE: ${effectiveConfidence} completions are not accepted for tasks with side effects.`;
        return this.submitTaskResult({
          taskId,
          agentId,
          status: 'failed',
          error: errMsg,
          attemptId,
          epoch
        });
      }

      if (reqConfidence && (CONFIDENCE_RANK[effectiveConfidence] || 0) < (CONFIDENCE_RANK[reqConfidence] || 0)) {
        const errMsg = `INSUFFICIENT_COMPLETION_CONFIDENCE: Task requires '${reqConfidence}' but observed confidence was '${effectiveConfidence}'.`;
        return this.submitTaskResult({
          taskId,
          agentId,
          status: 'failed',
          error: errMsg,
          attemptId,
          epoch
        });
      }

      if (effectiveConfidence === 'AUTHENTICATED_SUBMIT') {
        if (!attemptId || epoch === null || epoch === undefined || !nonce) {
          const errMsg = 'AUTHENTICATED_SUBMIT_REJECTED: Recipient submit requires valid attemptId, epoch, and nonce tokens.';
          if (this.tasks?.attempts) {
            try {
              this.tasks.attempts.quarantineLateResponse({
                attemptId: attemptId || `missing_${taskId}`,
                requestId: taskId,
                epoch: Number(epoch) || 0,
                payload: result || error,
                reason: errMsg
              });
            } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }
          }
          return {
            status: 'quarantined',
            quarantined: true,
            taskId,
            error: errMsg
          };
        }
        if (this.tasks?.attempts && attemptId) {
          try {
            const att = this.tasks.attempts.getAttempt(attemptId);
            if (att && att.nonce && att.nonce !== nonce) {
              const errMsg = `AUTHENTICATED_SUBMIT_REJECTED: Cryptographic nonce mismatch for attempt '${attemptId}'.`;
              this.tasks.attempts.quarantineLateResponse({
                attemptId,
                requestId: taskId,
                epoch: Number(epoch) || 0,
                payload: result || error,
                reason: errMsg
              });
              return {
                status: 'quarantined',
                quarantined: true,
                taskId,
                error: errMsg
              };
            }
          } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }
        }
      }
    }

    let effectiveConfidence = completionConfidence || 'UNKNOWN';
    let effectiveEvidence = null;
    if (status === 'completed' && attemptId && epoch !== null && epoch !== undefined) {
      effectiveConfidence = CompletionEvidenceTier.AUTHENTICATED_SUBMIT;
      effectiveEvidence = CompletionEvidenceTier.AUTHENTICATED_SUBMIT;
    }

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
      } catch  {
      // swallow-ok: optional record lookup fallback
    }

      let requestId = reqRow?.request_id;
      let conversationId = reqRow?.conversation_id;

      if (!requestId && task?.context) {
        try {
          const ctxObj = typeof task.context === 'string' ? JSON.parse(task.context) : task.context;
          requestId = ctxObj?.requestId;
          conversationId = ctxObj?.conversationId;
        } catch  {
      // swallow-ok: safe fallback for plaintext or non-JSON input
    }
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
          // Idempotency invariant: terminal requests cannot be re-settled or double-count tokens/events
          return;
        } else {
          try {
            targetDb.prepare(`
              UPDATE bridge_requests
              SET status = ?, response = ?, error = ?, updated_at = ?, completed_at = ?, completion_evidence = COALESCE(?, completion_evidence)
              WHERE request_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
            `).run(status, resultStr, error, now, now, effectiveConfidence, requestId);
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
              originRoute: 'task_mailbox',
              completionConfidence: effectiveConfidence,
              completionEvidence: effectiveEvidence || effectiveConfidence,
              observedSignals: observedSignals || (effectiveEvidence ? [effectiveEvidence] : null),
              stableTicks: stableTicks || null,
              graceRecheck: graceRecheck || null,
              isHeuristic: effectiveConfidence === 'STABILITY_HEURISTIC'
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
        const respBytes = Buffer.byteLength(resultStr || '', 'utf8');
        const estTokensOut = Math.ceil(respBytes / 4);
        this.tracer.mark({
          requestId,
          stage: LifecycleStage.RESULT_PERSISTED,
          taskId,
          attemptId,
          agentId,
          meta: {
            status,
            tokensOut: estTokensOut,
            bodySizeBytes: respBytes,
            completionType: effectiveConfidence,
            evidenceTier: effectiveEvidence || effectiveConfidence,
            completionEvidence: effectiveEvidence || (observedSignals ? Array.from(observedSignals).join(',') : null)
          }
        });
      }

      const recipient = task ? task.creator : (reqRow ? reqRow.from_agent : '*');
      const snippet = resultStr ? (resultStr.length > 100 ? resultStr.slice(0, 100) + '...' : resultStr) : null;

      if (stageEventFn) {
        if (requestId) {
          const eventType = status === 'completed' ? 'response_ready' : 'response_failed';
          stageEventFn({
            type: eventType,
            agentId: recipient,
            fromAgent: agentId,
            conversationId: conversationId || `conv_task_${taskId}`,
            requestId,
            taskId,
            status,
            payload: {
              snippet,
              status,
              error: error ? (error.length > 80 ? error.slice(0, 80) + '...' : error) : null,
              completionConfidence: effectiveConfidence,
              isHeuristic: effectiveConfidence === 'STABILITY_HEURISTIC',
              observedSignals: observedSignals || null,
              stableTicks: stableTicks || null,
              graceRecheck: graceRecheck || null
            },
            dedupKey: `resp_ready_${requestId}_${status}`
          });
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
              error: error ? (error.length > 80 ? error.slice(0, 80) + '...' : error) : null,
              completionConfidence: effectiveConfidence,
              isHeuristic: effectiveConfidence === 'STABILITY_HEURISTIC',
              observedSignals: observedSignals || null,
              stableTicks: stableTicks || null,
              graceRecheck: graceRecheck || null
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
              error: error ? (error.length > 80 ? error.slice(0, 80) + '...' : error) : null,
              completionConfidence: effectiveConfidence,
              isHeuristic: effectiveConfidence === 'STABILITY_HEURISTIC',
              observedSignals: observedSignals || null,
              stableTicks: stableTicks || null,
              graceRecheck: graceRecheck || null
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
    const claimed = this.tasks.claimNextTask(norm);
    if (claimed && this.tracer) {
      let reqId = null;
      if (claimed.context) {
        try {
          const ctxObj = typeof claimed.context === 'string' ? JSON.parse(claimed.context) : claimed.context;
          reqId = ctxObj?.requestId;
        } catch  {
      // swallow-ok: safe fallback for plaintext or non-JSON input
    }
      }
      this.tracer.mark({
        requestId: reqId || `req_${claimed.id}`,
        stage: LifecycleStage.TASK_CLAIMED,
        taskId: claimed.id,
        agentId: norm,
        attemptId: claimed.attemptId || null
      });
    }
    return claimed;
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

  cancelRequest(arg1, arg2 = null, arg3 = 'Request cancelled') {
    const { requestId, agentId, reason } = typeof arg1 === 'object' && arg1 !== null
      ? { requestId: arg1.requestId, agentId: arg1.agentId, reason: arg1.reason || 'Request cancelled' }
      : { requestId: arg1, agentId: arg2, reason: arg3 || 'Request cancelled' };
    if (!requestId) throw new Error('requestId is required');
    const reqRow = this.db?.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(requestId);
    if (!reqRow) throw new Error(`Request not found: ${requestId}`);
    if (reqRow.task_id) {
      return this.cancelTask({ taskId: reqRow.task_id, agentId, reason });
    }
    const now = new Date().toISOString();
    this.db?.prepare(`
      UPDATE bridge_requests
      SET status = 'cancelled', error = ?, updated_at = ?, completed_at = ?
      WHERE request_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
    `).run(reason, now, now, requestId);
    return this.getRequest(requestId, { agentId, isPrivileged: true });
  }

  acknowledgeDelivery({ requestId, agentId = null, clientTimestamp = null }) {
    if (!requestId || typeof requestId !== 'string') {
      throw new Error('requestId is required to acknowledge delivery.');
    }
    const row = this.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(requestId);
    if (!row) {
      throw new Error(`Request '${requestId}' not found.`);
    }

    const normCaller = agentId ? (normalizeAgentId(agentId) || agentId) : null;
    const now = new Date().toISOString();

    if (this.tracer) {
      this.tracer.mark({
        requestId,
        stage: LifecycleStage.DELIVERY_ACKNOWLEDGED,
        taskId: row.task_id,
        agentId: normCaller || row.from_agent,
        meta: {
          acknowledgedBy: normCaller || row.from_agent,
          clientTimestamp,
          status: row.status
        }
      });
    }

    try {
      this.db.prepare(`
        UPDATE bridge_requests
        SET delivery_acknowledged_at = ?, updated_at = ?
        WHERE request_id = ?
      `).run(now, now, requestId);
    } catch  {
      // swallow-ok: optional record lookup fallback
    }

    this.logger?.log?.({
      agentId: normCaller || row.from_agent,
      action: 'delivery_acknowledged',
      status: 'success',
      details: { requestId, taskId: row.task_id, clientTimestamp }
    });

    return {
      requestId,
      status: 'acknowledged',
      acknowledgedAt: now,
      acknowledgedBy: normCaller || row.from_agent
    };
  }

  _isAuthorizedParty(fromAgent, toAgent, caller) {
    if (!caller) return false; // Fails closed for null/unauthenticated caller
    if (typeof caller === 'object' && (caller.isPrivileged === true || caller.isInternal === true)) {
      return true;
    }
    const callerId = typeof caller === 'string' ? caller : caller.agentId;
    if (!callerId || callerId === 'anonymous') return false; // Anonymous identity has no access to private requests
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

    // Apply expired-lease predicate: dead lease cannot be reported as live
    if (['claimed', 'in_progress'].includes(row.status) && row.lease_expires_at) {
      if (new Date(row.lease_expires_at).getTime() < Date.now()) {
        this.recoverExpiredRequests({ agentId: row.to_agent });
        const fresh = this.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(requestId);
        if (fresh) {
          row.status = fresh.status;
          row.epoch = fresh.epoch;
          row.claimed_by = fresh.claimed_by;
          row.lease_expires_at = fresh.lease_expires_at;
          row.error = fresh.error;
        } else {
          row.status = 'pending';
        }
      }
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
      completionConfidence: art?.executionMetadata?.completionConfidence || (row.status === 'completed' ? 'UNKNOWN' : null),
      isHeuristic: Boolean(art?.executionMetadata?.isHeuristic || art?.executionMetadata?.completionConfidence === 'STABILITY_HEURISTIC'),
      observedSignals: art?.executionMetadata?.observedSignals || null,
      stableTicks: art?.executionMetadata?.stableTicks ?? null,
      graceRecheck: art?.executionMetadata?.graceRecheck || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      deliveryAcknowledgedAt: row.delivery_acknowledged_at || null
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
      this.recoverExpiredRequests(agentId);
      const canonicalAgentId = canonicalizeTargetAgent(agentId, { required: false }) || normalizeAgentId(agentId);
      const aliasCandidates = getAliasesFor(canonicalAgentId);
      const placeholders = aliasCandidates.map(() => '?').join(', ');
      const now = new Date().toISOString();
      const rows = this.db.prepare(`
        SELECT request_id, conversation_id, from_agent, to_agent, question, context, task_id, status, created_at
        FROM bridge_requests
        WHERE to_agent IN (${placeholders}) AND (
          status = 'pending'
          OR (status IN ('claimed', 'in_progress') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
        )
        ORDER BY created_at ASC
        LIMIT ?
      `).all(...aliasCandidates, now, limit);
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

  answerRequest({
    requestId,
    agentId,
    response,
    status = 'completed',
    error = null,
    attemptId = null,
    epoch = null,
    nonce = null,
    completionConfidence = null,
    observedSignals = null,
    stableTicks = null,
    graceRecheck = null
  }) {
    if (!requestId) throw new Error('requestId is required');
    if (!agentId) throw new Error('agentId is required');

    let reqRow = null;
    try {
      reqRow = this.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(requestId);
    } catch  {
      // swallow-ok: optional record lookup fallback
    }

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

    // 3. Fencing validation if epoch tracked or attemptId provided
    if (reqRow.epoch) {
      if (!attemptId || epoch === null || epoch === undefined) {
        const errMsg = `FENCED_ATTEMPT_ERROR: Request '${requestId}' has active epoch ${reqRow.epoch} (attempt '${reqRow.attempt_id}'). Result submission requires matching attemptId and epoch tokens.`;
        if (this.tasks?.attempts) {
          try {
            this.tasks.attempts.quarantineLateResponse({
              attemptId: attemptId || `missing_attempt_${requestId}`,
              requestId,
              epoch: Number(epoch) || 0,
              payload: response || error,
              reason: errMsg
            });
          } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }
        }
        return {
          status: 'quarantined',
          quarantined: true,
          requestId,
          error: errMsg
        };
      }
      if (Number(epoch) !== reqRow.epoch || (reqRow.attempt_id && attemptId !== reqRow.attempt_id)) {
        const errMsg = `FENCED_ATTEMPT_ERROR: Stale attempt '${attemptId}' (epoch ${epoch}) for request '${requestId}'. Current epoch is ${reqRow.epoch}.`;
        if (this.tasks?.attempts) {
          try {
            this.tasks.attempts.quarantineLateResponse({
              attemptId,
              requestId,
              epoch: Number(epoch) || 0,
              payload: response || error,
              reason: errMsg
            });
          } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }
        }
        return {
          status: 'quarantined',
          quarantined: true,
          requestId,
          attemptId,
          epoch,
          error: errMsg
        };
      }
    }

    if (reqRow.task_id) {
      return this.submitTaskResult({
        taskId: reqRow.task_id,
        agentId,
        status,
        result: response,
        error,
        attemptId,
        epoch,
        nonce,
        completionConfidence,
        observedSignals,
        stableTicks,
        graceRecheck
      });
    }

    const effectiveConfidence = completionConfidence || 'UNKNOWN';

    // Confidence and side-effects gating for direct requests
    if (status === 'completed') {
      let reqContext = null;
      if (reqRow.context) {
        try {
          reqContext = typeof reqRow.context === 'string' ? JSON.parse(reqRow.context) : reqRow.context;
        } catch  {
      // swallow-ok: safe fallback for plaintext or non-JSON input
    }
      }
      const hasSideEffects = Boolean(
        reqContext?.hasSideEffects ||
        reqContext?.originalContext?.hasSideEffects ||
        (reqContext?.tool && isEffectfulTool(reqContext.tool)) ||
        (reqContext?.originalContext?.tool && isEffectfulTool(reqContext.originalContext.tool))
      );
      const reqConfidence = reqContext?.requiredConfidence || reqContext?.originalContext?.requiredConfidence || (hasSideEffects ? 'INDICATOR_BASED' : null);

      const CONFIDENCE_RANK = {
        'UNKNOWN': 0,
        'STABILITY_HEURISTIC': 1,
        'INDICATOR_BASED': 2,
        'EXPLICIT_END_OF_TURN': 3,
        'AUTHENTICATED_SUBMIT': 4
      };

      if (hasSideEffects && (effectiveConfidence === 'STABILITY_HEURISTIC' || effectiveConfidence === 'UNKNOWN')) {
        const errMsg = `INSUFFICIENT_COMPLETION_CONFIDENCE: ${effectiveConfidence} completions are not accepted for requests with side effects.`;
        return this.answerRequest({
          requestId,
          agentId,
          status: 'failed',
          error: errMsg,
          attemptId,
          epoch
        });
      }

      if (reqConfidence && (CONFIDENCE_RANK[effectiveConfidence] || 0) < (CONFIDENCE_RANK[reqConfidence] || 0)) {
        const errMsg = `INSUFFICIENT_COMPLETION_CONFIDENCE: Request requires '${reqConfidence}' but observed confidence was '${effectiveConfidence}'.`;
        return this.answerRequest({
          requestId,
          agentId,
          status: 'failed',
          error: errMsg,
          attemptId,
          epoch
        });
      }

      if (effectiveConfidence === 'AUTHENTICATED_SUBMIT') {
        if (!attemptId || epoch === null || epoch === undefined || !nonce) {
          const errMsg = 'AUTHENTICATED_SUBMIT_REJECTED: Recipient submit requires valid attemptId, epoch, and nonce tokens.';
          return {
            status: 'quarantined',
            quarantined: true,
            requestId,
            error: errMsg
          };
        }
        if (reqRow.nonce && reqRow.nonce !== nonce) {
          const errMsg = `AUTHENTICATED_SUBMIT_REJECTED: Cryptographic nonce mismatch for request '${requestId}'.`;
          if (this.tasks?.attempts) {
            try {
              this.tasks.attempts.quarantineLateResponse({
                attemptId,
                requestId,
                epoch: Number(epoch) || 0,
                payload: response || error,
                reason: errMsg
              });
            } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }
          }
          return {
            status: 'quarantined',
            quarantined: true,
            requestId,
            error: errMsg
          };
        }
      }
    }

    // 3. Fencing validation if epoch tracked or attemptId provided
    if (reqRow.epoch) {
      if (!attemptId || epoch === null || epoch === undefined) {
        const errMsg = `FENCED_ATTEMPT_ERROR: Request '${requestId}' has active epoch ${reqRow.epoch} (attempt '${reqRow.attempt_id}'). Result submission requires matching attemptId and epoch tokens.`;
        if (this.tasks?.attempts) {
          try {
            this.tasks.attempts.quarantineLateResponse({
              attemptId: attemptId || `missing_attempt_${requestId}`,
              requestId,
              epoch: Number(epoch) || 0,
              payload: response || error,
              reason: errMsg
            });
          } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }
        }
        return {
          status: 'quarantined',
          quarantined: true,
          requestId,
          error: errMsg
        };
      }
      if (Number(epoch) !== reqRow.epoch || (reqRow.attempt_id && attemptId !== reqRow.attempt_id)) {
        const errMsg = `FENCED_ATTEMPT_ERROR: Stale attempt '${attemptId}' (epoch ${epoch}) for request '${requestId}'. Current epoch is ${reqRow.epoch}.`;
        if (this.tasks?.attempts) {
          try {
            this.tasks.attempts.quarantineLateResponse({
              attemptId,
              requestId,
              epoch: Number(epoch) || 0,
              payload: response || error,
              reason: errMsg
            });
          } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }
        }
        return {
          status: 'quarantined',
          quarantined: true,
          requestId,
          attemptId,
          epoch,
          error: errMsg
        };
      }
    }

    if (attemptId && (epoch === null || epoch === undefined)) {
      throw new Error(`Fencing Error: epoch token is required when attemptId is provided for request '${requestId}'.`);
    }
    if (reqRow.task_id && attemptId && (epoch !== null && epoch !== undefined) && this.tasks?.attempts) {
      try {
        this.tasks.attempts.validateFencing({ taskId: reqRow.task_id, attemptId, epoch: Number(epoch), agentId });
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

    let raceLost = false;
    let winnerRow = null;
    const now = new Date().toISOString();

    const directWork = (targetDb, stageEventFn = null) => {
      const updateResult = targetDb.prepare(`
        UPDATE bridge_requests
        SET status = ?, response = ?, error = ?, updated_at = ?, completed_at = ?
        WHERE request_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
      `).run(status, resultStr, error, now, now, requestId);

      if (updateResult.changes === 0) {
        raceLost = true;
        winnerRow = targetDb.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(requestId);
        if (this.tasks?.attempts) {
          try {
            this.tasks.attempts.quarantineLateResponse({
              attemptId: attemptId || `late_race_${requestId}_${agentId}`,
              requestId,
              epoch: epoch || 0,
              payload: response || error,
              reason: `Concurrent answer race lost: request '${requestId}' was already terminal ('${winnerRow?.status}')`
            });
          } catch (qErr) {
            this.logger?.debug?.('Failed to quarantine concurrent losing response', qErr);
          }
        }
        return;
      }

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
              originRoute: 'direct_answer',
              completionConfidence: effectiveConfidence,
              observedSignals: observedSignals || null,
              stableTicks: stableTicks || null,
              graceRecheck: graceRecheck || null,
              isHeuristic: effectiveConfidence === 'STABILITY_HEURISTIC'
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
            error: error ? (error.length > 80 ? error.slice(0, 80) + '...' : error) : null,
            completionConfidence: effectiveConfidence,
            isHeuristic: Boolean(effectiveConfidence === 'STABILITY_HEURISTIC'),
            observedSignals: observedSignals || null,
            stableTicks: stableTicks || null,
            graceRecheck: graceRecheck || null
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
      if (!raceLost && this.eventBus) {
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
            error: error ? (error.length > 80 ? error.slice(0, 80) + '...' : error) : null,
            completionConfidence: effectiveConfidence,
            isHeuristic: Boolean(effectiveConfidence === 'STABILITY_HEURISTIC'),
            observedSignals: observedSignals || null,
            stableTicks: stableTicks || null,
            graceRecheck: graceRecheck || null
          },
          dedupKey: `direct_resp_${requestId}_${status}`
        });
      }
    }

    if (raceLost) {
      return {
        status: 'quarantined',
        quarantined: true,
        requestId,
        answeredBy: agentId,
        error: `Request '${requestId}' is already terminal ('${winnerRow?.status || 'completed'}'); concurrent response quarantined.`,
        authoritativeResult: winnerRow?.response ?? null
      };
    }

    return {
      status: 'success',
      requestId,
      answeredBy: agentId,
      result: response
    };
  }
}
