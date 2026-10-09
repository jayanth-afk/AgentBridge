import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AuditLogger } from '../src/audit-logger.js';
import { RequestTracer, LifecycleStage } from '../src/diagnostics/request-tracer.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';

test('RequestTracer: lifecycle retention, active-record preservation, and batching', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracer-retention-'));
  const dbPath = path.join(tmpDir, 'retention.sqlite');
  const logger = new AuditLogger(dbPath);
  const tracer = new RequestTracer(logger);
  const taskManager = new TaskManager(logger);
  const mailbox = new MailboxHub(logger, taskManager);

  t.after(() => {
    try { logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const tenDaysAgoIso = new Date(now - 10 * oneDayMs).toISOString();
  const twoDaysAgoIso = new Date(now - 2 * oneDayMs).toISOString();

  await t.test('1. Old terminal records are pruned past the retention window', async () => {
    // Insert a completed request older than 7 days
    const reqCompleted = 'req_old_completed';
    logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, created_at, updated_at, completed_at)
      VALUES (?, 'c1', 'gemini', 'chatgpt-desktop', 'q1', 'completed', ?, ?, ?)
    `).run(reqCompleted, tenDaysAgoIso, tenDaysAgoIso, tenDaysAgoIso);

    // Record lifecycle events for this request with 10-day-old timestamps
    logger.db.prepare(`
      INSERT INTO request_lifecycle (request_id, stage, wall_clock, monotonic_ms)
      VALUES (?, ?, ?, ?)
    `).run(reqCompleted, LifecycleStage.REQUEST_CREATED, tenDaysAgoIso, 100.0);
    logger.db.prepare(`
      INSERT INTO request_lifecycle (request_id, stage, wall_clock, monotonic_ms)
      VALUES (?, ?, ?, ?)
    `).run(reqCompleted, LifecycleStage.RESPONSE_RETURNED, tenDaysAgoIso, 200.0);

    // Insert a recent completed request (2 days old)
    const reqRecent = 'req_recent_completed';
    logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, created_at, updated_at, completed_at)
      VALUES (?, 'c2', 'gemini', 'chatgpt-desktop', 'q2', 'completed', ?, ?, ?)
    `).run(reqRecent, twoDaysAgoIso, twoDaysAgoIso, twoDaysAgoIso);

    logger.db.prepare(`
      INSERT INTO request_lifecycle (request_id, stage, wall_clock, monotonic_ms)
      VALUES (?, ?, ?, ?)
    `).run(reqRecent, LifecycleStage.REQUEST_CREATED, twoDaysAgoIso, 300.0);

    const statsBefore = tracer.getStats();
    assert.equal(statsBefore.totalRecords, 3);

    // Prune with 7-day retention window
    const pruneRes = tracer.prune({ retentionMs: 7 * oneDayMs, now });
    assert.equal(pruneRes.pruned, 2, 'should prune exactly the 2 records older than 7 days');

    const remaining = tracer.getTimeline(reqRecent);
    assert.equal(remaining.length, 1, 'recent records must survive');

    const oldTimeline = tracer.getTimeline(reqCompleted);
    assert.equal(oldTimeline.length, 0, 'old terminal records must be pruned');

    const statsAfter = tracer.getStats();
    assert.equal(statsAfter.totalRecords, 1);
  });

  await t.test('2. Records for ACTIVE / PENDING requests are strictly preserved, even if older than retention', async () => {
    // Insert an active/pending request created 15 days ago
    const reqPending = 'req_old_pending_in_flight';
    const fifteenDaysAgoIso = new Date(now - 15 * oneDayMs).toISOString();

    logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, created_at, updated_at)
      VALUES (?, 'c3', 'gemini', 'chatgpt-desktop', 'pending question', 'pending', ?, ?)
    `).run(reqPending, fifteenDaysAgoIso, fifteenDaysAgoIso);

    logger.db.prepare(`
      INSERT INTO request_lifecycle (request_id, stage, wall_clock, monotonic_ms)
      VALUES (?, ?, ?, ?)
    `).run(reqPending, LifecycleStage.REQUEST_CREATED, fifteenDaysAgoIso, 400.0);

    logger.db.prepare(`
      INSERT INTO request_lifecycle (request_id, stage, wall_clock, monotonic_ms)
      VALUES (?, ?, ?, ?)
    `).run(reqPending, LifecycleStage.PROVIDER_SUBMITTED, fifteenDaysAgoIso, 500.0);

    // Attempt to prune: active records must NEVER be deleted
    const pruneRes = tracer.prune({ retentionMs: 7 * oneDayMs, now });
    assert.equal(pruneRes.pruned, 0, 'active request records must NOT be pruned');

    const timeline = tracer.getTimeline(reqPending);
    assert.equal(timeline.length, 2, 'pending request timeline must remain intact for crash recovery');

    // Now complete the request
    logger.db.prepare(`
      UPDATE bridge_requests SET status = 'completed', completed_at = ? WHERE request_id = ?
    `).run(new Date().toISOString(), reqPending);

    // Now it should prune
    const pruneAfterCompleted = tracer.prune({ retentionMs: 7 * oneDayMs, now });
    assert.equal(pruneAfterCompleted.pruned, 2, 'records become prunable once the request is terminal');
  });

  await t.test('3. Records linked to active TASKS are strictly preserved', async () => {
    const taskId = 'task_active_recovery';
    const reqId = 'req_with_active_task';
    const twelveDaysAgoIso = new Date(now - 12 * oneDayMs).toISOString();

    // The request row might be missing or unlinked, but task is still active
    logger.db.prepare(`
      INSERT INTO tasks (id, from_agent, to_agent, title, instructions, status, created_at, updated_at)
      VALUES (?, 'claude-desktop', 'chatgpt-desktop', 'active task', 'do work', 'in_progress', ?, ?)
    `).run(taskId, twelveDaysAgoIso, twelveDaysAgoIso);

    logger.db.prepare(`
      INSERT INTO request_lifecycle (request_id, task_id, stage, wall_clock, monotonic_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(reqId, taskId, LifecycleStage.TASK_CLAIMED, twelveDaysAgoIso, 600.0);

    const pruneRes = tracer.prune({ retentionMs: 7 * oneDayMs, now });
    assert.equal(pruneRes.pruned, 0, 'must preserve records associated with non-terminal tasks');

    // Complete the task
    logger.db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run(taskId);

    const pruneAfter = tracer.prune({ retentionMs: 7 * oneDayMs, now });
    assert.equal(pruneAfter.pruned, 1, 'prunes once the task is complete');
  });

  await t.test('4. Batching limits the number of rows deleted per invocation', async () => {
    const twentyDaysAgo = new Date(now - 20 * oneDayMs).toISOString();

    // Insert 10 old records for unlinked/terminal requests
    for (let i = 0; i < 10; i++) {
      logger.db.prepare(`
        INSERT INTO request_lifecycle (request_id, stage, wall_clock, monotonic_ms)
        VALUES (?, ?, ?, ?)
      `).run(`req_batch_${i}`, LifecycleStage.REQUEST_CREATED, twentyDaysAgo, i * 10);
    }

    // Prune with batch limit of 4
    const res1 = tracer.prune({ retentionMs: 7 * oneDayMs, maxBatch: 4, now });
    assert.equal(res1.pruned, 4);
    assert.equal(res1.hasMore, true);

    const res2 = tracer.prune({ retentionMs: 7 * oneDayMs, maxBatch: 4, now });
    assert.equal(res2.pruned, 4);
    assert.equal(res2.hasMore, true);

    const res3 = tracer.prune({ retentionMs: 7 * oneDayMs, maxBatch: 4, now });
    assert.equal(res3.pruned, 2);
    assert.equal(res3.hasMore, false);
  });

  await t.test('5. MailboxHub exposes prune and stats cleanly', async () => {
    const stats = mailbox.getRequestLifecycleStats();
    assert.ok(typeof stats.totalRecords === 'number');

    const res = mailbox.pruneRequestLifecycle({ retentionMs: 7 * oneDayMs, now });
    assert.equal(typeof res.pruned, 'number');
  });
});
