import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';
import { EventBus } from '../src/event-bus.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { AttemptLedger } from '../src/attempts/attempt-ledger.js';
import { BridgeHttpServer } from '../src/http-server.js';
import { AgentBridgeClient } from '../src/client/bridge-client.js';

test('Agent Bridge Durable Recovery, Reconnection & Delivery Suite', async (t) => {
  const dbPath = path.join(process.cwd(), 'data', 'test-durable-recovery.sqlite');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const logger = new AuditLogger(dbPath);
  const taskManager = new TaskManager(logger);
  const eventBus = new EventBus(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);

  await t.test('1. Idempotent Requester Reconnect: Completed request returns stored response without UNIQUE constraint error', async () => {
    const reqId = 'req_durable_test_1';
    
    // Simulate first request
    const promise1 = mailbox.askAgent({
      fromAgent: 'requester-agent',
      toAgent: 'worker-agent',
      question: 'What is the durable answer?',
      requestId: reqId,
      timeoutMs: 5000,
      asyncMode: false
    });

    // Worker claims and completes
    const task = taskManager.claimNextTask('worker-agent');
    assert.ok(task, 'Worker should claim delegated task');
    assert.equal(task.creator, 'requester-agent');

    mailbox.submitTaskResult({
      taskId: task.id,
      agentId: 'worker-agent',
      status: 'completed',
      result: 'DURABLE_ANSWER_42',
      attemptId: task.attemptId,
      epoch: task.epoch
    });

    const res1 = await promise1;
    assert.equal(res1.status, 'completed');
    assert.equal(res1.response, 'DURABLE_ANSWER_42');

    // Requester disconnects/reconnects using the same requestId
    const res2 = await mailbox.askAgent({
      fromAgent: 'requester-agent',
      toAgent: 'worker-agent',
      question: 'What is the durable answer?',
      requestId: reqId,
      timeoutMs: 5000,
      asyncMode: false
    });

    assert.equal(res2.status, 'completed', 'Reconnected request should return completed status');
    assert.equal(res2.response, 'DURABLE_ANSWER_42', 'Reconnected request should return durable response');
    assert.equal(res2.requestId, reqId);
  });

  await t.test('2. Terminal State Immutability: Completed task cannot be overwritten or downgraded by late submission', async () => {
    const task = taskManager.createTask({
      title: 'Terminal Invariant Task',
      fromAgent: 'system',
      toAgent: 'worker-agent',
      instructions: 'Complete and protect'
    });

    const claimed = taskManager.claimNextTask('worker-agent');
    assert.equal(claimed.id, task.id);

    // Initial successful completion
    mailbox.submitTaskResult({
      taskId: task.id,
      agentId: 'worker-agent',
      status: 'completed',
      result: 'ORIGINAL_SUCCESS',
      attemptId: claimed.attemptId,
      epoch: claimed.epoch
    });

    const completedTask = taskManager.getTask(task.id);
    assert.equal(completedTask.status, 'completed');
    assert.equal(completedTask.result, 'ORIGINAL_SUCCESS');

    // Stale/late attempt tries to fail the task
    taskManager.updateTaskStatus({
      taskId: task.id,
      agentId: 'worker-agent',
      status: 'failed',
      error: 'Late failure from crashed attempt',
      attemptId: 'stale_att_999',
      epoch: claimed.epoch
    });

    const preservedTask = taskManager.getTask(task.id);
    assert.equal(preservedTask.status, 'completed', 'Task status must remain completed');
    assert.equal(preservedTask.result, 'ORIGINAL_SUCCESS', 'Task result must remain original result');
  });

  await t.test('3. Monotonic Lease Fencing: Stale attempt is rejected from completing task', async () => {
    const task = taskManager.createTask({
      title: 'Fencing Verification Task',
      fromAgent: 'system',
      toAgent: 'worker-agent',
      instructions: 'Verify fencing'
    });

    // Worker 1 claims (epoch 1)
    const att1 = taskManager.claimNextTask('worker-agent');
    assert.equal(att1.epoch, 1);

    // Lease expires or recovery advances epoch: simulate new attempt (epoch 2)
    const att2 = taskManager.attempts.createAttempt({
      taskId: task.id,
      agentId: 'worker-agent',
      routeId: 'mcp-stdio'
    });
    assert.equal(att2.epoch, 2);

    // Stale att1 tries to validate fencing
    assert.throws(() => {
      taskManager.attempts.validateFencing({
        taskId: task.id,
        attemptId: att1.attemptId,
        epoch: 1,
        agentId: 'worker-agent'
      });
    }, (err) => err.code === 'FENCED_ATTEMPT_ERROR');

    // Stale att1 tries to complete
    assert.throws(() => {
      taskManager.updateTaskStatus({
        taskId: task.id,
        agentId: 'worker-agent',
        status: 'completed',
        result: 'STALE_RESULT',
        attemptId: att1.attemptId,
        epoch: 1
      });
    }, (err) => err.code === 'FENCED_ATTEMPT_ERROR');
  });

  await t.test('4. Startup Recovery: Sweeps expired attempts and task leases idempotently on restart', () => {
    // Create an expired task lease
    const oldDate = new Date(Date.now() - 60000).toISOString();
    const task = taskManager.createTask({
      title: 'Expired Lease Task',
      fromAgent: 'system',
      toAgent: 'worker-agent',
      instructions: 'Expire and recover'
    });

    const claimed = taskManager.claimNextTask('worker-agent');
    // Force task lease and attempt lease to expired timestamp in DB
    logger.db.prepare(`
      UPDATE tasks SET started_at = ?, updated_at = ?, timeout_ms = 1000 WHERE id = ?
    `).run(oldDate, oldDate, task.id);
    logger.db.prepare(`
      UPDATE bridge_attempts SET lease_expires_at = ?, state = 'active' WHERE attempt_id = ?
    `).run(oldDate, claimed.attemptId);

    // Invoke startupRecovery
    const recoveryReport = taskManager.startupRecovery();
    assert.ok(Array.isArray(recoveryReport.tasks), 'Recovery report should contain recovered tasks');
    const recoveredTaskIds = recoveryReport.tasks.map(r => r.taskId);
    assert.ok(recoveredTaskIds.includes(task.id) || recoveryReport.attempts.length > 0, 'Expired task or attempt must be recovered');

    // Task must now be eligible for re-claiming (pending status)
    const refreshed = taskManager.getTask(task.id);
    assert.equal(refreshed.status, 'pending');
  });

  await t.test('5. MCP SSE Transport Probe & Session Endpoint Handling', async () => {
    const testPort = 18765;
    const httpServer = new BridgeHttpServer({
      port: testPort,
      host: '127.0.0.1',
      auditLogger: logger,
      permissionGuard: { config: { AGENT_IDENTITIES: ['chatgpt-desktop', 'claude-desktop'] } },
      mailboxHub: mailbox,
      taskManager,
      toolRegistry: {
        getToolDefinitions: () => [{ name: 'bridge_ping', description: 'Ping' }],
        executeTool: async () => ({ status: 'pong' })
      }
    });

    await httpServer.start();

    try {
      // 5a. GET /sse probe returns 200 text/event-stream and endpoint event
      const sseRes = await fetch(`http://127.0.0.1:${testPort}/sse`);
      assert.equal(sseRes.status, 200);
      assert.ok(sseRes.headers.get('content-type')?.includes('text/event-stream'));

      const reader = sseRes.body.getReader();
      const { value } = await reader.read();
      const sseText = new TextDecoder().decode(value);
      assert.ok(sseText.includes('event: endpoint'), 'Must emit endpoint event');
      assert.ok(sseText.includes('data: /mcp?sessionId='), 'Must contain sessionId in endpoint URL');
      reader.cancel();

      // 5b. HEAD /sse returns 200 text/event-stream
      const headRes = await fetch(`http://127.0.0.1:${testPort}/sse`, { method: 'HEAD' });
      assert.equal(headRes.status, 200);
      assert.ok(headRes.headers.get('content-type')?.includes('text/event-stream'));

      // 5c. POST /mcp initialize returns protocolVersion and tools capability
      const initRes = await fetch(`http://127.0.0.1:${testPort}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 101,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05' }
        })
      });
      assert.equal(initRes.status, 200);
      const initJson = await initRes.json();
      assert.equal(initJson.result.protocolVersion, '2024-11-05');
      assert.equal(initJson.result.serverInfo.name, 'agent-bridge');

      // 5d. POST /mcp ping returns {}
      const pingRes = await fetch(`http://127.0.0.1:${testPort}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 102,
          method: 'ping'
        })
      });
      assert.equal(pingRes.status, 200);
      const pingJson = await pingRes.json();
      assert.deepEqual(pingJson.result, {});
    } finally {
      await httpServer.stop();
    }
  });

  await t.test('6. AgentBridgeClient Backoff: Handles HTTP 429 and Retry-After header with bounded backoff', async () => {
    let callCount = 0;
    const testServer = http.createServer((req, res) => {
      callCount++;
      if (callCount < 3) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '0.1'
        });
        res.end(JSON.stringify({ error: 'Too Many Requests' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', attempts: callCount }));
      }
    });

    const testPort = 18766;
    await new Promise(r => testServer.listen(testPort, '127.0.0.1', r));

    try {
      const client = new AgentBridgeClient({
        baseUrl: `http://127.0.0.1:${testPort}`,
        agentId: 'backoff-test-agent'
      });

      const result = await client.ping();
      assert.equal(result.status, 'ok');
      assert.equal(result.attempts, 3);
      assert.equal(callCount, 3);
    } finally {
      await new Promise(r => testServer.close(r));
    }
  });

  await t.test('7. Concurrent Correlated Delegations: Two simultaneous tasks complete without cross-delivering', async () => {
    const p1 = mailbox.askAgent({
      fromAgent: 'agent-alice',
      toAgent: 'worker-agent',
      question: 'Task 1 Query',
      requestId: 'req_concurrent_1',
      timeoutMs: 5000
    });

    const p2 = mailbox.askAgent({
      fromAgent: 'agent-bob',
      toAgent: 'worker-agent',
      question: 'Task 2 Query',
      requestId: 'req_concurrent_2',
      timeoutMs: 5000
    });

    const t1 = taskManager.claimNextTask('worker-agent');
    const t2 = taskManager.claimNextTask('worker-agent');

    assert.ok(t1 && t2);
    assert.notEqual(t1.id, t2.id);

    // Resolve t2 first, then t1
    mailbox.submitTaskResult({
      taskId: t2.id,
      agentId: 'worker-agent',
      status: 'completed',
      result: 'RESPONSE_FOR_TASK_2',
      attemptId: t2.attemptId,
      epoch: t2.epoch
    });

    mailbox.submitTaskResult({
      taskId: t1.id,
      agentId: 'worker-agent',
      status: 'completed',
      result: 'RESPONSE_FOR_TASK_1',
      attemptId: t1.attemptId,
      epoch: t1.epoch
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1.requestId, 'req_concurrent_1');
    assert.equal(r1.response, 'RESPONSE_FOR_TASK_1');

    assert.equal(r2.requestId, 'req_concurrent_2');
    assert.equal(r2.response, 'RESPONSE_FOR_TASK_2');
  });

  await t.test('8. Requester Timeout followed by Late Completion: Result is durably persisted and recoverable', async () => {
    const reqId = 'req_timeout_late_1';

    // Requester sets very short timeout (50ms)
    const timeoutRes = await mailbox.askAgent({
      fromAgent: 'impatient-requester',
      toAgent: 'slow-worker',
      question: 'Slow calculation',
      requestId: reqId,
      timeoutMs: 50
    });

    assert.equal(timeoutRes.status, 'timeout');
    assert.equal(timeoutRes.recoverable, true);

    // Worker claims task and completes it after timeout
    const task = taskManager.claimNextTask('slow-worker');
    assert.ok(task);

    mailbox.submitTaskResult({
      taskId: task.id,
      agentId: 'slow-worker',
      status: 'completed',
      result: 'COMPLETED_AFTER_TIMEOUT',
      attemptId: task.attemptId,
      epoch: task.epoch
    });

    // Requester reconnects with same requestId and retrieves result
    const recovered = await mailbox.askAgent({
      fromAgent: 'impatient-requester',
      toAgent: 'slow-worker',
      question: 'Slow calculation',
      requestId: reqId,
      timeoutMs: 5000
    });

    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.response, 'COMPLETED_AFTER_TIMEOUT');
  });

  // Cleanup
  eventBus.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});
