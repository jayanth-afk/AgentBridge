import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { EventBus } from '../src/event-bus.js';
import { PresenceManager } from '../src/presence-manager.js';
import { ProjectController } from '../src/project-controller.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { AgentRunner } from '../src/agent-runner.js';
import { createSessionAdapter } from '../src/session-adapters/index.js';

test('Event-Driven Autonomous Multi-Agent Communication Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-test-'));
  const dbPath = path.join(tmpDir, 'event_test.sqlite');

  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const presence = new PresenceManager(logger);
  const guard = new PermissionGuard();
  const controller = new ProjectController(guard, logger);

  t.after(() => {
    eventBus.close();
    logger.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test('1. A -> B Request: B automatically wakes, claims, responds; A receives response without polling', async () => {
    // Start an autonomous worker for agent B (antigravity-ide)
    const runnerB = new AgentRunner({
      agentId: 'antigravity-ide',
      mailboxHub: mailbox,
      presenceManager: presence,
      projectController: controller,
      eventBus
    });

    runnerB.registerHandler('query_agent_time', async (task) => {
      return JSON.stringify({ message: 'Hello from Antigravity', time: new Date().toISOString() });
    });

    runnerB.start();
    assert.strictEqual(runnerB.state, 'IDLE');

    // Agent A (chatgpt-desktop) issues askAgent. Awaited directly without any check_inbox or polling.
    const res = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'antigravity-ide',
      question: 'query_agent_time: what is current timestamp?',
      timeoutMs: 5000
    });

    assert.strictEqual(res.mode, 'autonomous_correlated_response');
    assert.strictEqual(res.status, 'completed');
    assert.strictEqual(res.fromAgent, 'chatgpt-desktop');
    assert.strictEqual(res.toAgent, 'antigravity-ide');
    assert.ok(res.requestId, 'Must have a valid requestId');
    assert.ok(res.conversationId, 'Must have a valid conversationId');
    assert.ok(res.response.includes('Hello from Antigravity'));

    runnerB.stop();
  });

  await t.test('2. Two concurrent requests to same agent resolve independently without cross-talk', async () => {
    const runnerB = new AgentRunner({
      agentId: 'antigravity-ide',
      mailboxHub: mailbox,
      presenceManager: presence,
      projectController: controller,
      eventBus
    });

    runnerB.registerHandler('math_square', async (task) => {
      const num = Number(task.instructions.split(' ')[1] || '0');
      return String(num * num);
    });

    runnerB.start();

    // Fire 2 concurrent requests
    const [p1, p2] = await Promise.all([
      mailbox.askAgent({
        fromAgent: 'chatgpt-desktop',
        toAgent: 'antigravity-ide',
        question: 'math_square 7',
        timeoutMs: 5000
      }),
      mailbox.askAgent({
        fromAgent: 'claude-desktop',
        toAgent: 'antigravity-ide',
        question: 'math_square 9',
        timeoutMs: 5000
      })
    ]);

    assert.strictEqual(p1.status, 'completed');
    assert.strictEqual(p2.status, 'completed');
    assert.strictEqual(p1.response, '49');
    assert.strictEqual(p2.response, '81');
    assert.notStrictEqual(p1.requestId, p2.requestId);

    runnerB.stop();
  });

  await t.test('3. Three agents communicating simultaneously', async () => {
    const runnerB = new AgentRunner({
      agentId: 'antigravity-ide',
      mailboxHub: mailbox,
      presenceManager: presence,
      projectController: controller,
      eventBus
    });
    runnerB.registerHandler('agent_b_task', async () => 'RESPONSE_FROM_B');
    runnerB.start();

    const runnerC = new AgentRunner({
      agentId: 'freebuff',
      mailboxHub: mailbox,
      presenceManager: presence,
      projectController: controller,
      eventBus
    });
    runnerC.registerHandler('agent_c_task', async () => 'RESPONSE_FROM_C');
    runnerC.start();

    // Agent A queries B, Agent A queries C, and Agent B queries C
    const [resB, resC] = await Promise.all([
      mailbox.askAgent({ fromAgent: 'chatgpt-desktop', toAgent: 'antigravity-ide', question: 'agent_b_task 1' }),
      mailbox.askAgent({ fromAgent: 'chatgpt-desktop', toAgent: 'freebuff', question: 'agent_c_task 2' })
    ]);

    assert.strictEqual(resB.response, 'RESPONSE_FROM_B');
    assert.strictEqual(resC.response, 'RESPONSE_FROM_C');

    runnerB.stop();
    runnerC.stop();
  });

  await t.test('4. Offline recipient: request is safely queued and processed when recipient comes online', async () => {
    // Recipient is OFFLINE initially.
    // Sender posts request with asyncMode: true
    const queuedReq = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'antigravity-ide',
      question: 'ping_query when online',
      asyncMode: true
    });

    assert.strictEqual(queuedReq.mode, 'queued_in_mailbox');
    assert.strictEqual(queuedReq.status, 'pending');

    // Now start the runner for recipient
    const runner = new AgentRunner({
      agentId: 'antigravity-ide',
      mailboxHub: mailbox,
      presenceManager: presence,
      projectController: controller,
      eventBus
    });
    runner.registerHandler('ping_query', async () => 'PONG_ONLINE');
    runner.start();

    // Await completion directly on event bus using requestId
    const response = await eventBus.waitForResponse({
      requestId: queuedReq.requestId,
      timeoutMs: 5000
    });

    assert.strictEqual(response.status, 'completed');

    const reqState = mailbox.getRequest(queuedReq.requestId);
    assert.strictEqual(reqState.status, 'completed');
    assert.strictEqual(reqState.response, 'PONG_ONLINE');

    runner.stop();
  });

  await t.test('5. Sender reconnect: persistent result survives and is retrievable by requestId', async () => {
    // Verify that bridge_requests stores completed outcomes permanently
    const req = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'antigravity-ide',
      question: 'persisted_query',
      asyncMode: true
    });

    // Simulate completion
    mailbox.submitTaskResult({
      taskId: req.taskId,
      agentId: 'antigravity-ide',
      status: 'completed',
      result: 'DURABLE_SAVED_ANSWER'
    });

    // Requester re-attaches / reconnects and queries request
    const persisted = mailbox.getRequest(req.requestId);
    assert.ok(persisted);
    assert.strictEqual(persisted.status, 'completed');
    assert.strictEqual(persisted.response, 'DURABLE_SAVED_ANSWER');
    assert.ok(persisted.completedAt);
  });

  await t.test('6. Duplicate event handling is idempotent and monotonic', async () => {
    const cursorBefore = eventBus.getCursor('antigravity-ide');
    const received = [];

    const sub = eventBus.subscribe('antigravity-ide', (ev) => {
      received.push(ev.eventId);
    });

    const ev = eventBus.publish({
      type: 'test_event',
      agentId: 'antigravity-ide',
      fromAgent: 'chatgpt-desktop',
      payload: { hello: 'world' }
    });

    // Drain again manually to test idempotency
    eventBus.drainEventsForAgent('antigravity-ide');

    assert.strictEqual(received.filter(id => id === ev.eventId).length, 1, 'Event should be dispatched once');
    assert.ok(eventBus.getCursor('antigravity-ide') >= ev.eventId);

    sub.unsubscribe();
  });

  await t.test('7. Timeout handling on request waiter', async () => {
    // Ask an agent that is offline with a very short timeout
    const outcome = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'non-existent-agent',
      question: 'unanswered question',
      timeoutMs: 50
    });

    assert.strictEqual(outcome.status, 'timeout');
    assert.strictEqual(outcome.mode, 'request_timeout');
    assert.ok(/timed out/i.test(outcome.error));
  });

  await t.test('8. Token & payload compactness verification', async () => {
    const hugeContext = 'x'.repeat(10000);
    const ev = eventBus.publish({
      type: 'large_payload_test',
      agentId: 'antigravity-ide',
      fromAgent: 'system',
      payload: { data: hugeContext }
    });

    const storedRow = logger.db.prepare('SELECT payload FROM bridge_events WHERE event_id = ?').get(ev.eventId);
    assert.ok(storedRow.payload.length <= 600, 'Event payload must be truncated for token efficiency');
    assert.ok(storedRow.payload.includes('truncated'));
  });

  await t.test('9. Session Adapter capabilities and truthful boundary reporting', async () => {
    const antigravityAdapter = createSessionAdapter('antigravity-ide', { mailboxHub: mailbox, eventBus });
    const claudeAdapter = createSessionAdapter('claude-desktop', { mailboxHub: mailbox, eventBus });
    const chatgptAdapter = createSessionAdapter('chatgpt-desktop', { mailboxHub: mailbox, eventBus });

    const agCap = antigravityAdapter.capabilities();
    assert.strictEqual(agCap.autonomousExecution, true);
    assert.strictEqual(agCap.externalModelWakeup, true);
    assert.strictEqual(agCap.idleWakeupSupported, true);

    const claudeCap = claudeAdapter.capabilities();
    assert.strictEqual(claudeCap.autonomousExecution, false);
    assert.strictEqual(claudeCap.externalModelWakeup, false);
    assert.strictEqual(claudeCap.requiresUserPrompt, true);
    assert.strictEqual(claudeCap.desktopNotificationSupported, true);

    const chatgptCap = chatgptAdapter.capabilities();
    assert.strictEqual(chatgptCap.autonomousExecution, false);
    assert.strictEqual(chatgptCap.externalModelWakeup, false);
    assert.strictEqual(chatgptCap.requiresUserPrompt, true);
    assert.strictEqual(chatgptCap.desktopNotificationSupported, true);

    // Testing truthful wake report on Claude
    const claudeWake = await claudeAdapter.wake('external_signal', { notifyUser: false });
    assert.strictEqual(claudeWake.success, false);
    assert.strictEqual(claudeWake.error, 'DESKTOP_MODEL_WAKEUP_UNSUPPORTED');

    // Test queueRequest and recoverPendingRequests on Claude adapter
    await claudeAdapter.connect();
    assert.strictEqual(claudeAdapter.isActive(), true);
    assert.strictEqual(claudeAdapter.isIdle(), true);

    const qRes = await claudeAdapter.queueRequest({
      requestId: 'req_claude_pending_test',
      fromAgent: 'chatgpt-desktop',
      question: 'Review this patch please'
    }, { notifyUser: false });
    assert.strictEqual(qRes.status, 'queued');

    await claudeAdapter.disconnect();
    assert.strictEqual(claudeAdapter.isActive(), false);
  });

  await t.test('10. Pending requests recovery and direct answerRequest correlated resolution', async () => {
    // 1. Post a request for claude-desktop in asyncMode
    const req = await mailbox.askAgent({
      fromAgent: 'antigravity-ide',
      toAgent: 'claude-desktop',
      question: 'Can you confirm the architecture?',
      asyncMode: true
    });

    // 2. Discover pending requests for claude-desktop
    const pending = mailbox.getPendingRequests('claude-desktop');
    assert.ok(pending.length >= 1);
    const found = pending.find(p => p.requestId === req.requestId);
    assert.ok(found, 'Should find pending request');
    assert.strictEqual(found.fromAgent, 'antigravity-ide');

    // 3. Antigravity waits for the response
    const waiterPromise = eventBus.waitForResponse({
      requestId: req.requestId,
      timeoutMs: 5000
    });

    // 4. Claude answers using answerRequest
    const ans = mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      response: 'Architecture confirmed valid by Claude.'
    });
    assert.strictEqual(ans.status, 'completed');

    // 5. Correlated waiter receives response immediately
    const delivered = await waiterPromise;
    assert.strictEqual(delivered.status, 'completed');
    assert.ok(delivered.response.includes('Architecture confirmed valid by Claude'));
  });
});
