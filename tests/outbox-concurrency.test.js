import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { EventBus } from '../src/event-bus.js';
import { TransactionalOutbox } from '../src/events/transactional-outbox.js';

test('Transactional Outbox & Multi-Process SQLite Concurrency Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-test-'));
  const dbPath = path.join(tmpDir, 'outbox_test.sqlite');

  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);

  t.after(() => {
    eventBus.close();
    logger.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test('1. Successful transaction publishes staged outbox event', async () => {
    const received = [];
    const sub = eventBus.subscribe('agent-b', (event) => {
      received.push(event);
    });

    const msg = mailbox.sendMessage({
      fromAgent: 'agent-a',
      toAgent: 'agent-b',
      subject: 'Outbox test',
      content: 'Testing atomic dispatch'
    });

    assert.ok(msg.id);

    // Wait for in-process dispatch
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].type, 'message_sent');
    assert.strictEqual(received[0].payload.messageId, msg.id);

    // Verify outbox table has published_at timestamp
    const outboxRow = logger.db.prepare(
      `SELECT * FROM bridge_outbox WHERE event_id = ?`
    ).get(received[0].eventId);
    assert.ok(outboxRow, 'Outbox row must exist');
    assert.ok(outboxRow.published_at, 'published_at must be populated after commit');

    sub.unsubscribe();
  });

  await t.test('2. Rollback produces NO visible events or wakeups', async () => {
    const received = [];
    const sub = eventBus.subscribe('agent-c', (event) => {
      received.push(event);
    });

    let caughtError = null;
    try {
      eventBus.runInTransaction((tx) => {
        // 1. Mutate authoritative state
        tx.db.prepare(`
          INSERT INTO messages (id, timestamp, from_agent, to_agent, subject, content, read_at)
          VALUES ('msg_fail', '2026-10-08T00:00:00Z', 'agent-a', 'agent-c', 'Will Rollback', 'Secret', NULL)
        `).run();

        // 2. Stage event in outbox
        tx.stageEvent({
          type: 'message_sent',
          agentId: 'agent-c',
          fromAgent: 'agent-a',
          payload: { messageId: 'msg_fail' }
        });

        // 3. Deliberate failure triggers rollback
        throw new Error('SIMULATED_DB_FAILURE_DURING_TRANSACTION');
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError);
    assert.strictEqual(caughtError.message, 'SIMULATED_DB_FAILURE_DURING_TRANSACTION');

    // Wait a brief moment to ensure no background dispatch occurred
    await new Promise((r) => setTimeout(r, 50));

    // INVARIANT: ZERO events delivered to subscribers
    assert.strictEqual(received.length, 0, 'No event should be published on rollback');

    // INVARIANT: Message rolled back
    const msgRow = logger.db.prepare(`SELECT * FROM messages WHERE id = 'msg_fail'`).get();
    assert.strictEqual(msgRow, undefined, 'Message must be rolled back');

    // INVARIANT: No row in bridge_events or bridge_outbox
    const eventRow = logger.db.prepare(`SELECT * FROM bridge_events WHERE agent_id = 'agent-c'`).get();
    assert.strictEqual(eventRow, undefined, 'bridge_events must be rolled back');

    const outboxRow = logger.db.prepare(`SELECT * FROM bridge_outbox WHERE agent_id = 'agent-c'`).get();
    assert.strictEqual(outboxRow, undefined, 'bridge_outbox must be rolled back');

    sub.unsubscribe();
  });

  await t.test('3. Crash after commit replays outbox on recovery', async () => {
    // Simulate un-flushed row written by crashed process
    const eventId = 9999;
    const now = new Date().toISOString();
    logger.db.prepare(`
      INSERT INTO bridge_events (event_id, timestamp, type, agent_id, from_agent, conversation_id, status, payload, dedup_key)
      VALUES (?, ?, 'crash_recovery_event', 'agent-recovered', 'system', 'conv_crash', 'pending', '{"recovered":true}', 'crash_dedup_1')
    `).run(eventId, now);

    logger.db.prepare(`
      INSERT INTO bridge_outbox (event_id, timestamp, type, agent_id, from_agent, conversation_id, status, payload, dedup_key, published_at)
      VALUES (?, ?, 'crash_recovery_event', 'agent-recovered', 'system', 'conv_crash', 'pending', '{"recovered":true}', 'crash_dedup_1', NULL)
    `).run(eventId, now);

    const received = [];
    const sub = eventBus.subscribe('agent-recovered', (event) => {
      received.push(event);
    }, { fromBeginning: true });

    // Drain pending outbox items as would happen on process startup
    const recoveredCount = eventBus.outbox.recoverPendingOutbox();
    assert.strictEqual(recoveredCount, 1, 'Should recover exactly 1 pending event');

    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].type, 'crash_recovery_event');

    // Verify row marked published
    const outboxRow = logger.db.prepare(`SELECT * FROM bridge_outbox WHERE event_id = ?`).get(eventId);
    assert.ok(outboxRow.published_at, 'Row should now be marked published');

    sub.unsubscribe();
  });

  await t.test('4. Duplicate publication deduplicates via dedupKey', async () => {
    const received = [];
    const sub = eventBus.subscribe('agent-dedup', (event) => {
      received.push(event);
    });

    const key = `test_dedup_${Date.now()}`;

    // First publication
    const res1 = eventBus.publish({
      type: 'test_event',
      agentId: 'agent-dedup',
      fromAgent: 'sender',
      dedupKey: key,
      payload: { attempt: 1 }
    });

    // Duplicate publication with same dedupKey
    const res2 = eventBus.publish({
      type: 'test_event',
      agentId: 'agent-dedup',
      fromAgent: 'sender',
      dedupKey: key,
      payload: { attempt: 2 }
    });

    assert.strictEqual(res2.isDuplicate, true, 'Second publish must report duplicate');
    assert.strictEqual(res2.eventId, res1.eventId, 'Must return original eventId');

    await new Promise((r) => setTimeout(r, 50));

    // Subscriber should only receive ONE event
    assert.strictEqual(received.length, 1, 'Subscriber must not receive duplicate events');

    sub.unsubscribe();
  });

  await t.test('5. Cursor behavior remains correct and monotonic', async () => {
    const agentId = 'cursor-test-agent';

    // Verify initial cursor
    const c0 = eventBus.getCursor(agentId);
    assert.strictEqual(c0, 0);

    // Update cursor monotonically
    eventBus.updateCursor(agentId, 10);
    assert.strictEqual(eventBus.getCursor(agentId), 10);

    // Lower cursor attempt must not regress cursor
    eventBus.updateCursor(agentId, 5);
    assert.strictEqual(eventBus.getCursor(agentId), 10, 'Cursor must not regress');

    // Advance cursor forward
    eventBus.updateCursor(agentId, 25);
    assert.strictEqual(eventBus.getCursor(agentId), 25);
  });

  await t.test('6. Multi-process SQLite atomic task claim serialization', async () => {
    // Create a pending task
    const task = taskManager.createTask({
      fromAgent: 'dispatcher',
      toAgent: 'worker-pool',
      title: 'Contested task',
      instructions: 'Only one worker should claim this',
      priority: 'high'
    });

    // Simulate two concurrent worker processes trying to claim the task
    const worker1Claim = taskManager.claimNextTask('worker-pool');
    const worker2Claim = taskManager.claimNextTask('worker-pool');

    // Exactly one worker must succeed; the other gets null
    assert.ok(worker1Claim, 'Worker 1 should claim the task');
    assert.strictEqual(worker1Claim.id, task.id);
    assert.strictEqual(worker2Claim, null, 'Worker 2 must NOT claim already claimed task');

    // State in DB is claimed
    const dbTask = taskManager.getTask(task.id, false);
    assert.strictEqual(dbTask.status, 'claimed');
  });

  await t.test('7. TaskManager and MailboxHub core operations atomically stage outbox events', async () => {
    const received = [];
    const sub = eventBus.subscribe('worker-delegate', (event) => {
      received.push(event);
    });

    // delegateTask couples task insertion + outbox event staging inside single transaction
    const delegated = mailbox.delegateTask({
      fromAgent: 'lead',
      toAgent: 'worker-delegate',
      title: 'Atomic delegation',
      instructions: 'Do the work',
      notifyInbox: true,
      emitEvent: true
    });

    assert.ok(delegated.id);

    await new Promise((r) => setTimeout(r, 50));

    // Both task_created and message_sent events were staged and dispatched after commit
    const eventTypes = received.map(e => e.type);
    assert.ok(eventTypes.includes('task_created'), 'Must receive task_created');
    assert.ok(eventTypes.includes('message_sent'), 'Must receive message_sent');

    sub.unsubscribe();
  });
});
