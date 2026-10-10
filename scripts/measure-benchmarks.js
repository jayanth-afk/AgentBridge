import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { EventBus } from '../src/event-bus.js';

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[idx];
}

async function runBenchmarks() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  const dbPath = path.join(tmpDir, 'bench.sqlite');

  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);

  const SAMPLES = 100;
  const results = {};

  // 1. Task Creation & Persistence
  const createTimes = [];
  const createdTasks = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    const task = mailbox.delegateTask({
      fromAgent: 'agent-a',
      toAgent: 'agent-b',
      title: `Bench task ${i}`,
      instructions: `Perform workload step ${i}`,
      priority: 'high',
      emitEvent: false
    });
    createTimes.push(performance.now() - t0);
    createdTasks.push(task);
  }
  results['Task Creation & Persistence'] = createTimes;

  // 2. Task Claiming & Lease Acquisition
  const claimTimes = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    const claimed = taskManager.claimNextTask('agent-b');
    claimTimes.push(performance.now() - t0);
  }
  results['Task Claiming & Lease Acquisition'] = claimTimes;

  // 3. Completion Persistence
  const completeTimes = [];
  for (let i = 0; i < SAMPLES; i++) {
    const task = createdTasks[i];
    const t0 = performance.now();
    mailbox.submitTaskResult({
      taskId: task.id,
      agentId: 'agent-b',
      status: 'completed',
      result: `Result payload for ${task.id}`,
      attemptId: task.attemptId || null,
      epoch: task.epoch || null
    });
    completeTimes.push(performance.now() - t0);
  }
  results['Completion Persistence'] = completeTimes;

  // 4. Notification Delivery (EventBus publish -> subscriber wake)
  const notifyTimes = [];
  for (let i = 0; i < SAMPLES; i++) {
    await new Promise((resolve) => {
      const sub = eventBus.subscribe(`bench_sub_${i}`, (evt) => {
        sub.unsubscribe();
        resolve();
      });
      const t0 = performance.now();
      eventBus.publish({
        type: 'test_event',
        agentId: `bench_sub_${i}`,
        payload: { sample: i }
      });
      notifyTimes.push(performance.now() - t0);
    });
  }
  results['Notification Delivery (EventBus)'] = notifyTimes;

  // 5. Requester Reattachment (Idempotent recovery of completed request)
  const reattachTimes = [];
  for (let i = 0; i < SAMPLES; i++) {
    const task = createdTasks[i];
    const t0 = performance.now();
    const recovered = mailbox.getRequest(`req_task_${task.id}`);
    reattachTimes.push(performance.now() - t0);
  }
  results['Requester Reattachment (Idempotent Recovery)'] = reattachTimes;

  // 6. Cross-Agent Correlated Request/Response Round-Trip
  const roundTripTimes = [];
  const testSub = eventBus.subscribe('agent-c', async (event) => {
    if (event.type === 'request_created') {
      mailbox.submitTaskResult({
        taskId: event.taskId,
        agentId: 'agent-c',
        status: 'completed',
        result: `PONG_${event.requestId}`
      });
    }
  });

  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    const outcome = await mailbox.askAgent({
      fromAgent: 'agent-d',
      toAgent: 'agent-c',
      question: `Ping round trip ${i}`,
      timeoutMs: 2000
    });
    roundTripTimes.push(performance.now() - t0);
  }
  testSub.unsubscribe();
  results['Cross-Agent Synchronous Round-Trip'] = roundTripTimes;

  // Cleanup
  eventBus.close();
  logger.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  console.log('\n================================================================================');
  console.log('              AGENT BRIDGE PERFORMANCE BENCHMARKS (ACTUAL SYSTEM)');
  console.log('================================================================================\n');
  console.log('| Metric / Operation                     | Samples | p50 (ms) | p95 (ms) | Max (ms) |');
  console.log('|----------------------------------------|---------|----------|----------|----------|');

  for (const [name, times] of Object.entries(results)) {
    const p50 = percentile(times, 50).toFixed(3);
    const p95 = percentile(times, 95).toFixed(3);
    const max = Math.max(...times).toFixed(3);
    const samples = times.length;
    console.log(`| ${name.padEnd(38)} | ${String(samples).padStart(7)} | ${String(p50).padStart(8)} | ${String(p95).padStart(8)} | ${String(max).padStart(8)} |`);
  }
  console.log('\n================================================================================\n');
}

runBenchmarks().catch(console.error);
