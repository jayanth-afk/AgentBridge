import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { PresenceManager } from '../src/presence-manager.js';
import { ChatGptAutonomousSession } from '../src/control-plane/chatgpt-autonomous-session.js';
import { ChatGptDesktopWorker } from '../src/control-plane/chatgpt-desktop-worker.js';

/**
 * REAL macOS smoke tests against the live, user-authorized ChatGPT Desktop app.
 * These drive the actual application and consume real model turns, so they are
 * opt-in. Run with:
 *   AGENT_BRIDGE_LIVE_CHATGPT=1 npm test
 */
const LIVE = process.env.AGENT_BRIDGE_LIVE_CHATGPT === '1';
const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_live_chatgpt.sqlite');

test('LIVE ChatGPT Desktop AX smoke + end-to-end bridge round trip', { skip: !LIVE ? 'set AGENT_BRIDGE_LIVE_CHATGPT=1 to run' : false }, async (t) => {
  const session = new ChatGptAutonomousSession({ timeoutMs: 90000 });
  const available = await session.isAvailable();
  if (!available) {
    t.skip('ChatGPT Desktop or the Swift AX helper is not available');
    return;
  }

  await t.test('Session submits to the REAL app and returns the REAL model response', async () => {
    const token = `CHATGPT_AX_LIVE_${Date.now()}`;
    const res = await session.send({
      text: `Reply with exactly the token ${token} and nothing else.`,
      requestId: `req_live_${Date.now()}`,
      timeoutMs: 90000
    });
    assert.equal(res.success, true, `session failed: ${res.status} ${res.error}`);
    assert.equal(res.modelTurnConfirmed, true);
    assert.ok(res.response.includes(token), `expected token in response, got: ${res.response}`);
  });

  await t.test('End-to-end: correlated request -> EventBus -> worker -> REAL ChatGPT -> caller', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const logger = new AuditLogger(TEST_DB);
    const presence = new PresenceManager(logger);
    const eventBus = new EventBus(logger);
    const taskManager = new TaskManager(logger);
    const mailbox = new MailboxHub(logger, taskManager, eventBus);

    presence.heartbeat({ agentId: 'claude-desktop' });
    presence.heartbeat({ agentId: 'chatgpt-desktop' });

    const worker = new ChatGptDesktopWorker({
      agentId: 'chatgpt-desktop',
      mailboxHub: mailbox,
      eventBus,
      session
    });
    await worker.start({ recoverPending: false });

    const token = `CHATGPT_BRIDGE_E2E_${Date.now()}`;
    const res = await mailbox.askAgent({
      fromAgent: 'claude-desktop',
      toAgent: 'chatgpt-desktop',
      question: `Reply with exactly the token ${token} and nothing else.`,
      timeoutMs: 90000
    });

    assert.equal(res.status, 'completed', `request failed: ${res.error}`);
    assert.ok(res.response.includes(token), `expected token in response, got: ${res.response}`);

    worker.stop();
    eventBus.close();
    logger.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });
});
