import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { PresenceManager } from '../src/presence-manager.js';
import { ArtifactStore, detectMimeType } from '../src/artifacts/artifact-store.js';
import { RequestExplainer } from '../src/diagnostics/request-explainer.js';

test('End-to-End Completion Mission Acceptance Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-mission-'));
  const dbPath = path.join(tmpDir, 'e2e_mission.sqlite');
  const storeRoot = path.join(tmpDir, 'artifacts');

  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger);
  const presence = new PresenceManager(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus, presence);
  const artifactStore = new ArtifactStore(logger, { root: storeRoot });
  const explainer = new RequestExplainer(logger, { mailboxHub: mailbox, taskManager });

  t.after(() => {
    try { eventBus.close(); } catch {}
    try { logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // --------------------------------------------------------------------------
  // 1. Response-Ready Notification Wakes Requester Promptly (<300ms)
  // --------------------------------------------------------------------------
  await t.test('1. Response-ready event wakes requester promptly without polling delay', async () => {
    presence.heartbeat('agent-alpha', 'online');
    presence.heartbeat('agent-beta', 'online');

    // Register Beta handler that answers when requested
    mailbox.registerAgentHandler('agent-beta', async (question) => {
      return `Computed answer for: ${question}`;
    });

    const start = Date.now();
    const result = await mailbox.askAgent({
      fromAgent: 'agent-alpha',
      toAgent: 'agent-beta',
      question: 'What is the matrix determinant?',
      timeoutMs: 5000
    });
    const durationMs = Date.now() - start;

    assert.ok(result, 'Result must be returned');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.response, 'Computed answer for: What is the matrix determinant?');
    assert.ok(durationMs < 300, `Expected prompt event wakeup (<300ms), took ${durationMs}ms`);
  });

  // --------------------------------------------------------------------------
  // 2. Response Arriving Before Waiter Registration Is Not Lost
  // --------------------------------------------------------------------------
  await t.test('2. Response arriving before waiter registration is durably retained', async () => {
    // Stage an asynchronous request
    const req = await mailbox.askAgentAsync({
      fromAgent: 'agent-gamma',
      toAgent: 'agent-delta',
      question: 'Calculate eigenvalues'
    });

    // The responder answers immediately before requester attaches waiter
    const answerRes = mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'agent-delta',
      response: 'Eigenvalues: [3, 7]'
    });
    assert.strictEqual(answerRes.status, 'completed');

    // Requester subsequently waits for response
    const waiterResult = await mailbox.waitForResponse(req.requestId, 2000);
    assert.strictEqual(waiterResult.status, 'completed');
    assert.strictEqual(waiterResult.response, 'Eigenvalues: [3, 7]');

    // Also verify getRequest retrieves the persistent response
    const stored = mailbox.getRequest(req.requestId, { agentId: 'agent-gamma' });
    assert.strictEqual(stored.response, 'Eigenvalues: [3, 7]');
    assert.strictEqual(stored.status, 'completed');
  });

  // --------------------------------------------------------------------------
  // 3. Concurrent Conversations Receive Their Own Responses (Zero Cross-Talk)
  // --------------------------------------------------------------------------
  await t.test('3. Concurrent conversations receive isolated responses without cross-talk', async () => {
    presence.heartbeat('agent-math', 'online');
    mailbox.registerAgentHandler('agent-math', async (q) => {
      if (q.includes('fib')) return 'fib(10) = 55';
      if (q.includes('prime')) return 'prime(10) = 29';
      return 'unknown';
    });

    const [res1, res2] = await Promise.all([
      mailbox.askAgent({
        fromAgent: 'client-1',
        toAgent: 'agent-math',
        question: 'compute fib(10)',
        conversationId: 'conv_111',
        timeoutMs: 5000
      }),
      mailbox.askAgent({
        fromAgent: 'client-2',
        toAgent: 'agent-math',
        question: 'compute prime(10)',
        conversationId: 'conv_222',
        timeoutMs: 5000
      })
    ]);

    assert.strictEqual(res1.response, 'fib(10) = 55');
    assert.strictEqual(res2.response, 'prime(10) = 29');
    assert.strictEqual(res1.conversationId, 'conv_111');
    assert.strictEqual(res2.conversationId, 'conv_222');
  });

  // --------------------------------------------------------------------------
  // 4. Duplicate Responses Are Idempotent & Conflicting Overwrite Quarantined
  // --------------------------------------------------------------------------
  await t.test('4. Duplicate responses cannot cause duplicate side effects or output', async () => {
    const req = await mailbox.askAgentAsync({
      fromAgent: 'agent-a',
      toAgent: 'agent-b',
      question: 'Run mutation X'
    });

    const firstSubmit = mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'agent-b',
      response: 'Mutation X applied once'
    });
    assert.strictEqual(firstSubmit.status, 'completed');

    // Duplicate submission of identical answer is safely idempotent
    const duplicateSubmit = mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'agent-b',
      response: 'Mutation X applied once'
    });
    assert.strictEqual(duplicateSubmit.status, 'completed');

    // Conflicting submission on already completed request is quarantined
    const conflictSubmit = mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'agent-b',
      response: 'Mutation X applied TWICE (CONFLICT)'
    });
    assert.strictEqual(conflictSubmit.status, 'quarantined');
    assert.strictEqual(conflictSubmit.quarantined, true);
  });

  // --------------------------------------------------------------------------
  // 5. Reconnection Can Retrieve Completed Response and Acknowledge Delivery
  // --------------------------------------------------------------------------
  await t.test('5. Reconnection can retrieve completed response and acknowledge delivery', async () => {
    const req = await mailbox.askAgentAsync({
      fromAgent: 'agent-client',
      toAgent: 'agent-worker',
      question: 'Long running report'
    });

    mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'agent-worker',
      response: 'Quarterly financial report data'
    });

    // Requester retrieves response
    const retrieved = mailbox.getRequest(req.requestId, { agentId: 'agent-client' });
    assert.strictEqual(retrieved.status, 'completed');
    assert.strictEqual(retrieved.response, 'Quarterly financial report data');
    assert.strictEqual(retrieved.deliveryAcknowledgedAt, null);

    // Acknowledge delivery
    const ack = mailbox.acknowledgeDelivery({
      requestId: req.requestId,
      agentId: 'agent-client'
    });
    assert.strictEqual(ack.status, 'acknowledged');
    assert.ok(ack.acknowledgedAt);

    // Verify updated state reflects delivery acknowledgement
    const afterAck = mailbox.getRequest(req.requestId, { agentId: 'agent-client' });
    assert.strictEqual(afterAck.deliveryAcknowledgedAt, ack.acknowledgedAt);
  });

  // --------------------------------------------------------------------------
  // 6. Timeout Distinguishes Remote Offline vs Dispatch Pending
  // --------------------------------------------------------------------------
  await t.test('6. Timeout handling distinguishes offline remote agent from slow execution', async () => {
    // Offline target agent
    const offlineTimeout = await mailbox.askAgent({
      fromAgent: 'agent-x',
      toAgent: 'non-existent-agent',
      question: 'Hello?',
      timeoutMs: 100
    });
    assert.strictEqual(offlineTimeout.status, 'timeout');
    assert.strictEqual(offlineTimeout.timeoutReason, 'REMOTE_AGENT_OFFLINE');
    assert.strictEqual(offlineTimeout.remoteAgentOnline, false);

    // Online agent that does not answer in time
    presence.heartbeat({ agentId: 'slow-agent', state: 'online' });
    const slowTimeout = await mailbox.askAgent({
      fromAgent: 'agent-x',
      toAgent: 'slow-agent',
      question: 'Take your time',
      timeoutMs: 150
    });
    assert.strictEqual(slowTimeout.status, 'timeout');
    assert.strictEqual(slowTimeout.remoteAgentOnline, true);
    assert.strictEqual(slowTimeout.timeoutReason, 'DISPATCH_PENDING_UNCLAIMED');

    // Timeout must not delete the request record: completed late responses remain retrievable
    mailbox.answerRequest({
      requestId: slowTimeout.requestId,
      agentId: 'slow-agent',
      response: 'Finished after timeout'
    });

    const lateRetrieved = mailbox.getRequest(slowTimeout.requestId, { agentId: 'agent-x' });
    assert.strictEqual(lateRetrieved.status, 'completed');
    assert.strictEqual(lateRetrieved.response, 'Finished after timeout');
  });

  // --------------------------------------------------------------------------
  // 7. Image and Video Binary Artifact Delivery Byte-for-Byte
  // --------------------------------------------------------------------------
  await t.test('7. Real binary image and video artifacts transfer byte-identically with access control', async () => {
    // Generate real PNG fixture bytes (8-byte PNG header + binary data)
    const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const imagePayload = crypto.randomBytes(4096);
    const fullPng = Buffer.concat([pngHeader, imagePayload]);
    const expectedSha = crypto.createHash('sha256').update(fullPng).digest('hex');

    // Store artifact
    const ref = artifactStore.put({
      bytes: fullPng,
      filename: 'render_chart.png',
      mimeType: 'image/png',
      agentId: 'vision-generator',
      taskId: 'task_chart'
    });

    assert.strictEqual(ref.mime_type, 'image/png');
    assert.strictEqual(ref.media_type, 'image');
    assert.strictEqual(ref.sha256, expectedSha);
    assert.strictEqual(ref.size_bytes, fullPng.length);

    // Retrieve by creator agent
    const { bytes: retrievedBytes, integrityVerified } = artifactStore.read(ref.artifact_id, { agentId: 'vision-generator' });
    assert.strictEqual(integrityVerified, true);
    assert.ok(retrievedBytes.equals(fullPng), 'Retrieved bytes must be 100% byte-identical');

    // Unauthorized viewer is rejected
    assert.throws(
      () => artifactStore.read(ref.artifact_id, { agentId: 'unauthorized-intruder' }),
      (err) => err.code === 'ARTIFACT_UNAUTHORIZED'
    );

    // Video fixture (MP4 ISO Base Media file)
    const mp4Header = Buffer.alloc(12);
    mp4Header.writeUInt32BE(12 + 1024, 0);
    mp4Header.write('ftyp', 4, 'ascii');
    mp4Header.write('isom', 8, 'ascii');
    const fullMp4 = Buffer.concat([mp4Header, crypto.randomBytes(1024)]);
    const mp4Ref = artifactStore.put({
      bytes: fullMp4,
      filename: 'simulation.mp4',
      mimeType: 'video/mp4',
      agentId: 'video-producer'
    });
    assert.strictEqual(mp4Ref.mime_type, 'video/mp4');
    assert.strictEqual(mp4Ref.media_type, 'video');
    const { bytes: mp4Retrieved } = artifactStore.read(mp4Ref.artifact_id, { agentId: 'video-producer' });
    assert.ok(mp4Retrieved.equals(fullMp4), 'MP4 bytes must be 100% byte-identical');
  });

  // --------------------------------------------------------------------------
  // 8. Multi-Turn Peer-to-Peer Delegation Without Central AI Reasoning Bottleneck
  // --------------------------------------------------------------------------
  await t.test('8. Multi-turn peer-to-peer delegation between Agent A and Agent B works directly', async () => {
    presence.heartbeat('engineer', 'online');
    presence.heartbeat('architect', 'online');

    // Turn 1: Engineer asks Architect for design
    mailbox.registerAgentHandler('architect', async (q) => {
      if (q.includes('architecture spec')) {
        return 'Spec v1: Microservices with Kafka';
      }
      if (q.includes('clarification on persistence')) {
        return 'Persistence: Use PostgreSQL with WAL';
      }
      return 'OK';
    });

    const turn1 = await mailbox.askAgent({
      fromAgent: 'engineer',
      toAgent: 'architect',
      question: 'Provide architecture spec for payment module',
      conversationId: 'conv_eng_arch_1',
      timeoutMs: 5000
    });
    assert.strictEqual(turn1.status, 'completed');
    assert.strictEqual(turn1.response, 'Spec v1: Microservices with Kafka');

    // Turn 2: Engineer requests clarification in the same conversation
    const turn2 = await mailbox.askAgent({
      fromAgent: 'engineer',
      toAgent: 'architect',
      question: 'Request clarification on persistence layer',
      conversationId: 'conv_eng_arch_1',
      timeoutMs: 5000
    });
    assert.strictEqual(turn2.status, 'completed');
    assert.strictEqual(turn2.response, 'Persistence: Use PostgreSQL with WAL');
  });

  // --------------------------------------------------------------------------
  // 9. Observability: RequestExplainer Detailed Lifecycle Trace
  // --------------------------------------------------------------------------
  await t.test('9. RequestExplainer produces complete lifecycle diagnostic trace', async () => {
    const req = await mailbox.askAgentAsync({
      fromAgent: 'audit-client',
      toAgent: 'data-worker',
      question: 'Explain this lifecycle'
    });

    mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'data-worker',
      response: 'Lifecycle completed'
    });

    mailbox.acknowledgeDelivery({
      requestId: req.requestId,
      agentId: 'audit-client'
    });

    const explanation = explainer.explainRequest(req.requestId);
    assert.strictEqual(explanation.found, true);
    assert.strictEqual(explanation.requestId, req.requestId);
    assert.strictEqual(explanation.currentStatus, 'completed');
    assert.strictEqual(explanation.fromAgent, 'audit-client');
    assert.strictEqual(explanation.toAgent, 'data-worker');
    assert.ok(explanation.timeline.length >= 2, 'Timeline must contain lifecycle events');
    const phases = explanation.timeline.map(e => e.phase);
    assert.ok(phases.includes('REQUEST_CREATED'), 'Timeline must include REQUEST_CREATED');
  });
});
