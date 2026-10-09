import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { EventBus } from '../src/event-bus.js';
import { LifecycleStage } from '../src/diagnostics/request-tracer.js';

function makeEnv(dbPath, eventBusOptions = {}) {
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger, eventBusOptions);
  const taskManager = new TaskManager(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  return { logger, eventBus, taskManager, mailbox };
}

function insertPendingRequest(mailbox, requestId, { from = 'agent-a', to = 'agent-b' } = {}) {
  const now = new Date().toISOString();
  mailbox.db.prepare(`
    INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, timeout_ms, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'test question', 'pending', 60000, ?, ?)
  `).run(requestId, `conv_${requestId}`, from, to, now, now);
}

function writeTerminalRow(mailbox, requestId, response, status = 'completed') {
  const now = new Date().toISOString();
  const resultStr = typeof response === 'string' ? response : JSON.stringify(response);
  mailbox.db.prepare(`
    UPDATE bridge_requests SET status = ?, response = ?, error = ?, updated_at = ?, completed_at = ? WHERE request_id = ?
  `).run(status, resultStr, status === 'failed' ? (response ?? 'failed') : null, now, now, requestId);
}

function publishTerminal(mailbox, requestId, { type = 'response_delivered', status = 'completed', snippet = 'SNIPPET' } = {}) {
  return mailbox.eventBus.publish({
    type,
    agentId: 'agent-a',
    fromAgent: 'agent-b',
    requestId,
    status,
    payload: { snippet, status }
  });
}

function completeAndPublish(mailbox, requestId, response, status = 'completed') {
  writeTerminalRow(mailbox, requestId, response, status);
  return publishTerminal(mailbox, requestId, { status, snippet: String(response).slice(0, 100) });
}

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))];
  return { n: s.length, median: at(0.5), p95: at(0.95), max: s[s.length - 1], min: s[0] };
}

test('Correlated result delivery: race-safety, recovery, and latency', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-test-'));
  const dbPath = path.join(tmpDir, 'delivery.sqlite');

  const env = makeEnv(dbPath, { fallbackIntervalMs: 100 });

  t.after(() => {
    env.eventBus.close();
    try { env.logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. The waiter is registered BEFORE the authoritative DB check (lost-wakeup fix)', async () => {
    const requestId = 'req_register_first';
    insertPendingRequest(env.mailbox, requestId);

    let waiterPresentDuringCheck = null;
    const originalRead = env.eventBus._readTerminalRequest.bind(env.eventBus);
    env.eventBus._readTerminalRequest = (rid) => {
      waiterPresentDuringCheck = env.eventBus.responseWaiters.has(rid);
      return originalRead(rid);
    };

    const pending = env.eventBus.waitForResponse({ requestId, timeoutMs: 500 });
    // The check runs synchronously inside waitForResponse and must already see a waiter.
    assert.equal(waiterPresentDuringCheck, true, 'a waiter must exist when the authoritative check runs');

    completeAndPublish(env.mailbox, requestId, 'RACE_SAFE');
    const outcome = await pending;
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.response, 'RACE_SAFE');
  });

  await t.test('2. A result already terminal is returned immediately (no poll interval)', async () => {
    const requestId = 'req_already_terminal';
    insertPendingRequest(env.mailbox, requestId);
    completeAndPublish(env.mailbox, requestId, 'DONE_ALREADY');

    const t0 = performance.now();
    const outcome = await env.eventBus.waitForResponse({ requestId, timeoutMs: 5000 });
    const elapsed = performance.now() - t0;

    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.response, 'DONE_ALREADY');
    assert.ok(elapsed < 50, `expected immediate resolution, took ${elapsed.toFixed(1)}ms`);
  });

  await t.test('3. A live completion wakes the waiter promptly', async () => {
    const requestId = 'req_live_wakeup';
    insertPendingRequest(env.mailbox, requestId);

    const pending = env.eventBus.waitForResponse({ requestId, timeoutMs: 5000 });
    const t0 = performance.now();
    completeAndPublish(env.mailbox, requestId, 'LIVE');
    const outcome = await pending;
    const elapsed = performance.now() - t0;

    assert.equal(outcome.response, 'LIVE');
    assert.ok(elapsed < 50, `live wakeup took ${elapsed.toFixed(1)}ms`);
  });

  await t.test('4. Completion from another process is discovered (cross-process durable recovery)', async () => {
    const requestId = 'req_cross_process';
    insertPendingRequest(env.mailbox, requestId);

    // Second independent bus/logger over the same SQLite file, like a peer process.
    const peerLogger = new AuditLogger(dbPath);
    const peerBus = new EventBus(peerLogger, { fallbackIntervalMs: 100 });
    const peerMailbox = new MailboxHub(peerLogger, new TaskManager(peerLogger), peerBus);

    const pending = env.eventBus.waitForResponse({ requestId, timeoutMs: 5000 });
    completeAndPublish(peerMailbox, requestId, 'FROM_OTHER_PROCESS');

    // The notify file / fallback poll in the waiting process must discover it.
    const outcome = await pending;
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.response, 'FROM_OTHER_PROCESS');

    peerBus.close();
    try { peerLogger.close(); } catch {}
  });

  await t.test('5. A missed filesystem notification is recovered from the database', async () => {
    const requestId = 'req_missed_notify';
    insertPendingRequest(env.mailbox, requestId);

    const pending = env.eventBus.waitForResponse({ requestId, timeoutMs: 5000 });
    // Simulate a lost OS notification: stop watchers, then commit the result.
    env.eventBus.stopWatcher();
    completeAndPublish(env.mailbox, requestId, 'RECOVERED_FROM_DB');
    // Explicit recovery pass (what the fallback timer would do).
    env.eventBus.checkAllNewEvents();

    const outcome = await pending;
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.response, 'RECOVERED_FROM_DB');
    env.eventBus.ensureWatcherStarted();
  });

  await t.test('6. A caller timeout does not erase the durable task or its later result', async () => {
    const requestId = 'req_late_completion';
    insertPendingRequest(env.mailbox, requestId);

    const timedOut = await env.eventBus.waitForResponse({ requestId, timeoutMs: 30 });
    assert.equal(timedOut.status, 'timeout');
    assert.equal(timedOut.recoverable, true);

    // Provider finishes late — after the caller already gave up.
    completeAndPublish(env.mailbox, requestId, 'LATE_RESULT');

    const durable = env.mailbox.getRequest(requestId);
    assert.equal(durable.status, 'completed', 'the durable request must not be erased by the caller timeout');
    assert.equal(durable.response, 'LATE_RESULT');

    // A re-attaching caller gets the late result immediately.
    const reattached = await env.eventBus.waitForResponse({ requestId, timeoutMs: 50 });
    assert.equal(reattached.status, 'completed');
    assert.equal(reattached.response, 'LATE_RESULT');
  });

  await t.test('7. Duplicate terminal events resolve once and never corrupt state', async () => {
    const requestId = 'req_duplicate_events';
    insertPendingRequest(env.mailbox, requestId);

    let resolutions = 0;
    const pending = env.eventBus.waitForResponse({ requestId, timeoutMs: 5000 });
    pending.then(() => { resolutions++; });

    completeAndPublish(env.mailbox, requestId, 'ONCE');
    publishTerminal(env.mailbox, requestId, { snippet: 'DUPLICATE' });
    publishTerminal(env.mailbox, requestId, { snippet: 'DUPLICATE_2' });

    const outcome = await pending;
    await new Promise(r => setTimeout(r, 20));
    assert.equal(outcome.response, 'ONCE');
    assert.equal(resolutions, 1, 'a waiter must resolve exactly once');
  });

  await t.test('8. The durable row is authoritative over a stale/out-of-order event', async () => {
    const requestId = 'req_stale_event';
    insertPendingRequest(env.mailbox, requestId);

    const pending = env.eventBus.waitForResponse({ requestId, timeoutMs: 5000 });
    // Durable state is completed, but a stale event claims failure.
    completeAndPublish(env.mailbox, requestId, 'REAL_SUCCESS', 'completed');
    publishTerminal(env.mailbox, requestId, { type: 'task_completed', status: 'failed', snippet: 'WRONG' });

    const outcome = await pending;
    assert.equal(outcome.status, 'completed', 'the stored result wins over a stale event status');
    assert.equal(outcome.response, 'REAL_SUCCESS');

    // An event for a different request must never resolve this waiter.
    const otherRequestId = 'req_other';
    insertPendingRequest(env.mailbox, otherRequestId);
    const otherPending = env.eventBus.waitForResponse({ requestId: otherRequestId, timeoutMs: 5000 });
    publishTerminal(env.mailbox, otherRequestId, { snippet: 'not me' });
    completeAndPublish(env.mailbox, otherRequestId, 'MINE');
    const otherOutcome = await otherPending;
    assert.equal(otherOutcome.response, 'MINE');
  });

  await t.test('9. Two simultaneous requests to the same provider resolve independently', async () => {
    const reqA = 'req_concurrent_a';
    const reqB = 'req_concurrent_b';
    insertPendingRequest(env.mailbox, reqA);
    insertPendingRequest(env.mailbox, reqB);

    const pa = env.eventBus.waitForResponse({ requestId: reqA, timeoutMs: 5000 });
    const pb = env.eventBus.waitForResponse({ requestId: reqB, timeoutMs: 5000 });

    completeAndPublish(env.mailbox, reqB, 'ANSWER_B');
    completeAndPublish(env.mailbox, reqA, 'ANSWER_A');

    const [ra, rb] = await Promise.all([pa, pb]);
    assert.equal(ra.response, 'ANSWER_A');
    assert.equal(rb.response, 'ANSWER_B');
  });

  await t.test('10. A large response is delivered intact, not as a truncated snippet', async () => {
    const requestId = 'req_large_response';
    insertPendingRequest(env.mailbox, requestId);
    const big = 'X'.repeat(5000) + '_END';

    const pending = env.eventBus.waitForResponse({ requestId, timeoutMs: 5000 });
    // The event payload intentionally carries a short snippet; the full body is durable.
    completeAndPublish(env.mailbox, requestId, big, 'completed');
    const outcome = await pending;

    assert.equal(outcome.response, big, 'the full response must be returned, not the event snippet');
    assert.equal(outcome.response.length, big.length);
  });

  await t.test('11. Lifecycle stages are recorded in causal order', async () => {
    const requestId = 'req_trace_order';
    insertPendingRequest(env.mailbox, requestId);
    env.mailbox.tracer.mark({ requestId, stage: LifecycleStage.REQUEST_CREATED, agentId: 'agent-b' });
    env.mailbox.tracer.mark({ requestId, stage: LifecycleStage.TASK_CREATED, agentId: 'agent-b' });

    const pending = env.eventBus.waitForResponse({ requestId, timeoutMs: 5000 });
    completeAndPublish(env.mailbox, requestId, 'TRACED');
    await pending;
    env.mailbox.tracer.mark({ requestId, stage: LifecycleStage.RESPONSE_RETURNED, agentId: 'agent-a' });

    const stages = env.mailbox.tracer.getTimeline(requestId).map(s => s.stage);
    assert.deepEqual(stages, [
      LifecycleStage.REQUEST_CREATED,
      LifecycleStage.TASK_CREATED,
      LifecycleStage.WAITER_RESOLVED,
      LifecycleStage.RESPONSE_RETURNED
    ]);
  });

  await t.test('12. End-to-end askAgent latency through a real in-process worker', async () => {
    // A dedicated worker that completes requests through the durable path.
    const workerId = 'agent-b';
    const subscription = env.eventBus.subscribe(workerId, (event) => {
      if (event.type !== 'request_created' || !event.requestId) return;
      setTimeout(() => {
        const request = env.mailbox.getRequest(event.requestId);
        if (!request || request.status !== 'pending') return;
        env.mailbox.submitTaskResult({
          taskId: request.taskId,
          agentId: workerId,
          status: 'completed',
          result: `echo:${event.requestId}`
        });
      }, 0);
    });

    const latencies = [];
    let lastRequestId = null;
    for (let i = 0; i < 25; i++) {
      const t0 = performance.now();
      const res = await env.mailbox.askAgent({
        fromAgent: 'agent-a',
        toAgent: workerId,
        question: `ping ${i}`,
        timeoutMs: 5000
      });
      latencies.push(performance.now() - t0);
      assert.equal(res.status, 'completed');
      lastRequestId = res.requestId;
    }

    const s = stats(latencies);
    // eslint-disable-next-line no-console
    console.log(`[delivery-latency] end-to-end askAgent ms: n=${s.n} min=${s.min.toFixed(1)} median=${s.median.toFixed(1)} p95=${s.p95.toFixed(1)} max=${s.max.toFixed(1)}`);

    // The local fake provider answers in ~0ms; the observable delivery overhead
    // must stay far below the old 500ms fallback interval.
    assert.ok(s.median < 100, `median end-to-end latency ${s.median.toFixed(1)}ms should be well under the 500ms fallback`);
    assert.ok(s.max < 500, `max end-to-end latency ${s.max.toFixed(1)}ms should not require the fallback poll`);

    // The tracer captured a complete lifecycle for the last request.
    const timeline = env.mailbox.tracer.getTimeline(lastRequestId).map(x => x.stage);
    assert.ok(timeline.includes(LifecycleStage.REQUEST_CREATED));
    assert.ok(timeline.includes(LifecycleStage.WAITER_RESOLVED));

    subscription.unsubscribe();
  });

  await t.test('13. A failed durable read never becomes a false success', async () => {
    const requestId = 'req_db_read_failure';
    insertPendingRequest(env.mailbox, requestId);

    // Simulate an unavailable/failed authoritative read (the real
    // _readTerminalRequest swallows DB errors and returns null).
    const original = env.eventBus._readTerminalRequest;
    env.eventBus._readTerminalRequest = () => null;
    try {
      const pending = env.eventBus.waitForResponse({ requestId, timeoutMs: 40 });
      // The durable row IS terminal, but the read fails, so no live event may
      // fabricate a successful completion.
      completeAndPublish(env.mailbox, requestId, 'SHOULD_NOT_BE_DELIVERED');
      const outcome = await pending;
      assert.equal(outcome.status, 'timeout', 'a failed read must time out, not report success');
      assert.equal(outcome.timedOut, true);
      assert.equal(outcome.response, null);
    } finally {
      env.eventBus._readTerminalRequest = original;
    }
  });

  await t.test('14. Concurrent multi-agent delivery of 5,000+ character Unicode payloads with newlines', async () => {
    const agents = ['gemini', 'chatgpt-desktop', 'claude-desktop', 'freebuff'];
    const unicodeBase = '🚀 🌟 宇宙・銀河・プログラミング \n\t\r\n' +
      'αβγδεζηθικλμνξοπρστυφχψω\n' +
      'مرحبا بالعالم - أهلا وسهلا\n' +
      '```json\n{"status": "ok", "nested": true}\n```\n';
    const longPayload = (unicodeBase.repeat(Math.ceil(6000 / unicodeBase.length))).slice(0, 7500);

    const promises = agents.map(async (agent, idx) => {
      const rid = `req_unicode_${agent}_${idx}`;
      insertPendingRequest(env.mailbox, rid, { from: 'antigravity-ide', to: agent });
      const waiter = env.eventBus.waitForResponse({ requestId: rid, timeoutMs: 5000 });
      const expected = `${longPayload}_[${agent}_${idx}]`;
      completeAndPublish(env.mailbox, rid, expected);
      const res = await waiter;
      assert.equal(res.status, 'completed');
      assert.equal(res.response, expected);
      assert.equal(res.response.length, expected.length);
      return res;
    });

    const results = await Promise.all(promises);
    assert.equal(results.length, 4);
  });

  await t.test('15. Response arriving exactly around the timeout boundary is safely resolved or recoverable', async () => {
    const requestId = 'req_timeout_boundary';
    insertPendingRequest(env.mailbox, requestId);

    // Set a very short timeout
    const waiter = env.eventBus.waitForResponse({ requestId, timeoutMs: 15 });
    await new Promise(r => setTimeout(r, 15));
    completeAndPublish(env.mailbox, requestId, 'BOUNDARY_RESPONSE');

    const outcome = await waiter;
    if (outcome.status === 'completed') {
      assert.equal(outcome.response, 'BOUNDARY_RESPONSE');
    } else {
      assert.equal(outcome.status, 'timeout');
      assert.equal(outcome.recoverable, true);
      const durable = env.mailbox.getRequest(requestId);
      assert.equal(durable.response, 'BOUNDARY_RESPONSE');
    }
  });

  await t.test('16. Two concurrent waiters on one requestId both resolve from the durable row', async () => {
    const requestId = 'req_multi_waiter';
    insertPendingRequest(env.mailbox, requestId);

    const w1 = env.eventBus.waitForResponse({ requestId, timeoutMs: 5000 });
    const w2 = env.eventBus.waitForResponse({ requestId, timeoutMs: 5000 });
    assert.equal(env.eventBus.responseWaiters.get(requestId).size, 2, 'both waiters must be registered');

    completeAndPublish(env.mailbox, requestId, 'BOTH');

    const [r1, r2] = await Promise.all([w1, w2]);
    assert.equal(r1.status, 'completed');
    assert.equal(r1.response, 'BOTH');
    assert.equal(r2.status, 'completed');
    assert.equal(r2.response, 'BOTH');
  });

  await t.test('17. A timed-out waiter does not orphan a still-registered second waiter', async () => {
    const requestId = 'req_multi_waiter_timeout';
    insertPendingRequest(env.mailbox, requestId);

    const shortWaiter = env.eventBus.waitForResponse({ requestId, timeoutMs: 30 });
    const longWaiter = env.eventBus.waitForResponse({ requestId, timeoutMs: 5000 });

    const shortOutcome = await shortWaiter;
    assert.equal(shortOutcome.status, 'timeout');
    assert.equal(env.eventBus.responseWaiters.get(requestId).size, 1, 'the long waiter must remain registered');

    completeAndPublish(env.mailbox, requestId, 'SURVIVOR');
    const longOutcome = await longWaiter;
    assert.equal(longOutcome.status, 'completed');
    assert.equal(longOutcome.response, 'SURVIVOR');
  });
});
