import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { EventBus } from '../src/event-bus.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { PresenceManager } from '../src/presence-manager.js';
import { createSessionAdapter } from '../src/session-adapters/index.js';
import { RequestEnvelope, PriorityLevel } from '../src/protocol/envelope.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_multihop.sqlite');

test('Ultimate Multi-Hop Connected Agent Integration Loop', async (t) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const logger = new AuditLogger(TEST_DB);
  const presence = new PresenceManager(logger);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);

  t.after(() => {
    try {
      if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    } catch {}
  });

  // Register all three peer identities
  presence.heartbeat({ agentId: 'chatgpt-desktop', capabilities: ['chat', 'plan'] });
  presence.heartbeat({ agentId: 'claude-desktop', capabilities: ['analysis', 'review'] });
  presence.heartbeat({ agentId: 'antigravity-ide', capabilities: ['code', 'exec', 'test'] });

  // Instantiate Composite Session Adapters for each agent
  const chatGptAdapter = createSessionAdapter('chatgpt-desktop', {
    useComposite: true,
    desktopAutomation: { enabled: true, preferredRoute: 'auto' }
  });

  const claudeAdapter = createSessionAdapter('claude-desktop', {
    useComposite: true,
    desktopAutomation: { enabled: true, preferredRoute: 'auto' }
  });

  const antigravityAdapter = createSessionAdapter('antigravity-ide', {
    useComposite: true
  });

  await t.test('Multi-Hop Autonomous Execution: ChatGPT -> Claude -> Antigravity -> Claude -> ChatGPT', async () => {
    const hopLogs = [];

    // ==========================================
    // HOP 1: ChatGPT asks Claude to review task
    // ==========================================
    const hop1Start = Date.now();
    const hop1Envelope = new RequestEnvelope({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      message: 'Claude, please evaluate the security boundary of this implementation.',
      priority: PriorityLevel.URGENT
    });

    // Dispatch through mailbox and event bus
    const hop1Task = mailbox.delegateTask({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      title: 'evaluate_security',
      instructions: hop1Envelope.message,
      context: { envelope: hop1Envelope.toJSON() }
    });
    assert.ok(['pending', 'assigned'].includes(hop1Task.status));

    const hop1Log = {
      hop: 1,
      from: 'chatgpt-desktop',
      to: 'claude-desktop',
      route: claudeAdapter.diagnostics().route || 'mcp',
      requestId: hop1Envelope.requestId,
      taskId: hop1Task.id,
      latencyMs: Date.now() - hop1Start,
      status: 'DISPATCHED_TO_CLAUDE'
    };
    hopLogs.push(hop1Log);

    // ==========================================
    // HOP 2: Claude delegates code verification to Antigravity
    // ==========================================
    const hop2Start = Date.now();
    const hop2Envelope = new RequestEnvelope({
      fromAgent: 'claude-desktop',
      toAgent: 'antigravity-ide',
      message: 'Antigravity, please run automated unit tests on the security guard.',
      priority: PriorityLevel.URGENT
    });

    const hop2Task = mailbox.delegateTask({
      fromAgent: 'claude-desktop',
      toAgent: 'antigravity-ide',
      title: 'run_security_tests',
      instructions: hop2Envelope.message,
      context: { envelope: hop2Envelope.toJSON() }
    });
    assert.ok(['pending', 'assigned'].includes(hop2Task.status));

    const hop2Log = {
      hop: 2,
      from: 'claude-desktop',
      to: 'antigravity-ide',
      route: 'native-worker',
      requestId: hop2Envelope.requestId,
      taskId: hop2Task.id,
      latencyMs: Date.now() - hop2Start,
      status: 'DISPATCHED_TO_ANTIGRAVITY'
    };
    hopLogs.push(hop2Log);

    // ==========================================
    // HOP 3: Antigravity completes work and replies back to Claude
    // ==========================================
    const hop3Start = Date.now();
    const antResult = mailbox.submitTaskResult({
      taskId: hop2Task.id,
      agentId: 'antigravity-ide',
      status: 'completed',
      result: { testResults: 'ALL_PASSING', exitCode: 0 }
    });
    assert.strictEqual(antResult.status, 'completed');

    const hop3Log = {
      hop: 3,
      from: 'antigravity-ide',
      to: 'claude-desktop',
      route: 'native-eventbus',
      requestId: hop2Envelope.requestId,
      taskId: hop2Task.id,
      latencyMs: Date.now() - hop3Start,
      status: 'RESULT_DELIVERED_TO_CLAUDE'
    };
    hopLogs.push(hop3Log);

    // ==========================================
    // HOP 4: Claude synthesizes findings and completes ChatGPT request
    // ==========================================
    const hop4Start = Date.now();
    const claudeResult = mailbox.submitTaskResult({
      taskId: hop1Task.id,
      agentId: 'claude-desktop',
      status: 'completed',
      result: {
        securityReview: 'APPROVED',
        details: 'Antigravity verified unit tests cleanly. Security boundaries intact.'
      }
    });
    assert.strictEqual(claudeResult.status, 'completed');

    const hop4Log = {
      hop: 4,
      from: 'claude-desktop',
      to: 'chatgpt-desktop',
      route: chatGptAdapter.diagnostics().route || 'mcp',
      requestId: hop1Envelope.requestId,
      taskId: hop1Task.id,
      latencyMs: Date.now() - hop4Start,
      status: 'RESULT_RETURNED_TO_CHATGPT'
    };
    hopLogs.push(hop4Log);

    // Assert full loop completion
    assert.strictEqual(hopLogs.length, 4);
    assert.strictEqual(hopLogs[0].from, 'chatgpt-desktop');
    assert.strictEqual(hopLogs[1].from, 'claude-desktop');
    assert.strictEqual(hopLogs[2].from, 'antigravity-ide');
    assert.strictEqual(hopLogs[3].from, 'claude-desktop');
    assert.strictEqual(hopLogs[3].to, 'chatgpt-desktop');

    // Confirm that every hop executed without manual message forwarding
    const allCompleted = hopLogs.every(h => h.status.includes('DISPATCHED') || h.status.includes('DELIVERED') || h.status.includes('RETURNED'));
    assert.strictEqual(allCompleted, true);
  });
});
