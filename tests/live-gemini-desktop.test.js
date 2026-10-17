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
import { GeminiDesktopSession } from '../src/control-plane/gemini-desktop-session.js';
import { GeminiDesktopWorker } from '../src/control-plane/gemini-desktop-worker.js';

/**
 * REAL macOS smoke tests against the live, user-authorized Google Gemini
 * Desktop app. These drive the actual application and consume real model turns,
 * so they are opt-in. Run with:
 *   AGENT_BRIDGE_LIVE_DESKTOP=1 npm test
 */
const LIVE = process.env.AGENT_BRIDGE_LIVE_DESKTOP === '1';
const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_live_gemini.sqlite');

test('LIVE Gemini Desktop AX smoke + end-to-end bridge round trip', { skip: !LIVE ? 'set AGENT_BRIDGE_LIVE_DESKTOP=1 to run' : false }, async (t) => {
  const session = new GeminiDesktopSession({ timeoutMs: 90000 });
  const available = await session.isAvailable();
  if (!available) {
    t.skip('Gemini Desktop or the Swift AX helper is not available');
    return;
  }

  await t.test('Session submits to the REAL app and returns the REAL model response', async () => {
    const token = `GEMINI_AX_LIVE_${Date.now()}`;
    const res = await session.send({
      text: `Reply with exactly the token ${token} and nothing else.`,
      requestId: `req_live_gemini_${Date.now()}`,
      timeoutMs: 90000
    });
    assert.equal(res.success, true, `session failed: ${res.status} ${res.error}`);
    assert.equal(res.modelTurnConfirmed, true);
    assert.equal(res.transport, 'gemini-desktop-accessibility');
    assert.ok(res.response.includes(token), `expected token in response, got: ${res.response}`);
  });

  await t.test('End-to-end: correlated request -> EventBus -> worker -> REAL Gemini -> caller', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const logger = new AuditLogger(TEST_DB);
    const presence = new PresenceManager(logger);
    const eventBus = new EventBus(logger);
    const taskManager = new TaskManager(logger);
    const mailbox = new MailboxHub(logger, taskManager, eventBus);

    presence.heartbeat({ agentId: 'claude-desktop' });
    presence.heartbeat({ agentId: 'gemini' });

    const worker = new GeminiDesktopWorker({
      agentId: 'gemini',
      mailboxHub: mailbox,
      eventBus,
      session
    });
    await worker.start({ recoverPending: false });

    const token = `GEMINI_BRIDGE_E2E_${Date.now()}`;
    const res = await mailbox.askAgent({
      fromAgent: 'claude-desktop',
      toAgent: 'gemini',
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
