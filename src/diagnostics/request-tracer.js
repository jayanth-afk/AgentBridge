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
}
