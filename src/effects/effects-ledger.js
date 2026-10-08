import crypto from 'node:crypto';

/**
 * Operation Side-Effect Classifications
 */
export const EffectClassification = Object.freeze({
  PURE: 'pure',                         // Read-only (e.g. read_file, ping)
  IDEMPOTENT: 'idempotent',             // Repeatable safely (e.g. write with overwrite, mkdir)
  NON_IDEMPOTENT: 'non_idempotent',     // State changes on each execution (e.g. append, git commit)
  EXTERNAL: 'external'                  // External side effect (e.g. git push, external network)
});

/**
 * Lifecycle states of an effectful operation
 */
export const EffectState = Object.freeze({
  INTENT_RECORDED: 'INTENT_RECORDED',
  EXECUTING: 'EXECUTING',
  COMMITTED: 'COMMITTED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN' // When process crashed or timed out during execution; NEVER silently marked FAILED
});

export class EffectsLedger {
  constructor(auditLogger) {
    this.logger = auditLogger;
    this.db = auditLogger.db;
    this.initTables();
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_effects_ledger (
        effect_id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        attempt_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        classification TEXT NOT NULL,
        state TEXT NOT NULL,
        params TEXT,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_effects_attempt ON bridge_effects_ledger(attempt_id, epoch);
      CREATE INDEX IF NOT EXISTS idx_effects_state ON bridge_effects_ledger(state);
    `);
  }

  /**
   * Records intent before performing side-effectful operation.
   * Validates attempt epoch fencing and enforces idempotency deduplication.
   */
  recordIntent({
    idempotencyKey = null,
    attemptId,
    taskId,
    epoch,
    agentId,
    operation,
    classification = EffectClassification.NON_IDEMPOTENT,
    params = {},
    attemptLedger = null
  }) {
    // 1. Monotonic Fencing Check: Stale attempt can NEVER produce effects
    if (attemptLedger) {
      attemptLedger.validateFencing({ taskId, attemptId, epoch, agentId });
    }

    const resolvedKey = idempotencyKey || `idem_${operation}_${attemptId}_${epoch}_${crypto.randomBytes(6).toString('hex')}`;

    // 2. Idempotency Check: Return committed cached result if already completed
    const existing = this.db.prepare(`
      SELECT * FROM bridge_effects_ledger WHERE idempotency_key = ?
    `).get(resolvedKey);

    if (existing) {
      if (existing.state === EffectState.COMMITTED) {
        return {
          effectId: existing.effect_id,
          idempotencyKey: resolvedKey,
          alreadyCommitted: true,
          result: existing.result ? (() => { try { return JSON.parse(existing.result); } catch { return existing.result; } })() : null
        };
      }
      if (existing.state === EffectState.EXECUTING || existing.state === EffectState.UNKNOWN) {
        const err = new Error(
          `EFFECT_IN_FLIGHT_OR_UNKNOWN: Operation '${operation}' with key '${resolvedKey}' is in state '${existing.state}'. Automated repeat refused.`
        );
        err.code = 'EFFECT_UNRECONCILED';
        err.state = existing.state;
        throw err;
      }
    }

    const effectId = `eff_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const paramsStr = typeof params === 'object' ? JSON.stringify(params) : String(params);

    this.db.prepare(`
      INSERT INTO bridge_effects_ledger (
        effect_id, idempotency_key, attempt_id, task_id, epoch, agent_id,
        operation, classification, state, params, result, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INTENT_RECORDED', ?, NULL, NULL, ?)
    `).run(
      effectId,
      resolvedKey,
      attemptId,
      taskId,
      epoch,
      agentId,
      operation,
      classification,
      paramsStr,
      now
    );

    this.logger?.log({
      agentId,
      action: 'record_effect_intent',
      status: 'intent_recorded',
      details: { effectId, idempotencyKey: resolvedKey, operation, classification, epoch }
    });

    return {
      effectId,
      idempotencyKey: resolvedKey,
      alreadyCommitted: false,
      state: EffectState.INTENT_RECORDED
    };
  }

  markExecuting(effectId) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE bridge_effects_ledger
      SET state = 'EXECUTING', started_at = ?
      WHERE effect_id = ?
    `).run(now, effectId);
  }

  commitEffect(effectId, result = null) {
    const now = new Date().toISOString();
    const resStr = typeof result === 'object' && result !== null ? JSON.stringify(result) : result;
    this.db.prepare(`
      UPDATE bridge_effects_ledger
      SET state = 'COMMITTED', completed_at = ?, result = ?
      WHERE effect_id = ?
    `).run(now, resStr, effectId);

    return { effectId, state: EffectState.COMMITTED, result };
  }

  failEffect(effectId, error = null) {
    const now = new Date().toISOString();
    const errStr = error instanceof Error ? error.message : String(error || 'Failed');
    this.db.prepare(`
      UPDATE bridge_effects_ledger
      SET state = 'FAILED', completed_at = ?, error = ?
      WHERE effect_id = ?
    `).run(now, errStr, effectId);

    return { effectId, state: EffectState.FAILED, error: errStr };
  }

  /**
   * Sweeps in-flight operations after crash/restart and transitions them to UNKNOWN
   */
  sweepIncompleteEffects(timeoutMs = 30000) {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM bridge_effects_ledger
      WHERE state IN ('INTENT_RECORDED', 'EXECUTING') AND created_at <= ?
    `).all(cutoff);

    const transitioned = [];
    const now = new Date().toISOString();

    for (const row of rows) {
      this.db.prepare(`
        UPDATE bridge_effects_ledger
        SET state = 'UNKNOWN', error = 'Process interrupted during execution; marked UNKNOWN for reconciliation'
        WHERE effect_id = ?
      `).run(row.effect_id);

      this.logger?.log({
        agentId: row.agent_id,
        action: 'effect_marked_unknown',
        status: 'unknown',
        details: { effectId: row.effect_id, operation: row.operation, classification: row.classification }
      });

      transitioned.push(row.effect_id);
    }

    return transitioned;
  }

  getEffect(effectId) {
    return this.db.prepare(`SELECT * FROM bridge_effects_ledger WHERE effect_id = ?`).get(effectId);
  }
}
