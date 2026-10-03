/**
 * DiagnosticsManager: Tracks tool latencies, success/failure counts,
 * task queue times, and resource stats with minimal overhead.
 */
export class DiagnosticsManager {
  constructor() {
    this.toolMetrics = new Map(); // toolName -> { calls, errors, totalMs, minMs, maxMs }
    this.taskMetrics = {
      created: 0,
      completed: 0,
      failed: 0,
      totalExecutionMs: 0
    };
    this.startTime = Date.now();
  }

  recordToolExecution(toolName, durationMs, success = true) {
    let stat = this.toolMetrics.get(toolName);
    if (!stat) {
      stat = { calls: 0, errors: 0, totalMs: 0, minMs: Infinity, maxMs: 0 };
      this.toolMetrics.set(toolName, stat);
    }
    stat.calls++;
    if (!success) stat.errors++;
    stat.totalMs += durationMs;
    if (durationMs < stat.minMs) stat.minMs = durationMs;
    if (durationMs > stat.maxMs) stat.maxMs = durationMs;
  }

  recordTaskCompletion(durationMs, success = true) {
    if (success) {
      this.taskMetrics.completed++;
    } else {
      this.taskMetrics.failed++;
    }
    this.taskMetrics.totalExecutionMs += durationMs;
  }

  getSnapshot(cacheManager = null) {
    const uptimeSec = Math.round((Date.now() - this.startTime) / 1000);
    const tools = {};
    for (const [name, stat] of this.toolMetrics.entries()) {
      tools[name] = {
        calls: stat.calls,
        errors: stat.errors,
        avgMs: stat.calls > 0 ? Math.round(stat.totalMs / stat.calls) : 0,
        maxMs: stat.maxMs === 0 ? 0 : Math.round(stat.maxMs)
      };
    }

    const memoryUsage = process.memoryUsage();

    return {
      uptimeSec,
      memoryMb: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024)
      },
      tasks: {
        ...this.taskMetrics,
        avgExecutionMs: this.taskMetrics.completed > 0 
          ? Math.round(this.taskMetrics.totalExecutionMs / this.taskMetrics.completed)
          : 0
      },
      tools,
      cache: cacheManager ? cacheManager.getMetrics() : null
    };
  }

  /**
   * Returns compact diagnostic metrics for a specific agent:
   * cursor, pending events, pending/active requests, current task, last event/response, and latency.
   */
  getAgentDiagnostics(agentId, { db = null, eventBus = null, presenceManager = null, taskManager = null } = {}) {
    const cursor = eventBus ? eventBus.getCursor(agentId) : 0;
    let pendingEvents = 0;
    let pendingRequests = 0;
    let activeRequests = 0;
    let activeTask = null;
    let lastEvent = null;
    let lastResponse = null;

    if (db) {
      try {
        const evRow = db.prepare(`
          SELECT COUNT(*) as count FROM bridge_events
          WHERE event_id > ? AND (agent_id = ? OR agent_id = '*')
        `).get(cursor, agentId);
        pendingEvents = evRow?.count || 0;

        const reqRow = db.prepare(`
          SELECT
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pendingCount,
            SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as activeCount
          FROM bridge_requests WHERE to_agent = ?
        `).get(agentId);
        pendingRequests = reqRow?.pendingCount || 0;
        activeRequests = reqRow?.activeCount || 0;

        const taskRow = db.prepare(`
          SELECT id, title, status FROM tasks
          WHERE assignee = ? AND status = 'in_progress'
          ORDER BY updated_at DESC LIMIT 1
        `).get(agentId);
        if (taskRow) {
          activeTask = { id: taskRow.id, title: taskRow.title, status: taskRow.status };
        }

        const lastEvRow = db.prepare(`
          SELECT event_id, type, status, timestamp FROM bridge_events
          WHERE agent_id = ? OR from_agent = ?
          ORDER BY event_id DESC LIMIT 1
        `).get(agentId, agentId);
        if (lastEvRow) {
          lastEvent = { eventId: lastEvRow.event_id, type: lastEvRow.type, status: lastEvRow.status, timestamp: lastEvRow.timestamp };
        }

        const lastRespRow = db.prepare(`
          SELECT request_id, status, completed_at FROM bridge_requests
          WHERE (from_agent = ? OR to_agent = ?) AND status IN ('completed', 'failed')
          ORDER BY updated_at DESC LIMIT 1
        `).get(agentId, agentId);
        if (lastRespRow) {
          lastResponse = { requestId: lastRespRow.request_id, status: lastRespRow.status, completedAt: lastRespRow.completed_at };
        }
      } catch {}
    }

    const presence = presenceManager ? presenceManager.getPresence(agentId) : null;
    let state = 'OFFLINE';
    if (presence?.isAlive) {
      state = (activeTask || activeRequests > 0) ? 'BUSY' : (presence.state || 'IDLE');
    }

    // Average tool latency across all calls if available
    let avgLatencyMs = null;
    if (this.toolMetrics.size > 0) {
      let totalMs = 0;
      let totalCalls = 0;
      for (const stat of this.toolMetrics.values()) {
        totalMs += stat.totalMs;
        totalCalls += stat.calls;
      }
      if (totalCalls > 0) {
        avgLatencyMs = Math.round(totalMs / totalCalls);
      }
    }

    return {
      agent: agentId,
      state,
      cursor,
      pendingEvents,
      pendingRequests,
      activeRequests,
      activeTask,
      lastEvent,
      lastResponse,
      latency: avgLatencyMs !== null ? `${avgLatencyMs}ms` : null
    };
  }
}
