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
}
