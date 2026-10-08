import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { EventBus } from '../src/event-bus.js';
import { AttemptLedger } from '../src/attempts/attempt-ledger.js';
import { CapabilityRegistry, TrustTier, CapabilityState, CapabilityDimension } from '../src/capabilities/capability-registry.js';
import { TransportOutcome, TransportResult, SafeRouteScheduler } from '../src/transports/transport-contract.js';
import { ResponseCorrelatorV2, CorrelationTier, CorrelationConfidence } from '../src/correlation/response-correlator-v2.js';
import { EffectsLedger, EffectClassification, EffectState } from '../src/effects/effects-ledger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { GrantManager } from '../src/security/grant-manager.js';

test('Agent Bridge v2 — End-to-End Adversarial Integration & Invariants Suite', async (t) => {
  const dbPath = path.join('data', `test_adv_${Date.now()}.sqlite`);
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const attemptLedger = new AttemptLedger(logger);
  const taskManager = new TaskManager(logger, attemptLedger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const capRegistry = new CapabilityRegistry(logger);
  const correlator = new ResponseCorrelatorV2();
  const effectsLedger = new EffectsLedger(logger, attemptLedger);

  t.after(() => {
    eventBus.close();
    for (const suffix of ['', '-wal', '-shm', '.notify']) {
      try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
    }
  });

  // --------------------------------------------------------------------------
  // PRIMARY SCENARIO: Complete Happy Path Lifecycle
  // --------------------------------------------------------------------------
  await t.test('Scenario: Complete End-to-End Autonomous Request -> Task -> Attempt -> Verification -> Completion', async () => {
    // 1. Register and verify capability
    capRegistry.setCapability({
      agentId: 'fake_worker',
      routeId: 'fake_route',
      dimension: CapabilityDimension.MODEL_EXECUTION,
      state: CapabilityState.VERIFIED,
      trustTier: TrustTier.T1_AUTHENTICATED_MCP,
      evidence: 'Direct test fixture'
    });
    capRegistry.setCapability({
      agentId: 'fake_worker',
      routeId: 'fake_route',
      dimension: CapabilityDimension.AUTONOMOUS_WAKEUP,
      state: CapabilityState.VERIFIED,
      trustTier: TrustTier.T1_AUTHENTICATED_MCP,
      evidence: 'Direct test fixture'
    });

    const cap = capRegistry.getCapability('fake_worker', 'fake_route', CapabilityDimension.MODEL_EXECUTION);
    assert.equal(cap.state, CapabilityState.VERIFIED, 'Worker must have verified capability');

    // 2. Requester creates request
    const askPromise = mailbox.askAgent({
      fromAgent: 'fake_requester',
      toAgent: 'fake_worker',
      question: 'Calculate 42 * 2',
      timeoutMs: 5000
    });

    // 3. Worker wakes on event and claims task (ACK)
    const claimed = taskManager.claimNextTask('fake_worker');
    assert.ok(claimed, 'Worker successfully claimed task');
    assert.ok(claimed.attemptId, 'Claim created first-class attempt');
    assert.equal(claimed.epoch, 1, 'Initial attempt epoch is 1');
    assert.ok(claimed.nonce, 'Attempt has nonce token');

    // 4. Worker executes and embeds nonce token in response
    const rawAnswer = correlator.embedNonceInPrompt('The answer is 84.', claimed.nonce);
    const correlation = correlator.correlate({
      requestId: `req_for_${claimed.id}`,
      attemptId: claimed.attemptId,
      epoch: claimed.epoch,
      expectedNonce: claimed.nonce,
      rawResponse: rawAnswer
    });

    assert.equal(correlation.confidence, CorrelationConfidence.VERIFIED);
    assert.equal(correlation.tier, CorrelationTier.TIER_3_NONCE_TOKEN_ECHO);

    // 5. Worker answers request with authenticated attempt credentials
    const submitRes = mailbox.submitTaskResult({
      taskId: claimed.id,
      agentId: 'fake_worker',
      status: 'completed',
      result: correlation.cleanedResponse,
      attemptId: claimed.attemptId,
      epoch: claimed.epoch
    });

    assert.equal(submitRes.status, 'completed');

    // 6. Requester receives correlated result without polling
    const finalOutcome = await askPromise;
    assert.equal(finalOutcome.status, 'completed');
    assert.equal(finalOutcome.response, 'The answer is 84.');

    // 7. Verify attempt terminal state in AttemptLedger
    const finishedAttempt = attemptLedger.getAttempt(claimed.attemptId);
    assert.equal(finishedAttempt.state, 'completed');
    assert.equal(finishedAttempt.result, 'The answer is 84.');
  });

  // --------------------------------------------------------------------------
  // VARIANT 1: Agent crashes before ACK
  // --------------------------------------------------------------------------
  await t.test('Variant 1: Agent crashes before ACK -> Task remains pending and request times out safely', async () => {
    const askPromise = mailbox.askAgent({
      fromAgent: 'fake_requester',
      toAgent: 'crashed_agent',
      question: 'Process telemetry',
      timeoutMs: 150 // short timeout
    });

    // Agent never calls claimNextTask (crashed)
    const outcome = await askPromise;
    assert.equal(outcome.mode, 'request_timeout');

    // Verify request is marked timeout in DB
    const req = mailbox.getRequest(outcome.requestId);
    assert.equal(req.status, 'timeout');
  });

  // --------------------------------------------------------------------------
  // VARIANT 2: Agent crashes after ACK (Lease Expiration & Monotonic Retry)
  // --------------------------------------------------------------------------
  await t.test('Variant 2: Agent crashes after ACK -> Lease recovery advances epoch monotonically', async () => {
    const task = taskManager.createTask({
      fromAgent: 'fake_requester',
      toAgent: 'flakey_agent',
      title: 'Crash task',
      instructions: 'Do work',
      timeoutMs: 10 // 10ms lease
    });

    // Claim 1
    const claim1 = taskManager.claimNextTask('flakey_agent');
    assert.equal(claim1.epoch, 1);
    const attempt1Id = claim1.attemptId;

    // Simulate agent crash: wait 25ms so lease expires
    await new Promise(r => setTimeout(r, 25));

    // Recovery runs on next scheduler turn
    const recovered = taskManager.recoverExpiredTasks('flakey_agent');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'pending');

    // Second agent claims recovered task -> MUST receive epoch 2
    const claim2 = taskManager.claimNextTask('flakey_agent');
    assert.equal(claim2.epoch, 2);
    assert.notEqual(claim2.attemptId, attempt1Id);

    // Prior attempt 1 must be fenced
    const att1 = attemptLedger.getAttempt(attempt1Id);
    assert.equal(att1.state, 'fenced');
  });

  // --------------------------------------------------------------------------
  // VARIANT 3: Agent becomes stale (Fenced Attempt Submission Blocked)
  // --------------------------------------------------------------------------
  await t.test('Variant 3: Stale agent attempts submission with old epoch -> Blocked with FENCED_ATTEMPT_ERROR', async () => {
    const task = taskManager.createTask({
      fromAgent: 'fake_requester',
      toAgent: 'worker_c',
      title: 'Stale test',
      instructions: 'Run'
    });

    const att1 = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'worker_c',
      routeId: 'route_1'
    });

    // Supercede with att2 (epoch 2)
    const att2 = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'worker_c',
      routeId: 'route_2'
    });

    assert.equal(att1.epoch, 1);
    assert.equal(att2.epoch, 2);

    // Stale worker 1 tries to submit using old attempt 1
    assert.throws(() => {
      taskManager.updateTaskStatus({
        taskId: task.id,
        agentId: 'worker_c',
        status: 'completed',
        result: 'Stale late result',
        attemptId: att1.attemptId,
        epoch: att1.epoch
      });
    }, /FENCED_ATTEMPT_ERROR/);
  });

  // --------------------------------------------------------------------------
  // VARIANT 4: Response has wrong nonce
  // --------------------------------------------------------------------------
  await t.test('Variant 4: Response with wrong nonce -> Fails correlation verification', () => {
    const expectedNonce = correlator.generateNonce('req_4', 'att_4', 1, 'route_4');
    const forgedNonce = correlator.generateNonce('req_fake', 'att_fake', 1, 'route_fake');

    const output = correlator.embedNonceInPrompt('Result text', forgedNonce);
    const result = correlator.correlate({
      requestId: 'req_4',
      attemptId: 'att_4',
      epoch: 1,
      expectedNonce,
      rawResponse: output
    });

    // Must NOT be verified
    assert.notEqual(result.confidence, CorrelationConfidence.VERIFIED);
    assert.equal(result.tier, CorrelationTier.TIER_5_HEURISTIC_TEXT);
  });

  // --------------------------------------------------------------------------
  // VARIANT 5: Response arrives after request timeout
  // --------------------------------------------------------------------------
  await t.test('Variant 5: Late response for timed-out attempt is quarantined, cannot mutate terminal state', () => {
    const task = taskManager.createTask({
      fromAgent: 'requester',
      toAgent: 'slow_agent',
      title: 'Slow task',
      instructions: 'Take forever'
    });

    const att = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'slow_agent',
      routeId: 'slow_route'
    });

    // Mark attempt failed/timed out
    attemptLedger.failAttempt({
      attemptId: att.attemptId,
      epoch: att.epoch,
      error: 'Timeout exceeded'
    });

    // Late response arrives later
    const late = attemptLedger.quarantineLateResponse({
      attemptId: att.attemptId,
      requestId: `req_${task.id}`,
      epoch: att.epoch,
      payload: 'Late computed value',
      reason: 'Attempt already in terminal failed state'
    });

    assert.ok(late.quarantineId);
    assert.equal(late.attemptId, att.attemptId);

    // Verify attempt remains failed (terminal state unchanged)
    const finalAtt = attemptLedger.getAttempt(att.attemptId);
    assert.equal(finalAtt.state, 'failed');
  });

  // --------------------------------------------------------------------------
  // VARIANT 6: Route returns SENT_UNCONFIRMED -> Blind fallback refused
  // --------------------------------------------------------------------------
  await t.test('Variant 6: SENT_UNCONFIRMED strictly refuses blind fallback', () => {
    const unconfirmed = new TransportResult({
      outcome: TransportOutcome.SENT_UNCONFIRMED,
      routeId: 'route_a'
    });
    const canResend = unconfirmed.canFallback();
    assert.equal(canResend, false, 'Blind fallback MUST be forbidden for unconfirmed send');

    const notSent = new TransportResult({
      outcome: TransportOutcome.NOT_SENT,
      routeId: 'route_a',
      nonDeliveryProven: true
    });
    const canFallback = notSent.canFallback();
    assert.equal(canFallback, true, 'Definitively not sent MAY fallback safely');
  });

  // --------------------------------------------------------------------------
  // VARIANT 7: Duplicate event deduplication
  // --------------------------------------------------------------------------
  await t.test('Variant 7: Duplicate event with same dedup_key produces NO duplicate events', () => {
    let wakes = 0;
    eventBus.subscribe('agent_dedup', () => wakes++);

    const evt1 = eventBus.publish({
      type: 'task_event',
      agentId: 'agent_dedup',
      dedupKey: 'unique_msg_key_101'
    });

    const evt2 = eventBus.publish({
      type: 'task_event',
      agentId: 'agent_dedup',
      dedupKey: 'unique_msg_key_101'
    });

    assert.equal(evt1.isDuplicate, undefined);
    assert.equal(evt2.isDuplicate, true);
    assert.equal(evt1.eventId, evt2.eventId);
  });

  // --------------------------------------------------------------------------
  // VARIANT 8: Duplicate effect idempotency
  // --------------------------------------------------------------------------
  await t.test('Variant 8: Duplicate effect key returns cached outcome without re-execution', () => {
    let executionTimes = 0;
    const task = taskManager.createTask({ fromAgent: 'a', toAgent: 'b', title: 't', instructions: 'i' });
    const att = attemptLedger.createAttempt({ taskId: task.id, agentId: 'b', routeId: 'r' });

    function executeSideEffect() {
      const intent = effectsLedger.recordIntent({
        attemptId: att.attemptId,
        taskId: task.id,
        epoch: att.epoch,
        agentId: 'b',
        operation: 'create_deployment',
        classification: EffectClassification.IDEMPOTENT,
        idempotencyKey: 'deploy_key_prod_v1',
        params: { cluster: 'prod-1' }
      });

      if (intent.alreadyCommitted) {
        return intent.result;
      }

      executionTimes++;
      const result = { deploymentId: 'dep_1001', status: 'created' };
      effectsLedger.commitEffect({ effectId: intent.effectId, result });
      return result;
    }

    const firstRun = executeSideEffect();
    const secondRun = executeSideEffect();

    assert.equal(executionTimes, 1, 'Underlying side effect must execute exactly once');
    assert.deepEqual(firstRun, secondRun);
  });

  // --------------------------------------------------------------------------
  // VARIANT 9: Delegation privilege escalation (Confused-Deputy Defense)
  // --------------------------------------------------------------------------
  await t.test('Variant 9: Delegation cannot escalate authority beyond delegator', () => {
    const guard = new PermissionGuard(CONFIG);
    guard.agentPolicies['guest_agent'] = {
      allowedPermissions: ['READ'],
      requiresHumanApproval: []
    };
    guard.agentPolicies['admin_agent'] = {
      allowedPermissions: ['READ', 'WRITE', 'EXECUTE'],
      requiresHumanApproval: []
    };

    const grantManager = new GrantManager(guard);
    const grant = grantManager.computeGrant({
      delegatorId: 'guest_agent',
      assigneeId: 'admin_agent',
      taskId: 'task_sec_9'
    });

    // Assignee CANNOT inherit admin WRITE/EXECUTE privileges when delegator is restricted guest
    assert.equal(grant.hasPermission('READ').allowed, true);
    assert.equal(grant.hasPermission('WRITE').allowed, false);
    assert.equal(grant.hasPermission('EXECUTE').allowed, false);
  });

  // --------------------------------------------------------------------------
  // VARIANT 10: Two agents race for one task
  // --------------------------------------------------------------------------
  await t.test('Variant 10: Two agents race to claim same task -> Exactly one wins', () => {
    const task = taskManager.createTask({
      fromAgent: 'boss',
      toAgent: 'pool_worker',
      title: 'Shared pool task',
      instructions: 'First come first served'
    });

    // Simulate two concurrent claims
    const claimA = taskManager.claimNextTask('pool_worker');
    const claimB = taskManager.claimNextTask('pool_worker');

    assert.ok(claimA, 'First claimant wins task');
    assert.equal(claimB, null, 'Second claimant gets null (no duplicate claim)');
    assert.equal(claimA.id, task.id);
  });
});
