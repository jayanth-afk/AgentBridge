import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { EventBus } from '../src/event-bus.js';
import { TransactionalOutbox } from '../src/events/transactional-outbox.js';

test('TransactionalOutbox: Atomic Commit, Rollback Safety & Deduplication', async (t) => {
  const db = new DatabaseSync(':memory:');
  const mockLogger = { db, dbPath: ':memory:', log: () => {} };
  const eventBus = new EventBus(mockLogger);
  const outbox = eventBus.outbox;

  await t.test('1. Rolled back transaction produces NO visible events or wakeups', () => {
    let receivedCount = 0;
    eventBus.subscribe('chatgpt-desktop', () => {
      receivedCount++;
    });

    assert.throws(() => {
      outbox.runInTransaction((tx) => {
        tx.stageEvent({
          type: 'task_created',
          agentId: 'chatgpt-desktop',
          taskId: 'task_should_rollback'
        });
        // Intentionally throw inside transaction
        throw new Error('Database transaction abort simulated');
      });
    }, /Database transaction abort simulated/);

    // Verify consumer received nothing
    assert.equal(receivedCount, 0);

    // Verify database table has no event
    const row = db.prepare(`SELECT * FROM bridge_events WHERE task_id = 'task_should_rollback'`).get();
    assert.equal(row, undefined);
  });

  await t.test('2. Committed transaction dispatches events ONLY AFTER commit', () => {
    const received = [];
    eventBus.subscribe('claude-desktop', (evt) => {
      received.push(evt);
    });

    const res = outbox.runInTransaction((tx) => {
      tx.stageEvent({
        type: 'request_created',
        agentId: 'claude-desktop',
        requestId: 'req_committed_1',
        payload: { query: 'Hello' }
      });
      return { success: true };
    });

    assert.equal(res.success, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].requestId, 'req_committed_1');

    // Verify database row exists
    const row = db.prepare(`SELECT * FROM bridge_events WHERE request_id = 'req_committed_1'`).get();
    assert.ok(row);
  });

  await t.test('3. Event deduplication invariant: duplicate dedupKey produces NO duplicate events', () => {
    const key = 'dedup_unique_txn_123';

    const evt1 = eventBus.publish({
      type: 'state_changed',
      agentId: 'claude-desktop',
      dedupKey: key,
      payload: { iteration: 1 }
    });

    assert.equal(evt1.isDuplicate, undefined);

    const evt2 = eventBus.publish({
      type: 'state_changed',
      agentId: 'claude-desktop',
      dedupKey: key,
      payload: { iteration: 2 }
    });

    assert.equal(evt2.isDuplicate, true);
    assert.equal(evt2.eventId, evt1.eventId);

    const countRow = db.prepare(`SELECT COUNT(*) as count FROM bridge_events WHERE dedup_key = ?`).get(key);
    assert.equal(countRow.count, 1);
  });
});
