import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EffectsLedger, EffectClassification, EffectState } from '../src/effects/effects-ledger.js';
import { AttemptLedger } from '../src/attempts/attempt-ledger.js';

test('EffectsLedger: Idempotency & Fenced Effect Protection', async (t) => {
  const db = new DatabaseSync(':memory:');
  const mockLogger = { db, log: () => {} };
  const attemptLedger = new AttemptLedger(mockLogger);
  const effectsLedger = new EffectsLedger(mockLogger);

  const attempt = attemptLedger.createAttempt({
    taskId: 'task_eff_1',
    agentId: 'chatgpt-desktop'
  });

  await t.test('1. Record intent and commit effect with idempotency key', () => {
    const key = 'git_commit_hash_xyz';
    const intent = effectsLedger.recordIntent({
      idempotencyKey: key,
      attemptId: attempt.attemptId,
      taskId: 'task_eff_1',
      epoch: attempt.epoch,
      agentId: 'chatgpt-desktop',
      operation: 'git_commit',
      classification: EffectClassification.NON_IDEMPOTENT,
      params: { message: 'feat: add stuff' },
      attemptLedger
    });

    assert.equal(intent.alreadyCommitted, false);
    assert.equal(intent.state, EffectState.INTENT_RECORDED);

    effectsLedger.markExecuting(intent.effectId);
    effectsLedger.commitEffect(intent.effectId, { commitHash: 'abc1234' });

    // Calling again with same idempotency key returns cached committed result!
    const replay = effectsLedger.recordIntent({
      idempotencyKey: key,
      attemptId: attempt.attemptId,
      taskId: 'task_eff_1',
      epoch: attempt.epoch,
      agentId: 'chatgpt-desktop',
      operation: 'git_commit',
      attemptLedger
    });

    assert.equal(replay.alreadyCommitted, true);
    assert.equal(replay.result.commitHash, 'abc1234');
  });

  await t.test('2. Stale epoch attempt CAN NEVER produce effects', () => {
    // Supersede attempt with new epoch
    const newAttempt = attemptLedger.createAttempt({
      taskId: 'task_eff_1',
      agentId: 'claude-desktop'
    });
    assert.equal(newAttempt.epoch, 2);

    // Old attempt trying to record effect
    assert.throws(() => {
      effectsLedger.recordIntent({
        idempotencyKey: 'stale_op_key',
        attemptId: attempt.attemptId,
        taskId: 'task_eff_1',
        epoch: attempt.epoch, // 1 is now stale!
        agentId: 'chatgpt-desktop',
        operation: 'create_file',
        attemptLedger
      });
    }, (err) => {
      return err.code === 'FENCED_ATTEMPT_ERROR';
    });
  });

  await t.test('3. Interrupted effect becomes UNKNOWN, not FAILED, and refuses blind retry', () => {
    const activeAtt = attemptLedger.getActiveAttemptForTask('task_eff_1');
    const intent = effectsLedger.recordIntent({
      idempotencyKey: 'external_push_1',
      attemptId: activeAtt.attemptId,
      taskId: 'task_eff_1',
      epoch: activeAtt.epoch,
      agentId: 'claude-desktop',
      operation: 'git_push',
      classification: EffectClassification.EXTERNAL,
      attemptLedger
    });

    effectsLedger.markExecuting(intent.effectId);

    // Simulate crash sweep
    const transitioned = effectsLedger.sweepIncompleteEffects(0);
    assert.ok(transitioned.includes(intent.effectId));

    const eff = effectsLedger.getEffect(intent.effectId);
    assert.equal(eff.state, EffectState.UNKNOWN);

    // Attempting to blindly re-run the same operation is refused!
    assert.throws(() => {
      effectsLedger.recordIntent({
        idempotencyKey: 'external_push_1',
        attemptId: activeAtt.attemptId,
        taskId: 'task_eff_1',
        epoch: activeAtt.epoch,
        agentId: 'claude-desktop',
        operation: 'git_push',
        classification: EffectClassification.EXTERNAL,
        attemptLedger
      });
    }, (err) => {
      return err.code === 'EFFECT_UNRECONCILED';
    });
  });
});
