import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { EventBus } from '../src/event-bus.js';
import { PresenceManager } from '../src/presence-manager.js';
import { ProjectController } from '../src/project-controller.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { AgentRunner } from '../src/agent-runner.js';
import { DiagnosticsManager } from '../src/diagnostics-manager.js';
import { AgentIdentityManager } from '../src/agent-identity.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { WorkerSupervisor } from '../src/control-plane/worker-supervisor.js';
import { ClaudeDesktopWorker } from '../src/control-plane/claude-desktop-worker.js';
import { ChatGptDesktopWorker } from '../src/control-plane/chatgpt-desktop-worker.js';

test('Agent Bridge v2 — Autonomous Multi-Agent Communication & Worker Fabric', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-test-'));
  const dbPath = path.join(tmpDir, 'worker_test.sqlite');

  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const presence = new PresenceManager(logger);
  const guard = new PermissionGuard();
  const controller = new ProjectController(guard, logger);
  const diagnostics = new DiagnosticsManager();

  t.after(() => {
    eventBus.close();
    logger.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test('1. MCP-Only State vs Autonomous Worker State', async () => {
    // Stage 1: MCP-Only state
    // Register Antigravity as an MCP-stdio client session only
    presence.heartbeat({
      agentId: 'antigravity-ide',
      transport: 'mcp-stdio',
      pid: process.pid,
      state: 'IDLE'
    });

    const mcpPresence = presence.getPresence('antigravity-ide');
    assert.strictEqual(mcpPresence.connected, true);
    assert.strictEqual(mcpPresence.mcpConnected, true);
    assert.strictEqual(mcpPresence.autonomousWorker, false, 'MCP-only session must NOT report autonomousWorker');
    assert.strictEqual(mcpPresence.canReceiveTasks, false, 'MCP-only session cannot receive autonomous tasks');
    assert.strictEqual(mcpPresence.canInitiateTurns, true, 'MCP-only session can initiate tool calls');

    // Diagnostics must reflect this distinction
    const diagMcp = diagnostics.getAgentDiagnostics('antigravity-ide', { db: logger.db, presenceManager: presence });
    assert.strictEqual(diagMcp.connection.autonomousWorker, false);
    assert.strictEqual(diagMcp.connection.canReceiveTasks, false);
    assert.strictEqual(diagMcp.connection.mcpConnected, true);

    // Synchronous askAgent with short timeout should timeout because no worker is running
    const timeoutRes = await mailbox.askAgent({
      fromAgent: 'gemini',
      toAgent: 'antigravity-ide',
      question: 'Reply with exactly ANTIGRAVITY_BRIDGE_OK',
      timeoutMs: 100
    });

    assert.strictEqual(timeoutRes.status, 'timeout');
    assert.strictEqual(timeoutRes.mode, 'request_timeout');
    assert.strictEqual(timeoutRes.recoverable, true);

    // Verify task is NOT deleted or lost: still pending in SQLite
    const pendingTask = taskManager.getTask(timeoutRes.taskId, false);
    assert.ok(pendingTask);
    assert.strictEqual(pendingTask.status, 'pending', 'Timed-out request task must remain durably pending');
    const pendingRequest = mailbox.getRequest(timeoutRes.requestId);
    assert.equal(pendingRequest.status, 'pending', 'Caller timeout must not overwrite the durable request state');

    // Stage 2: Autonomous Worker comes online
    const antigravityRunner = new AgentRunner({
      agentId: 'antigravity-ide',
      mailboxHub: mailbox,
      presenceManager: presence,
      projectController: controller,
      eventBus
    });
    antigravityRunner.start();

    const workerPresence = presence.getPresence('antigravity-ide');
    assert.strictEqual(workerPresence.connected, true);
    assert.strictEqual(workerPresence.autonomousWorker, true, 'Worker session must report autonomousWorker = true');
    assert.strictEqual(workerPresence.canReceiveTasks, true, 'Worker session must report canReceiveTasks = true');

    // Diagnostics must now show autonomousWorker = true
    const diagWorker = diagnostics.getAgentDiagnostics('antigravity-ide', { db: logger.db, presenceManager: presence });
    assert.strictEqual(diagWorker.connection.autonomousWorker, true);
    assert.strictEqual(diagWorker.connection.canReceiveTasks, true);

    antigravityRunner.stop();
  });

  await t.test('2. Multi-Agent Discovery distinguishes MCP, workers, and Gemini identity', async () => {
    const registry = new ToolRegistry();
    const ctx = {
      presence,
      mailbox,
      logger,
      guard,
      identity: new AgentIdentityManager(logger, 'system')
    };

    const discovery = await registry.executeTool('bridge_discover_agents', {}, ctx);
    assert.ok(discovery.registeredAgents.includes('gemini'), 'gemini must be in registeredAgents');
    assert.ok(discovery.registeredAgents.includes('antigravity-ide'));
    assert.ok(discovery.registeredAgents.includes('claude-desktop'));
    assert.ok(discovery.registeredAgents.includes('chatgpt-desktop'));

    const agentPresence = await registry.executeTool('bridge_agent_presence', {}, ctx);
    assert.ok(Array.isArray(agentPresence.agents));
    const agPresence = agentPresence.agents.find(a => a.agentId === 'antigravity-ide');
    assert.ok(agPresence);
    assert.ok('autonomousWorker' in agPresence);
    assert.ok('canReceiveTasks' in agPresence);
    assert.ok('canInitiateTurns' in agPresence);
  });

  await t.test('3. End-to-End Inter-Agent Communication: All 7 Paths', async () => {
    // Start autonomous workers for Antigravity, Gemini, ChatGPT, and Claude
    const agRunner = new AgentRunner({
      agentId: 'antigravity-ide',
      mailboxHub: mailbox,
      presenceManager: presence,
      projectController: controller,
      eventBus
    });
    agRunner.start();

    const geminiRunner = new AgentRunner({
      agentId: 'gemini',
      mailboxHub: mailbox,
      presenceManager: presence,
      projectController: controller,
      eventBus
    });
    geminiRunner.start();

    // Mock sessions for Claude & ChatGPT desktop workers that support deterministic exact reply
    const mockSession = (replyPrefix) => ({
      send: async ({ text, requestId }) => {
        const match = (text || '').match(/reply with exactly\s+([^\r\n]+)/i);
        const resp = match ? match[1].trim() : `${replyPrefix}_OK`;
        return { success: true, response: resp, status: 'COMPLETED' };
      }
    });

    const claudeWorker = new ClaudeDesktopWorker({
      agentId: 'claude-desktop',
      mailboxHub: mailbox,
      eventBus,
      presenceManager: presence,
      session: mockSession('CLAUDE'),
      logger
    });
    await claudeWorker.start({ recoverPending: false });

    const chatgptWorker = new ChatGptDesktopWorker({
      agentId: 'chatgpt-desktop',
      mailboxHub: mailbox,
      eventBus,
      presenceManager: presence,
      session: mockSession('CHATGPT'),
      logger
    });
    await chatgptWorker.start({ recoverPending: false });

    // Path A: Gemini → Bridge → Antigravity Worker → Bridge → Gemini
    const testA = await mailbox.askAgent({
      fromAgent: 'gemini',
      toAgent: 'antigravity-ide',
      question: 'Reply with exactly ANTIGRAVITY_BRIDGE_OK',
      timeoutMs: 5000
    });
    assert.strictEqual(testA.status, 'completed');
    assert.strictEqual(testA.mode, 'autonomous_correlated_response');
    assert.strictEqual(testA.fromAgent, 'gemini');
    assert.strictEqual(testA.toAgent, 'antigravity-ide');
    assert.strictEqual(testA.response, 'ANTIGRAVITY_BRIDGE_OK');

    // Path B: ChatGPT → Bridge → Antigravity Worker → ChatGPT
    const testB = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'antigravity-ide',
      question: 'Reply with exactly ANTIGRAVITY_FOR_CHATGPT',
      timeoutMs: 5000
    });
    assert.strictEqual(testB.status, 'completed');
    assert.strictEqual(testB.response, 'ANTIGRAVITY_FOR_CHATGPT');

    // Path C: Claude → Bridge → Antigravity Worker → Claude
    const testC = await mailbox.askAgent({
      fromAgent: 'claude-desktop',
      toAgent: 'antigravity-ide',
      question: 'Reply with exactly ANTIGRAVITY_FOR_CLAUDE',
      timeoutMs: 5000
    });
    assert.strictEqual(testC.status, 'completed');
    assert.strictEqual(testC.response, 'ANTIGRAVITY_FOR_CLAUDE');

    // Path D: Antigravity → Bridge → ChatGPT Worker → Antigravity
    const testD = await mailbox.askAgent({
      fromAgent: 'antigravity-ide',
      toAgent: 'chatgpt-desktop',
      question: 'Reply with exactly CHATGPT_BRIDGE_OK',
      timeoutMs: 5000
    });
    assert.strictEqual(testD.status, 'completed');
    assert.strictEqual(testD.response, 'CHATGPT_BRIDGE_OK');

    // Path E: Antigravity → Bridge → Claude Worker → Antigravity
    const testE = await mailbox.askAgent({
      fromAgent: 'antigravity-ide',
      toAgent: 'claude-desktop',
      question: 'Reply with exactly CLAUDE_BRIDGE_OK',
      timeoutMs: 5000
    });
    assert.strictEqual(testE.status, 'completed');
    assert.strictEqual(testE.response, 'CLAUDE_BRIDGE_OK');

    // Path F: Gemini → Bridge → Claude Worker → Gemini
    const testF = await mailbox.askAgent({
      fromAgent: 'gemini',
      toAgent: 'claude-desktop',
      question: 'Reply with exactly CLAUDE_FOR_GEMINI_OK',
      timeoutMs: 5000
    });
    assert.strictEqual(testF.status, 'completed');
    assert.strictEqual(testF.response, 'CLAUDE_FOR_GEMINI_OK');

    // Path G: Gemini → Bridge → ChatGPT Worker → Gemini
    const testG = await mailbox.askAgent({
      fromAgent: 'gemini',
      toAgent: 'chatgpt-desktop',
      question: 'Reply with exactly CHATGPT_FOR_GEMINI_OK',
      timeoutMs: 5000
    });
    assert.strictEqual(testG.status, 'completed');
    assert.strictEqual(testG.response, 'CHATGPT_FOR_GEMINI_OK');

    // Clean up test workers
    agRunner.stop();
    geminiRunner.stop();
    claudeWorker.stop();
    chatgptWorker.stop();
  });

  await t.test('4. Crash Recovery, Lease Expiration & Attempt Fencing', async () => {
    // 1. Queue a task for Antigravity
    const task = taskManager.createTask({
      fromAgent: 'gemini',
      toAgent: 'antigravity-ide',
      title: 'Crash test task',
      instructions: 'Do flaky work',
      timeoutMs: 50 // Short lease
    });

    // 2. Worker 1 claims task under epoch 1
    const claim1 = taskManager.claimNextTask('antigravity-ide');
    assert.ok(claim1);
    assert.strictEqual(claim1.id, task.id);
    assert.strictEqual(claim1.status, 'claimed');
    const epoch1 = claim1.epoch;

    // 3. Worker 1 "crashes" (stops without submitting result)
    // Wait for lease to expire
    await new Promise(r => setTimeout(r, 60));

    // 4. Lease recovery re-queues task and advances epoch
    const recovered = taskManager.recoverExpiredTasks('antigravity-ide');
    assert.strictEqual(recovered.length, 1);
    assert.strictEqual(recovered[0].status, 'pending');

    // 5. Worker 2 claims task under new monotonic epoch
    const claim2 = taskManager.claimNextTask('antigravity-ide');
    assert.ok(claim2);
    assert.strictEqual(claim2.id, task.id);
    assert.ok(claim2.epoch > epoch1, 'Monotonic epoch must advance upon recovery');

    // 6. Stale Worker 1 attempts to submit with old epoch -> Denied / Fenced!
    if (taskManager.attempts) {
      assert.throws(() => {
        taskManager.updateTaskStatus({
          taskId: task.id,
          agentId: 'antigravity-ide',
          status: 'completed',
          result: 'Stale worker 1 result',
          epoch: epoch1
        });
      }, /FENCE|EPOCH|STALE/i);
    }

    // 7. Legitimate Worker 2 submits under current epoch -> Accepted!
    const finish2 = taskManager.updateTaskStatus({
      taskId: task.id,
      agentId: 'antigravity-ide',
      status: 'completed',
      result: 'Legitimate worker 2 result',
      epoch: claim2.epoch
    });
    assert.strictEqual(finish2.status, 'completed');
  });

  await t.test('5. WorkerSupervisor: Lifecycle, Duplicate Prevention & Tracking', async () => {
    const supervisor = new WorkerSupervisor({
      bridgeRoot: CONFIG.BRIDGE_ROOT,
      dataDir: tmpDir,
      dbPath
    });

    // 1. Initial status is stopped
    const s0 = supervisor.status();
    assert.strictEqual(s0['antigravity-ide'].running, false);

    // 2. Start worker
    const start1 = await supervisor.startWorker('antigravity-ide');
    assert.strictEqual(start1.started, true);
    assert.ok(start1.pid > 0);

    // 3. Duplicate prevention: starting same worker while alive returns alreadyRunning
    const startDuplicate = await supervisor.startWorker('antigravity-ide');
    assert.strictEqual(startDuplicate.started, false);
    assert.strictEqual(startDuplicate.alreadyRunning, true);
    assert.strictEqual(startDuplicate.pid, start1.pid);

    // 4. Status reflects running PID
    const s1 = supervisor.status();
    assert.strictEqual(s1['antigravity-ide'].running, true);
    assert.strictEqual(s1['antigravity-ide'].pid, start1.pid);

    // 5. Stop worker
    const stopRes = await supervisor.stopWorker('antigravity-ide');
    assert.strictEqual(stopRes.stopped, true);

    const s2 = supervisor.status();
    assert.strictEqual(s2['antigravity-ide'].running, false);
  });

  await t.test('6. Identity Security: Impersonation without Token is Rejected', () => {
    const identity = new AgentIdentityManager(logger, 'gemini');

    // Caller claims to be gemini -> matches bound identity
    const res = identity.resolveIdentity('gemini');
    assert.strictEqual(res.authenticated, true);
    assert.strictEqual(res.agentId, 'gemini');

    // Caller on gemini connection attempts privilege escalation to 'system' -> Denied
    assert.throws(() => {
      identity.resolveIdentity('system');
    }, /Security Violation.*Escalation to 'system' identity is denied/);
  });
});
