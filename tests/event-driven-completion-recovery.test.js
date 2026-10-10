import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { AttemptLedger } from '../src/attempts/attempt-ledger.js';

function setupTestEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-recovery-test-'));
  const dbPath = path.join(tmpDir, 'test-bridge.sqlite');
  const logger = new AuditLogger(dbPath);
  const attempts = new AttemptLedger(logger);
  const eventBus = new EventBus(logger, { dbPath, fallbackIntervalMs: 50 });
  const tasks = new TaskManager(logger, attempts, eventBus);
  const mailbox = new MailboxHub(logger, tasks, eventBus);

  return {
    tmpDir,
    dbPath,
    logger,
    attempts,
    eventBus,
    tasks,
    mailbox,
    cleanup: () => {
      try { eventBus.close(); } catch {}
      try { logger.close(); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  };
}

test('Phase 3: Event-Driven Completion & Recovery Suite', async (t) => {
  const env = setupTestEnv();
  t.after(() => env.cleanup());

  await t.test('1. Durable completion notification delivers without polling delay', async () => {
    const reqId = 'req_event_notify_1';
    const askPromise = env.mailbox.askAgent({
      fromAgent: 'requester-agent',
      toAgent: 'worker-agent',
      question: 'Calculate 2 + 2',
      requestId: reqId,
      timeoutMs: 5000,
      asyncMode: false
    });

    const task = env.tasks.claimNextTask('worker-agent');
    assert.ok(task, 'Task must be claimed');
    assert.equal(task.creator, 'requester-agent');

    // Worker completes task
    const startTime = Date.now();
    env.mailbox.submitTaskResult({
      taskId: task.id,
      agentId: 'worker-agent',
      status: 'completed',
      result: '4',
      attemptId: task.attemptId,
      epoch: task.epoch
    });

    const outcome = await askPromise;
    const elapsed = Date.now() - startTime;

    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.response, '4');
    assert.ok(elapsed < 200, `Event-driven resolution must be fast (<200ms), took ${elapsed}ms`);

    // Verify durable request state
    const req = env.mailbox.getRequest(reqId);
    assert.equal(req.status, 'completed');
    assert.equal(req.response, '4');
  });

  await t.test('2. Explicit event acks track delivery and filter unacked events', async () => {
    // Publish 3 events to worker-agent
    const e1 = env.eventBus.publish({
      type: 'test_event',
      agentId: 'worker-agent',
      fromAgent: 'system',
      payload: { seq: 1 }
    });
    const e2 = env.eventBus.publish({
      type: 'test_event',
      agentId: 'worker-agent',
      fromAgent: 'system',
      payload: { seq: 2 }
    });
    const e3 = env.eventBus.publish({
      type: 'test_event',
      agentId: 'worker-agent',
      fromAgent: 'system',
      payload: { seq: 3 }
    });

    // Check initial unacked list
    let unacked = env.eventBus.getUnackedEvents({ agentId: 'worker-agent' });
    const unackedIds = unacked.map(e => e.eventId);
    assert.ok(unackedIds.includes(e1.eventId));
    assert.ok(unackedIds.includes(e2.eventId));
    assert.ok(unackedIds.includes(e3.eventId));

    // Ack single event e1
    const ack1 = env.eventBus.ackEvent('worker-agent', e1.eventId);
    assert.equal(ack1.acked, true);
    assert.equal(env.eventBus.isEventAcked('worker-agent', e1.eventId), true);
    assert.equal(env.eventBus.isEventAcked('worker-agent', e2.eventId), false);

    // Unacked list now omits e1
    unacked = env.eventBus.getUnackedEvents({ agentId: 'worker-agent' });
    const remainingIds = unacked.map(e => e.eventId);
    assert.ok(!remainingIds.includes(e1.eventId));
    assert.ok(remainingIds.includes(e2.eventId));
    assert.ok(remainingIds.includes(e3.eventId));

    // Batch ack e2 and e3
    const batchAck = env.eventBus.ackEvents('worker-agent', [e2.eventId, e3.eventId]);
    assert.equal(batchAck.ackedCount, 2);
    assert.equal(env.eventBus.isEventAcked('worker-agent', e2.eventId), true);
    assert.equal(env.eventBus.isEventAcked('worker-agent', e3.eventId), true);

    // Unacked list should no longer include any of the three
    unacked = env.eventBus.getUnackedEvents({ agentId: 'worker-agent' });
    const finalIds = unacked.map(e => e.eventId);
    assert.ok(!finalIds.includes(e1.eventId));
    assert.ok(!finalIds.includes(e2.eventId));
    assert.ok(!finalIds.includes(e3.eventId));
  });

  await t.test('3. Retry of unacked events re-dispatches to active subscribers', async () => {
    // Publish an unacknowledged event
    const e = env.eventBus.publish({
      type: 'retry_test_event',
      agentId: 'retry-agent',
      fromAgent: 'system',
      payload: { message: 'Must be retried' }
    });

    const received = [];
    const sub = env.eventBus.subscribe('retry-agent', (evt) => {
      received.push(evt);
    });

    // Re-dispatch unacked events
    const retryReport = env.eventBus.retryUnackedEvents({ agentId: 'retry-agent' });
    assert.ok(retryReport.unackedCount >= 1);
    assert.ok(retryReport.dispatched >= 1);
    assert.ok(received.some(ev => ev.eventId === e.eventId));

    sub.unsubscribe();
  });

  await t.test('4. Terminal Request Immutability: Completed request cannot be modified or downgraded', async () => {
    const reqId = 'req_terminal_immutable_1';
    await env.mailbox.askAgent({
      fromAgent: 'agent-alpha',
      toAgent: 'agent-beta',
      question: 'Immutable Question',
      requestId: reqId,
      asyncMode: true
    });

    // Direct answer with result
    const ans1 = env.mailbox.answerRequest({
      requestId: reqId,
      agentId: 'agent-beta',
      response: 'ORIGINAL_TRUTH',
      status: 'completed'
    });
    assert.equal(ans1.status, 'completed');

    const reqBefore = env.mailbox.getRequest(reqId);
    assert.equal(reqBefore.status, 'completed');
    assert.equal(reqBefore.response, 'ORIGINAL_TRUTH');

    // Attempt 1: Try to downgrade completed request to 'failed'
    const ansFailed = env.mailbox.answerRequest({
      requestId: reqId,
      agentId: 'agent-beta',
      response: null,
      status: 'failed',
      error: 'Late failure trying to corrupt terminal state'
    });
    assert.equal(ansFailed.status, 'quarantined');
    assert.equal(ansFailed.quarantined, true);

    // Status must remain completed
    const reqAfterFailed = env.mailbox.getRequest(reqId);
    assert.equal(reqAfterFailed.status, 'completed');
    assert.equal(reqAfterFailed.response, 'ORIGINAL_TRUTH');

    // Attempt 2: Try to overwrite response with a conflicting second completed response
    const ansConflict = env.mailbox.answerRequest({
      requestId: reqId,
      agentId: 'agent-beta',
      response: 'CONFLICTING_LATE_RESPONSE',
      status: 'completed'
    });
    assert.equal(ansConflict.status, 'quarantined');
    assert.equal(ansConflict.quarantined, true);

    // Request response must remain strictly unaltered
    const reqFinal = env.mailbox.getRequest(reqId);
    assert.equal(reqFinal.status, 'completed');
    assert.equal(reqFinal.response, 'ORIGINAL_TRUTH');

    // Attempt 3: Idempotent resubmission of identical result returns cleanly without modifying timestamps
    const ansIdempotent = env.mailbox.answerRequest({
      requestId: reqId,
      agentId: 'agent-beta',
      response: 'ORIGINAL_TRUTH',
      status: 'completed'
    });
    assert.equal(ansIdempotent.status, 'completed');
    assert.equal(ansIdempotent.result, 'ORIGINAL_TRUTH');
  });

  await t.test('5. Attempt Fencing & Quarantine: Stale epoch is rejected and quarantined', async () => {
    const task = env.tasks.createTask({
      title: 'Fencing Test Task',
      fromAgent: 'system',
      toAgent: 'worker-agent',
      instructions: 'Demonstrate fencing quarantine'
    });

    // Attempt 1 claimed by worker (epoch 1)
    const att1 = env.tasks.claimNextTask('worker-agent');
    assert.equal(att1.epoch, 1);

    // Lease expires or recovery supersedes: new attempt created (epoch 2)
    const att2 = env.attempts.createAttempt({
      taskId: task.id,
      agentId: 'worker-agent'
    });
    assert.equal(att2.epoch, 2);

    // Stale worker tries to complete with epoch 1
    assert.throws(() => {
      env.tasks.updateTaskStatus({
        taskId: task.id,
        agentId: 'worker-agent',
        status: 'completed',
        result: 'STALE_EPOCH_PAYLOAD',
        attemptId: att1.attemptId,
        epoch: 1
      });
    }, (err) => err.code === 'FENCED_ATTEMPT_ERROR');

    // Task must NOT be marked completed
    const taskAfter = env.tasks.getTask(task.id);
    assert.notEqual(taskAfter.status, 'completed');

    // Stale payload MUST be recorded in bridge_quarantined_responses
    const quarantined = env.attempts.getQuarantinedResponses(task.parent_task_id || task.id);
    assert.ok(quarantined.length >= 1, 'Stale payload must be recorded in quarantine');
    assert.ok(quarantined.some(q => q.attempt_id === att1.attemptId));
  });

  await t.test('6. Unauthorized responder cannot answer another agent\'s request', async () => {
    const reqId = 'req_unauth_responder_1';
    await env.mailbox.askAgent({
      fromAgent: 'client-agent',
      toAgent: 'authorized-agent',
      question: 'Private request',
      requestId: reqId,
      asyncMode: true
    });

    // Impersonator tries to answer
    const unauthorizedAns = env.mailbox.answerRequest({
      requestId: reqId,
      agentId: 'malicious-agent',
      response: 'SPOOFED_DATA',
      status: 'completed'
    });

    assert.equal(unauthorizedAns.status, 'quarantined');
    assert.equal(unauthorizedAns.quarantined, true);
    assert.ok(unauthorizedAns.error.includes('Unauthorized'));

    // Request must still be pending
    const req = env.mailbox.getRequest(reqId);
    assert.equal(req.status, 'pending');
    assert.equal(req.response, null);
  });

  await t.test('7. Fault Injection: Crash between outbox commit and publish recovers on startup', async () => {
    // Simulate crash: insert directly into bridge_outbox with published_at = NULL
    const crashedEventId = 99999;
    const now = new Date().toISOString();
    env.logger.db.prepare(`
      INSERT INTO bridge_outbox (
        event_id, timestamp, type, agent_id, from_agent, conversation_id, request_id, task_id, status, payload, dedup_key, published_at
      ) VALUES (?, ?, 'crashed_completion', 'recover-agent', 'system', 'conv_crash', 'req_crash_1', NULL, 'completed', '{"data":"CRASH_RECOVERED"}', 'crash_dedup_1', NULL)
    `).run(crashedEventId, now);

    const received = [];
    const sub = env.eventBus.subscribe('recover-agent', (evt) => {
      received.push(evt);
    });

    // Simulate system restart running recoverPendingOutbox
    const flushedCount = env.eventBus.outbox.recoverPendingOutbox();
    assert.ok(flushedCount >= 1, 'Must flush un-published outbox events');

    // Outbox row must now be marked published
    const row = env.logger.db.prepare('SELECT published_at FROM bridge_outbox WHERE event_id = ?').get(crashedEventId);
    assert.ok(row.published_at !== null, 'Published timestamp must be populated');

    // Subscriber must have received the flushed event
    assert.ok(received.some(ev => ev.eventId === crashedEventId));

    sub.unsubscribe();
  });

  await t.test('8. Fault Injection: Duplicate events with dedupKey are strictly idempotent', () => {
    const dedupKey = 'unique_dedup_test_key_101';
    const first = env.eventBus.publish({
      type: 'idempotent_event',
      agentId: 'test-agent',
      payload: { test: 1 },
      dedupKey
    });

    assert.ok(first.eventId);
    assert.equal(first.isDuplicate, undefined);

    const second = env.eventBus.publish({
      type: 'idempotent_event',
      agentId: 'test-agent',
      payload: { test: 2 },
      dedupKey
    });

    assert.equal(second.isDuplicate, true);
    assert.equal(second.eventId, first.eventId);

    // Verify exactly one row exists in bridge_events for this dedup_key
    const count = env.logger.db.prepare('SELECT COUNT(*) as cnt FROM bridge_events WHERE dedup_key = ?').get(dedupKey).cnt;
    assert.equal(count, 1);
  });

  await t.test('9. Fault Injection: Requester timeout followed by slow completion does not corrupt state', async () => {
    const reqId = 'req_slow_timeout_1';

    // Requester sets short timeout (30ms)
    const timeoutRes = await env.mailbox.askAgent({
      fromAgent: 'requester-impatient',
      toAgent: 'worker-slow',
      question: 'Long computation',
      requestId: reqId,
      timeoutMs: 30
    });

    assert.equal(timeoutRes.status, 'timeout');
    assert.equal(timeoutRes.recoverable, true);

    // Slow worker claims task
    const task = env.tasks.claimNextTask('worker-slow');
    assert.ok(task);

    // Worker completes after timeout
    env.mailbox.submitTaskResult({
      taskId: task.id,
      agentId: 'worker-slow',
      status: 'completed',
      result: 'SLOW_COMPUTATION_SUCCESS',
      attemptId: task.attemptId,
      epoch: task.epoch
    });

    // Reconnecting requester receives durable completed response
    const reconnected = await env.mailbox.askAgent({
      fromAgent: 'requester-impatient',
      toAgent: 'worker-slow',
      question: 'Long computation',
      requestId: reqId,
      timeoutMs: 5000
    });

    assert.equal(reconnected.status, 'completed');
    assert.equal(reconnected.response, 'SLOW_COMPUTATION_SUCCESS');
  });
});
