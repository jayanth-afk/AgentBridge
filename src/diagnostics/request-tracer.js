import { performance } from 'node:perf_hooks';

/**
 * Request life cycle stages.
 *
 * These mirror the end-to-end path a correlated request travels:
 * caller -> bridge -> worker -> provider -> result -> caller.
 * Every stage is recorded with BOTH a wall-clock timestamp (for persisted,
 * cross-process diagnostics) and a monotonic millisecond reading (for reliable
 * duration deltas that are immune to clock adjustments).
 */
export const LifecycleStage = Object.freeze({
  REQUEST_CREATED: 'REQUEST_CREATED',
  TASK_CREATED: 'TASK_CREATED',
  WORKER_AWAKENED: 'WORKER_AWAKENED',
  TASK_CLAIMED: 'TASK_CLAIMED',
  PROVIDER_SUBMITTED: 'PROVIDER_SUBMITTED',
  PROVIDER_UNCONFIRMED: 'PROVIDER_UNCONFIRMED',
  PROVIDER_RESPONSE_OBSERVED: 'PROVIDER_RESPONSE_OBSERVED',
  PROVIDER_RESPONSE_COMPLETED: 'PROVIDER_RESPONSE_COMPLETED',
  RESULT_PERSISTED: 'RESULT_PERSISTED',
  COMPLETION_EVENT_COMMITTED: 'COMPLETION_EVENT_COMMITTED',
  WAITER_RESOLVED: 'WAITER_RESOLVED',
  RESPONSE_RETURNED: 'RESPONSE_RETURNED'
});

/**
 * RequestTracer
 *
 * Minimal, additive observability layer. It never influences control flow: a
 * failure to record a stage must never change delivery semantics, so every DB
 * write is best-effort and swallowed.
 *
 * It records only identifiers, stage names, and timings. Prompts and response
 * bodies are NEVER written here (they may be sensitive and are large).
 */
export class RequestTracer {
  constructor(auditLogger, options = {}) {
    this.logger = auditLogger;
    this.db = auditLogger?.db || options.db || null;
    this.enabled = options.enabled !== false && Boolean(this.db);
    if (this.enabled) {
      try {
        this.initTables();
      } catch {
        this.enabled = false;
      }
    }
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_lifecycle (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        task_id TEXT,
        attempt_id TEXT,
        agent_id TEXT,
        route_id TEXT,
        wall_clock TEXT NOT NULL,
        monotonic_ms REAL NOT NULL,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_request_lifecycle_req ON request_lifecycle(request_id, id);
      CREATE INDEX IF NOT EXISTS idx_request_lifecycle_wall ON request_lifecycle(wall_clock);
    `);
  }

  /**
   * Record a lifecycle stage. Best-effort and non-throwing.
   * @returns {{requestId:string,stage:string,wallClock:string,monotonicMs:number}|null}
   */
  mark({ requestId, stage, taskId = null, attemptId = null, agentId = null, routeId = null, meta = null }) {
    if (!this.enabled || !requestId || !stage) return null;

    const wallClock = new Date().toISOString();
    const monotonicMs = performance.now();

    try {
      this.db.prepare(`
        INSERT INTO request_lifecycle (
          request_id, stage, task_id, attempt_id, agent_id, route_id, wall_clock, monotonic_ms, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        requestId,
        stage,
        taskId,
        attemptId,
        agentId,
        routeId,
        wallClock,
        monotonicMs,
        meta === null || meta === undefined
          ? null
          : (typeof meta === 'string' ? meta : JSON.stringify(meta))
      );
    } catch {
      // Observability must never break delivery.
      return null;
    }

    return { requestId, stage, wallClock, monotonicMs };
  }

  getTimeline(requestId) {
    if (!this.enabled || !requestId) return [];
    try {
      return this.db.prepare(`
        SELECT stage, task_id, attempt_id, agent_id, route_id, wall_clock, monotonic_ms, meta
        FROM request_lifecycle
        WHERE request_id = ?
        ORDER BY id ASC
      `).all(requestId).map(r => ({
        stage: r.stage,
        taskId: r.task_id,
        attemptId: r.attempt_id,
        agentId: r.agent_id,
        routeId: r.route_id,
        wallClock: r.wall_clock,
        monotonicMs: r.monotonic_ms,
        meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch { return r.meta; } })() : null
      }));
    } catch {
      return [];
    }
  }

  /**
   * Compute stage-to-stage deltas. Deltas use the monotonic clock, which is only
   * directly comparable within a single process; the persisted wall-clock is
   * surfaced for cross-process reasoning.
   */
  getStageDurations(requestId) {
    const timeline = this.getTimeline(requestId);
    const stages = [];
    let previous = null;
    for (const entry of timeline) {
      const deltaMs = previous === null ? 0 : entry.monotonicMs - previous.monotonicMs;
      stages.push({ ...entry, deltaFromPreviousMs: deltaMs });
      previous = entry;
    }
    const totalMs = stages.length > 1
      ? stages[stages.length - 1].monotonicMs - stages[0].monotonicMs
      : 0;
    return { requestId, stages, totalMs };
  }

  /** The delta between two named stages (first occurrence each), or null. */
  stageDelta(requestId, fromStage, toStage) {
    const timeline = this.getTimeline(requestId);
    const from = timeline.find(s => s.stage === fromStage);
    const to = timeline.find(s => s.stage === toStage);
    if (!from || !to) return null;
    return to.monotonicMs - from.monotonicMs;
  }

  /**
   * Conservative retention / pruning mechanism for request lifecycle records.
   *
   * Invariants:
   *  1. Configurable retention period (default 7 days).
   *  2. Bounded batch deletion (maxBatch, default 1000) to prevent lock contention.
   *  3. Records belonging to incomplete requests (pending/in_progress in bridge_requests)
   *     or incomplete tasks in tasks are NEVER pruned, ensuring crash recovery state is preserved.
   *  4. Safe maintenance invocation returns detailed counts and continuation status.
   *
   * @param {object} options
   * @param {number} [options.retentionMs=604800000] - Cutoff age in milliseconds (default 7 days)
   * @param {number} [options.maxBatch=1000] - Maximum records to delete in one invocation
   * @param {number} [options.now=Date.now()] - Current epoch timestamp in ms
   * @returns {{pruned:number, hasMore:boolean, cutoff:string}}
   */
  prune({
    retentionMs = 7 * 24 * 60 * 60 * 1000,
    maxBatch = 1000,
    now = Date.now()
  } = {}) {
    if (!this.enabled || !this.db) return { pruned: 0, hasMore: false, cutoff: null };

    const cutoffIso = new Date(now - retentionMs).toISOString();
    const batchLimit = Math.max(1, Number.isFinite(maxBatch) ? maxBatch : 1000);

    try {
      // Find candidate record IDs older than the cutoff whose request and task are
      // terminal (or unlinked). Records needed for active/in-flight recovery are preserved.
      const candidateRows = this.db.prepare(`
        SELECT rl.id FROM request_lifecycle rl
        WHERE rl.wall_clock < ?
        AND NOT EXISTS (
          SELECT 1 FROM bridge_requests br
          WHERE br.request_id = rl.request_id
          AND br.status NOT IN ('completed', 'failed', 'cancelled')
        )
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.id = rl.task_id
          AND t.status NOT IN ('completed', 'failed', 'cancelled')
        )
        ORDER BY rl.id ASC
        LIMIT ?
      `).all(cutoffIso, batchLimit);

      if (!candidateRows || candidateRows.length === 0) {
        return { pruned: 0, hasMore: false, cutoff: cutoffIso };
      }

      const ids = candidateRows.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const result = this.db.prepare(`
        DELETE FROM request_lifecycle WHERE id IN (${placeholders})
      `).run(...ids);

      const pruned = result.changes || ids.length;
      return {
        pruned,
        hasMore: ids.length === batchLimit,
        cutoff: cutoffIso
      };
    } catch {
      return { pruned: 0, hasMore: false, cutoff: cutoffIso };
    }
  }

  /**
   * Diagnostic statistics for request lifecycle records.
   * @returns {{totalRecords:number, oldest:string|null, newest:string|null}}
   */
  getStats() {
    if (!this.enabled || !this.db) {
      return { totalRecords: 0, oldest: null, newest: null };
    }
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) as total, MIN(wall_clock) as oldest, MAX(wall_clock) as newest
        FROM request_lifecycle
      `).get();
      return {
        totalRecords: Number(row?.total || 0),
        oldest: row?.oldest || null,
        newest: row?.newest || null
      };
    } catch {
      return { totalRecords: 0, oldest: null, newest: null };
    }
  }
}

