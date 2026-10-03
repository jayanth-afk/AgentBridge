import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { ClaudeDesktopSession } from '../src/control-plane/claude-desktop-session.js';
import { ClaudeDesktopWorker } from '../src/control-plane/claude-desktop-worker.js';
import { ChatGptDesktopWorker } from '../src/control-plane/chatgpt-desktop-worker.js';
import { DesktopAgentWorker } from '../src/control-plane/desktop-agent-worker.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_claude_worker.sqlite');

function makeFakeBridge(overrides = {}) {
  return {
    isBinaryAvailable: () => true,
    inspectApp: async () => ({ ok: true, running: true, windowCount: 1 }),
    ...overrides
  };
}

test('Claude Desktop Autonomous Delivery Suite', async (t) => {
  await t.test('1. Claude session tags the request and requires a real response', async () => {
    const seen = [];
    const session = new ClaudeDesktopSession({
      swiftBridge: makeFakeBridge(),
      innerSession: {
        async send({ text, requestId }) {
          seen.push({ text, requestId });
          return { success: true, status: 'COMPLETED', response: 'CLAUDE_REAL_ANSWER', latencyMs: 4 };
        }
      }
    });
    const res = await session.send({ text: 'answer this', requestId: 'req_cl_01' });
    assert.equal(res.success, true);
    assert.equal(res.modelTurnConfirmed, true);
    assert.equal(res.response, 'CLAUDE_REAL_ANSWER');
    assert.match(seen[0].text, /\[AB:req_cl_01\]/);
  });

  await t.test('2. Claude session rejects a success-without-response (notification fallback)', async () => {
    const session = new ClaudeDesktopSession({
      swiftBridge: makeFakeBridge(),
      innerSession: {
        async send() { return { success: true, status: 'delivered_notification', response: undefined }; }
      }
    });
    const res = await session.send({ text: 'x', requestId: 'req_cl_02' });
    assert.equal(res.success, false);
    assert.equal(res.modelTurnConfirmed, false);
    assert.equal(res.response, null);
  });

  await t.test('3. Claude session reports accessibility unavailable truthfully', async () => {
    const session = new ClaudeDesktopSession({
      swiftBridge: makeFakeBridge({ isBinaryAvailable: () => false })
    });
    const res = await session.send({ text: 'x', requestId: 'req_cl_03' });
    assert.equal(res.success, false);
    assert.equal(res.status, 'CLAUDE_ACCESSIBILITY_UNAVAILABLE');
  });

  await t.test('4. Claude worker resolves a correlated request over the EventBus', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const logger = new AuditLogger(TEST_DB);
    const eventBus = new EventBus(logger);
    const taskManager = new TaskManager(logger);
    const mailbox = new MailboxHub(logger, taskManager, eventBus);

    const session = new ClaudeDesktopSession({
      swiftBridge: makeFakeBridge(),
      innerSession: {
        async send({ requestId }) {
          return { success: true, status: 'COMPLETED', response: `CLAUDE_ANSWER ${requestId}`, latencyMs: 2 };
        }
      }
    });
    const worker = new ClaudeDesktopWorker({ agentId: 'claude-desktop', mailboxHub: mailbox, eventBus, session });
    await worker.start({ recoverPending: false });

    const res = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'Reverse direction',
      timeoutMs: 6000
    });
    assert.equal(res.status, 'completed');
    assert.match(res.response, /CLAUDE_ANSWER/);

    const row = mailbox.getRequest(res.requestId);
    assert.equal(row.status, 'completed');

    worker.stop();
    eventBus.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  await t.test('6. Concurrent requests are serialized (single UI composer per app)', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const logger = new AuditLogger(TEST_DB);
    const eventBus = new EventBus(logger);
    const taskManager = new TaskManager(logger);
    const mailbox = new MailboxHub(logger, taskManager, eventBus);

    const now = new Date().toISOString();
    for (const id of ['req_ser_1', 'req_ser_2']) {
      mailbox.db.prepare(`
        INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, timeout_ms, created_at, updated_at)
        VALUES (?, ?, 'chatgpt-desktop', 'claude-desktop', 'q', 'pending', 60000, ?, ?)
      `).run(id, 'conv_' + id, now, now);
    }

    let active = 0; let maxActive = 0;
    const session = {
      async send({ requestId }) {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise(r => setTimeout(r, 25));
        active--;
        return { success: true, status: 'COMPLETED', response: 'ok:' + requestId };
      },
      async capabilities() { return {}; }
    };
    const worker = new ClaudeDesktopWorker({ agentId: 'claude-desktop', mailboxHub: mailbox, eventBus, session });
    await worker.start({ recoverPending: false });

    const [a, b] = await Promise.all([worker.handleRequest('req_ser_1'), worker.handleRequest('req_ser_2')]);
    assert.equal(a.handled, true);
    assert.equal(b.handled, true);
    // Never two model turns on the single composer at once.
    assert.equal(maxActive, 1);
    assert.equal(mailbox.getRequest('req_ser_1').status, 'completed');
    assert.equal(mailbox.getRequest('req_ser_2').status, 'completed');

    worker.stop();
    eventBus.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  await t.test('5. Both participants share the same generic worker contract', async () => {
    assert.ok(new ChatGptDesktopWorker({ session: { capabilities: async () => ({}), send: async () => ({}) } }) instanceof DesktopAgentWorker);
    assert.ok(new ClaudeDesktopWorker({ session: { capabilities: async () => ({}), send: async () => ({}) } }) instanceof DesktopAgentWorker);
    const w = new ClaudeDesktopWorker({ session: { capabilities: async () => ({ transport: 'x', engine: 'y' }), send: async () => ({}) } });
    const caps = await w.capabilities();
    assert.equal(caps.agentId, 'claude-desktop');
    assert.equal(caps.autonomousExecution, true);
    assert.equal(caps.eventDriven, true);
  });
});
