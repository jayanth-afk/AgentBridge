import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AttemptLedger, AttemptState } from '../src/attempts/attempt-ledger.js';

test('AttemptLedger: Monotonic Fencing & Late Response Quarantine', async (t) => {
  const db = new DatabaseSync(':memory:');
  const mockLogger = { db, log: () => {} };
  const ledger = new AttemptLedger(mockLogger);

  await t.test('1. Monotonic Epoch Advancement on Subsequent Attempts', () => {
    const att1 = ledger.createAttempt({
      taskId: 'task_alpha',
      agentId: 'chatgpt-desktop',
      routeId: 'chatgpt-local-engine'
    });

    assert.equal(att1.epoch, 1);
    assert.equal(att1.attemptNumber, 1);
    assert.equal(att1.state, AttemptState.CREATED);
    assert.ok(att1.nonce && att1.nonce.length >= 16);

    const att2 = ledger.createAttempt({
      taskId: 'task_alpha',
      agentId: 'claude-desktop',
      routeId: 'mcp-stdio'
    });

    assert.equal(att2.epoch, 2);
    assert.equal(att2.attemptNumber, 2);
    assert.equal(att2.state, AttemptState.CREATED);

    // Old attempt 1 is automatically fenced
    const oldAtt1 = ledger.getAttempt(att1.attemptId);
    assert.equal(oldAtt1.state, AttemptState.FENCED);
  });

  await t.test('2. Fenced/Stale Attempt cannot validate fencing or produce effects', () => {
    const att1 = ledger.listAttemptsForTask('task_alpha')[0];
    assert.equal(att1.epoch, 1);

    assert.throws(() => {
      ledger.validateFencing({
        taskId: 'task_alpha',
        attemptId: att1.attemptId,
        epoch: 1,
        agentId: 'chatgpt-desktop'
      });
    }, (err) => {
      return err.code === 'FENCED_ATTEMPT_ERROR';
    });

    assert.throws(() => {
      ledger.touchAttempt(att1.attemptId, 1, 'chatgpt-desktop');
    }, (err) => {
      return err.code === 'FENCED_ATTEMPT_ERROR';
    });
  });

  await t.test('3. Stale attempt late completion is quarantined and cannot mutate state', () => {
    const att1 = ledger.listAttemptsForTask('task_alpha')[0];

    const result = ledger.completeAttempt({
      attemptId: att1.attemptId,
      epoch: 1,
      result: 'Late zombie response text'
    });

    assert.equal(result.status, AttemptState.QUARANTINED);
    assert.equal(result.quarantined, true);

    // Check quarantine ledger
    const quarantined = ledger.getQuarantinedResponses(att1.requestId);
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0].attempt_id, att1.attemptId);
    assert.ok(quarantined[0].reason.includes('FENCED_ATTEMPT_ERROR'));
  });

  await t.test('4. Active Attempt Completes cleanly with matching epoch', () => {
    const activeAtt = ledger.getActiveAttemptForTask('task_alpha');
    assert.equal(activeAtt.epoch, 2);

    ledger.acquireAttempt(activeAtt.attemptId, 'claude-desktop');
    const running = ledger.getAttempt(activeAtt.attemptId);
    assert.equal(running.state, AttemptState.ACTIVE);

    const completed = ledger.completeAttempt({
      attemptId: activeAtt.attemptId,
      epoch: 2,
      result: { answer: 'Valid result from epoch 2' }
    });

    assert.equal(completed.state, AttemptState.COMPLETED);
    assert.ok(completed.completedAt);
    assert.ok(completed.result.includes('Valid result from epoch 2'));
  });

  await t.test('5. Terminal state cannot be re-completed or re-acquired', () => {
    const activeAtt = ledger.getActiveAttemptForTask('task_alpha');
    assert.equal(activeAtt.state, AttemptState.COMPLETED);

    assert.throws(() => {
      ledger.acquireAttempt(activeAtt.attemptId, 'claude-desktop');
    }, /terminal state/);
  });
});
