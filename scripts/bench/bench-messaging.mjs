/**
 * Agent Bridge messaging benchmark.
 *
 * Measures bridge-owned latency (never model generation) across the paths that
 * matter for agent-to-agent conversations. Every case uses a monotonic clock and
 * stable request IDs. Real-provider cases are NOT faked here: where no provider
 * route is exercised, that is stated explicitly.
 *
 * Usage: node scripts/bench/bench-messaging.mjs [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { AuditLogger } from '../../src/audit-logger.js';
import { EventBus } from '../../src/event-bus.js';
import { TaskManager } from '../../src/task-manager.js';
import { MailboxHub } from '../../src/mailbox-hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, 'bench-worker.mjs');
const AS_JSON = process.argv.includes('--json');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-bench-'));
const dbPath = path.join(tmpDir, 'bench.sqlite');

function makeEnv(fallbackIntervalMs = 500) {
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger, { fallbackIntervalMs });
  const tasks = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, tasks, eventBus);
  return { logger, eventBus, tasks, mailbox };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
}

function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0] ?? 0,
    p50: percentile(s, 0.5),
    p90: percentile(s, 0.9),
    p95: percentile(s, 0.95),
    p99: percentile(s, 0.99),
    max: s[s.length - 1] ?? 0,
    mean: s.length ? sum / s.length : 0
  };
}

async function spawnWorker(agentId, delayMs = 0) {
  const child = fork(WORKER, [], {
    env: { ...process.env, BENCH_DB: dbPath, BENCH_AGENT: agentId, BENCH_WORKER_DELAY_MS: String(delayMs) },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('worker did not become ready')), 5000);
    child.once('message', (m) => { if (m === 'ready') { clearTimeout(to); resolve(); } });
    child.once('error', reject);
  });
  return child;
}

const results = {};

// ---------------------------------------------------------------------------
// A. In-process request->response over the durable correlated path
// ---------------------------------------------------------------------------
async function caseInProcess() {
  const env = makeEnv(500);
  const workerId = 'agent-b';
  const sub = env.eventBus.subscribe(workerId, (event) => {
    if (event.type !== 'request_created' || !event.requestId) return;
    setTimeout(() => {
      const req = env.mailbox.getRequest(event.requestId);
      if (!req || req.status !== 'pending') return;
      env.mailbox.submitTaskResult({ taskId: req.taskId, agentId: workerId, status: 'completed', result: `echo:${event.requestId}` });
    }, 0);
  });

  const lat = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    const res = await env.mailbox.askAgent({ fromAgent: 'agent-a', toAgent: workerId, question: `ping ${i}`, timeoutMs: 5000 });
    lat.push(performance.now() - t0);
    if (res.status !== 'completed') throw new Error(`case A failed at ${i}: ${res.status}`);
  }
  results.internalRoundTrip = summarize(lat);

  // Stage-level bridge overhead via the lifecycle tracer.
  const req = await env.mailbox.askAgent({ fromAgent: 'agent-a', toAgent: workerId, question: 'trace', timeoutMs: 5000 });
  const lasts = env.mailbox.tracer.getStageDurations(req.requestId);
  results.stageBreakdownMs = {
    REQUEST_CREATED_to_WAITER_RESOLVED: env.mailbox.tracer.stageDelta(req.requestId, 'REQUEST_CREATED', 'WAITER_RESOLVED'),
    RESULT_PERSISTED_to_WAITER_RESOLVED: env.mailbox.tracer.stageDelta(req.requestId, 'RESULT_PERSISTED', 'WAITER_RESOLVED'),
    total: lasts.totalMs
  };

  sub.unsubscribe();
  env.eventBus.close();
  try { env.logger.close(); } catch {}
}

// ---------------------------------------------------------------------------
// B. Genuine cross-process round trip (separate worker process)
// ---------------------------------------------------------------------------
async function caseCrossProcess() {
  const env = makeEnv(500);
  const child = await spawnWorker('bench-xp', 0);
  try {
    const lat = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      const res = await env.mailbox.askAgent({ fromAgent: 'agent-a', toAgent: 'bench-xp', question: `xp ${i}`, timeoutMs: 8000 });
      lat.push(performance.now() - t0);
      if (res.status !== 'completed') throw new Error(`case B failed at ${i}: ${res.status} ${res.error || ''}`);
    }
    results.crossProcessRoundTrip = summarize(lat);
  } finally {
    child.send('stop');
    await new Promise((r) => child.once('exit', r));
    env.eventBus.close();
    try { env.logger.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// C. Independent concurrent asks do not serialize behind each other
// ---------------------------------------------------------------------------
async function caseConcurrent() {
  const env = makeEnv(500);
  const agents = ['worker-c1', 'worker-c2', 'worker-c3', 'worker-c4'];
  const subs = agents.map((id, idx) => env.eventBus.subscribe(id, (event) => {
    if (event.type !== 'request_created' || !event.requestId) return;
    setTimeout(() => {
      const req = env.mailbox.getRequest(event.requestId);
      if (!req || req.status !== 'pending') return;
      env.mailbox.submitTaskResult({ taskId: req.taskId, agentId: id, status: 'completed', result: `c${idx}:${event.requestId}` });
    }, 30); // simulate an independent slow-ish provider turn
  }));

  // Sequential baseline: 4 waits back to back.
  const seq = [];
  for (const a of agents) {
    const t0 = performance.now();
    const r = await env.mailbox.askAgent({ fromAgent: 'caller', toAgent: a, question: 'seq', timeoutMs: 8000 });
    seq.push(performance.now() - t0);
    if (r.status !== 'completed') throw new Error(`seq failed: ${r.status}`);
  }

  // Concurrent: all 4 in flight together.
  const t0 = performance.now();
  const conc = await Promise.all(agents.map((a) => env.mailbox.askAgent({ fromAgent: 'caller', toAgent: a, question: 'conc', timeoutMs: 8000 })));
  const concurrentWall = performance.now() - t0;
  for (const r of conc) if (r.status !== 'completed') throw new Error(`conc failed: ${r.status}`);

  results.concurrent = {
    sequentialTotalMs: seq.reduce((a, b) => a + b, 0),
    sequentialEachMs: seq,
    concurrentWallMs: concurrentWall,
    perRequestSimulatedProviderMs: 30,
    parallelSpeedup: seq.reduce((a, b) => a + b, 0) / concurrentWall
  };

  for (const s of subs) s.unsubscribe();
  env.eventBus.close();
  try { env.logger.close(); } catch {}
}

// ---------------------------------------------------------------------------
// D. Real provider round trip — reported only if actually exercised
// ---------------------------------------------------------------------------
async function caseRealProvider() {
  results.realProvider = {
    available: false,
    reason: 'No provider route exercised by this harness. Desktop/headless provider turns require opt-in live credentials/quota and are not faked here.'
  };
}

// ---------------------------------------------------------------------------
// E. Large response integrity (no silent truncation) + delivery latency
// ---------------------------------------------------------------------------
async function caseLongResponse() {
  const env = makeEnv(500);
  const workerId = 'worker-long';
  const big = 'X'.repeat(120000) + '_END';
  const sub = env.eventBus.subscribe(workerId, (event) => {
    if (event.type !== 'request_created' || !event.requestId) return;
    setTimeout(() => {
      const req = env.mailbox.getRequest(event.requestId);
      if (!req || req.status !== 'pending') return;
      env.mailbox.submitTaskResult({ taskId: req.taskId, agentId: workerId, status: 'completed', result: big });
    }, 0);
  });
  const t0 = performance.now();
  const res = await env.mailbox.askAgent({ fromAgent: 'agent-a', toAgent: workerId, question: 'long', timeoutMs: 10000 });
  const elapsed = performance.now() - t0;
  results.longResponse = {
    elapsedMs: elapsed,
    expectedLen: big.length,
    gotLen: typeof res.response === 'string' ? res.response.length : -1,
    intact: res.response === big,
    status: res.status
  };
  sub.unsubscribe();
  env.eventBus.close();
  try { env.logger.close(); } catch {}
}

// ---------------------------------------------------------------------------
// F. Caller timeout while provider continues; late result stays retrievable
// ---------------------------------------------------------------------------
async function caseTimeoutLate() {
  const env = makeEnv(100);
  const child = await spawnWorker('bench-late', 400);
  try {
    const res = await env.mailbox.askAgent({ fromAgent: 'agent-a', toAgent: 'bench-late', question: 'late', timeoutMs: 80 });
    const timedOut = res.status === 'timeout';
    // Wait for the late provider turn to land, then re-attach.
    await new Promise((r) => setTimeout(r, 900));
    const durable = env.mailbox.getRequest(res.requestId);
    const reattachT0 = performance.now();
    const reattached = await env.eventBus.waitForResponse({ requestId: res.requestId, timeoutMs: 2000 });
    const reattachMs = performance.now() - reattachT0;
    results.timeoutLate = {
      firstStatus: res.status,
      timedOut,
      durableStatusAfter: durable ? durable.status : null,
      reattachStatus: reattached.status,
      reattachMs,
      lateResultRecovered: reattached.status === 'completed' || (durable && durable.status === 'completed')
    };
  } finally {
    child.send('stop');
    await new Promise((r) => child.once('exit', r));
    env.eventBus.close();
    try { env.logger.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// G. EventBus publish throughput + publish->waiter settle overhead
// ---------------------------------------------------------------------------
async function casePublish() {
  const env = makeEnv(500);
  const N = 2000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    env.eventBus.publish({ type: 'bench_tick', agentId: 'nobody', fromAgent: 'bench', status: 'ok', payload: { i } });
  }
  const publishMs = performance.now() - t0;
  results.publishThroughput = { count: N, totalMs: publishMs, perEventMs: publishMs / N, eventsPerSec: N / (publishMs / 1000) };
  env.eventBus.close();
  try { env.logger.close(); } catch {}
}

async function main() {
  const t0 = performance.now();
  await caseInProcess();
  await caseCrossProcess();
  await caseConcurrent();
  await caseRealProvider();
  await caseLongResponse();
  await caseTimeoutLate();
  await casePublish();
  results.meta = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    totalWallMs: performance.now() - t0,
    tmpDb: dbPath
  };

  if (AS_JSON) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(JSON.stringify(results, null, 2));
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('benchmark failed:', err);
  process.exit(1);
});
