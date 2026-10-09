/**
 * Completion -> requester-receipt benchmark.
 *
 * The mission's success metric is: the time between the receiving agent's
 * complete response becoming available (persisted) and the originating agent
 * receiving it.
 *
 * The bridge's primary path is event-driven: the worker persists the terminal
 * result inside the durable outbox transaction and the same commit immediately
 * dispatches a completion notification that resolves the waiter. To prove the
 * path does not depend on polling, the fallback interval is set very high; if
 * resolution still happens in milliseconds, polling is not the driver.
 *
 * Provider completion-DETECTION delay (accessibility observation) is NOT
 * measured here: it needs live provider turns and is deliberately not faked.
 *
 * Usage: node scripts/bench/bench-completion-delivery.mjs
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
const WORKER = path.join(__dirname, 'completion-worker.mjs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-completion-'));
const dbPath = path.join(tmpDir, 'completion.sqlite');

function makeEnv(fallbackIntervalMs = 60000) {
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger, { fallbackIntervalMs });
  const tasks = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, tasks, eventBus);
  return { logger, eventBus, tasks, mailbox };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
}
function summarize(arr) {
  const s = [...arr].sort((a, b) => a - b);
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

// ---------------------------------------------------------------------------
// In-process: worker persists completion -> waiter receipt
// ---------------------------------------------------------------------------
async function inProcess() {
  // Fallback poll effectively disabled: proves event-driven resolution.
  const env = makeEnv(60000);
  const lat = [];
  const stageDeltas = [];
  const N = 300;
  for (let i = 0; i < N; i++) {
    const queued = await env.mailbox.askAgent({
      fromAgent: 'antigravity-ide', toAgent: 'claude-desktop',
      question: `q${i}`, asyncMode: true, timeoutMs: 10000
    });
    const waiter = env.eventBus.waitForResponse({ requestId: queued.requestId, timeoutMs: 10000 });
    const t0 = performance.now();
    env.mailbox.submitTaskResult({
      taskId: queued.taskId, agentId: 'claude-desktop', status: 'completed', result: `answer ${i}`
    });
    const outcome = await waiter;
    lat.push(performance.now() - t0);
    if (outcome.status !== 'completed') throw new Error(`in-process failed at ${i}: ${outcome.status}`);
    const delta = env.mailbox.tracer.stageDelta(queued.requestId, 'RESULT_PERSISTED', 'WAITER_RESOLVED');
    if (delta !== null) stageDeltas.push(delta);
  }
  const result = {
    completionToReceipt: summarize(lat),
    resultPersistedToWaiterResolved: summarize(stageDeltas),
    fallbackIntervalMs: 60000,
    note: 'fallback poll set to 60s; sub-millisecond resolution proves the event-driven path, not polling'
  };
  env.eventBus.close();
  try { env.logger.close(); } catch {}
  return result;
}

// ---------------------------------------------------------------------------
// Cross-process: separate worker process persists completion -> parent receipt
// ---------------------------------------------------------------------------
async function crossProcess() {
  const env = makeEnv(60000);
  const child = fork(WORKER, [], {
    env: { ...process.env, BENCH_DB: dbPath },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('worker not ready')), 5000);
    child.once('message', (m) => { if (m && m.type === 'ready') { clearTimeout(to); resolve(); } });
    child.once('error', reject);
  });

  const lat = [];
  const N = 100;
  for (let i = 0; i < N; i++) {
    const queued = await env.mailbox.askAgent({
      fromAgent: 'antigravity-ide', toAgent: 'claude-desktop',
      question: `xp${i}`, asyncMode: true, timeoutMs: 10000
    });
    const waiter = env.eventBus.waitForResponse({ requestId: queued.requestId, timeoutMs: 10000 });
    const t0 = performance.now();
    child.send({
      type: 'complete', requestId: queued.requestId, taskId: queued.taskId,
      agentId: 'claude-desktop', result: `xp answer ${i}`
    });
    const outcome = await waiter;
    lat.push(performance.now() - t0);
    if (outcome.status !== 'completed') throw new Error(`cross-process failed at ${i}: ${outcome.status}`);
  }

  child.send({ type: 'stop' });
  await new Promise((r) => child.once('exit', r));
  env.eventBus.close();
  try { env.logger.close(); } catch {}
  return {
    completionToReceiptCrossProcess: summarize(lat),
    includes: 'IPC dispatch + SQLite commit + notify file + fs.watch wake + durable read + waiter resolve'
  };
}

// ---------------------------------------------------------------------------
// Concurrency: many independent in-flight requests, all completed, no cross-talk
// ---------------------------------------------------------------------------
async function concurrent() {
  const env = makeEnv(60000);
  const agents = ['claude-desktop', 'gemini', 'chatgpt-desktop', 'claude-desktop'];
  const queued = [];
  for (let i = 0; i < agents.length; i++) {
    const q = await env.mailbox.askAgent({
      fromAgent: 'antigravity-ide', toAgent: agents[i],
      question: `c${i}`, asyncMode: true, timeoutMs: 10000
    });
    queued.push(q);
  }
  const waiters = queued.map(q => env.eventBus.waitForResponse({ requestId: q.requestId, timeoutMs: 10000 }));
  const t0 = performance.now();
  for (let i = 0; i < queued.length; i++) {
    env.mailbox.submitTaskResult({
      taskId: queued[i].taskId, agentId: agents[i], status: 'completed', result: `conc ${i}`
    });
  }
  const outcomes = await Promise.all(waiters);
  const wall = performance.now() - t0;
  const ok = outcomes.every((o, i) => o.status === 'completed' && o.response === `conc ${i}`);
  env.eventBus.close();
  try { env.logger.close(); } catch {}
  return { requests: queued.length, wallMs: wall, allCorrectlyCorrelated: ok };
}

async function main() {
  const results = {
    inProcess: await inProcess(),
    crossProcess: await crossProcess(),
    concurrent: await concurrent(),
    providerCompletionDetection: {
      available: false,
      reason: 'Provider accessibility observation requires live provider turns (opt-in quota/credentials). Not measured and not simulated here.'
    },
    meta: { node: process.version, platform: `${process.platform} ${process.arch}` }
  };
  console.log(JSON.stringify(results, null, 2));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((err) => { console.error('benchmark failed:', err); process.exit(1); });
