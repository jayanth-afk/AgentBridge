import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

import { AuditLogger } from '../../src/audit-logger.js';
import { EventBus } from '../../src/event-bus.js';
import { TaskManager } from '../../src/task-manager.js';
import { MailboxHub } from '../../src/mailbox-hub.js';
import { AttemptLedger } from '../../src/attempts/attempt-ledger.js';
import { ArtifactStore } from '../../src/artifacts/artifact-store.js';
import { RequestTracer, LifecycleStage } from '../../src/diagnostics/request-tracer.js';

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

export async function runStageLatencyBenchmark(iterations = 35) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-bench-'));
  const dbPath = path.join(tmpDir, 'stage_bench.sqlite');
  const artifactsDir = path.join(tmpDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const logger = new AuditLogger(dbPath);
  const attempts = new AttemptLedger(logger);
  const eventBus = new EventBus(logger, { dbPath, fallbackIntervalMs: 20 });
  const tasks = new TaskManager(logger, attempts, eventBus);
  const artifactStore = new ArtifactStore({ root: artifactsDir, db: logger.db });
  const tracer = new RequestTracer(logger);
  const mailbox = new MailboxHub(logger, tasks, eventBus);

  const metrics = {
    requestCreation: [],
    taskCreation: [],
    taskClaim: [],
    responderExecution: [],
    resultPersistence: [],
    eventCommit: [],
    eventDeliveryAck: [],
    totalLifecycle: []
  };

  try {
    for (let i = 0; i < iterations; i++) {
      const reqId = `bench_req_${Date.now()}_${i}`;

      // 1. Request Creation
      const t0 = performance.now();
      tracer.mark({ requestId: reqId, stage: LifecycleStage.REQUEST_CREATED });
      const t1 = performance.now();
      metrics.requestCreation.push(t1 - t0);

      // 2. Backing Task Creation
      const tTask0 = performance.now();
      const task = tasks.createTask({
        fromAgent: 'caller-agent',
        toAgent: 'worker-agent',
        title: `Bench task ${i}`,
        instructions: 'Execute monotonic latency probe'
      });
      tracer.mark({ requestId: reqId, stage: LifecycleStage.TASK_CREATED, taskId: task.id });
      const tTask1 = performance.now();
      metrics.taskCreation.push(tTask1 - tTask0);

      // 3. Worker Claim & Lease Fencing
      const tClaim0 = performance.now();
      const claimed = tasks.claimNextTask('worker-agent');
      tracer.mark({ requestId: reqId, stage: LifecycleStage.TASK_CLAIMED, taskId: claimed.id, attemptId: claimed.attemptId });
      const tClaim1 = performance.now();
      metrics.taskClaim.push(tClaim1 - tClaim0);

      // 4. Responder Execution (pure computation)
      const tExec0 = performance.now();
      const output = JSON.stringify({ iteration: i, payload: 'bench-result-42', timestamp: Date.now() });
      const tExec1 = performance.now();
      metrics.responderExecution.push(tExec1 - tExec0);

      // 5. Result Persistence (ArtifactStore)
      const tPersist0 = performance.now();
      mailbox.submitTaskResult({
        taskId: claimed.id,
        agentId: 'worker-agent',
        status: 'completed',
        result: output,
        attemptId: claimed.attemptId,
        epoch: claimed.epoch
      });
      tracer.mark({ requestId: reqId, stage: LifecycleStage.RESULT_PERSISTED, taskId: claimed.id });
      const tPersist1 = performance.now();
      metrics.resultPersistence.push(tPersist1 - tPersist0);

      // 6. Transactional Event Commit & Outbox Settle
      const tEvt0 = performance.now();
      const unacked = eventBus.getUnackedEvents({ agentId: 'caller-agent' });
      const tEvt1 = performance.now();
      metrics.eventCommit.push(tEvt1 - tEvt0);

      // 7. Event Acknowledgment
      const tAck0 = performance.now();
      if (unacked.length > 0) {
        eventBus.ackEvent('caller-agent', unacked[0].eventId);
      }
      const tAck1 = performance.now();
      metrics.eventDeliveryAck.push(tAck1 - tAck0);

      metrics.totalLifecycle.push(performance.now() - t0);
    }

    const stagesSummary = Object.entries(metrics).map(([stage, latencies]) => ({
      stage,
      sampleSize: latencies.length,
      minMs: Number(Math.min(...latencies).toFixed(4)),
      medianP50Ms: Number(percentile(latencies, 50).toFixed(4)),
      p95Ms: Number(percentile(latencies, 95).toFixed(4)),
      maxMs: Number(Math.max(...latencies).toFixed(4))
    }));

    return {
      success: true,
      sampleSize: iterations,
      stages: stagesSummary,
      timestamp: new Date().toISOString()
    };
  } finally {
    eventBus.close();
    logger.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

if (process.argv[1] && process.argv[1].endsWith('stage-latency-benchmark.js')) {
  console.log('='.repeat(80));
  console.log('AGENT BRIDGE MISSION 4: STAGE-SEPARATED MONOTONIC LATENCY BENCHMARK');
  console.log('='.repeat(80));

  runStageLatencyBenchmark(35).then(res => {
    console.log(`\nSample Size: n=${res.sampleSize} iterations`);
    console.table(res.stages.map(s => ({
      'Lifecycle Stage': s.stage,
      'Min (ms)': s.minMs,
      'Median p50 (ms)': s.medianP50Ms,
      'p95 (ms)': s.p95Ms,
      'Max (ms)': s.maxMs
    })));
  }).catch(err => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
