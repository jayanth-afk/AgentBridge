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
import { ChatGptDesktopWorker } from '../src/control-plane/chatgpt-desktop-worker.js';
import { ClaudeDesktopWorker } from '../src/control-plane/claude-desktop-worker.js';

/**
 * REAL macOS smoke tests: a correlated request over the EventBus is delivered to
 * the real desktop app and the real model response is returned to the caller.
 * Opt-in because each consumes a real model turn:
 *   AGENT_BRIDGE_LIVE_DESKTOP=1 npm test
 */
const LIVE = process.env.AGENT_BRIDGE_LIVE_DESKTOP === '1';

async function roundTrip(t, { WorkerClass, agentId, tokenPrefix }) {
  const db = path.join(CONFIG.DATA_DIR, `test_live_desktop_${agentId}.sqlite`);
  if (fs.existsSync(db)) fs.unlinkSync(db);
  const logger = new AuditLogger(db);
  const presence = new PresenceManager(logger);
  const eventBus = new EventBus(logger);
  const mailbox = new MailboxHub(logger, new TaskManager(logger), eventBus);

  presence.heartbeat({ agentId: 'peer-agent' });
  presence.heartbeat({ agentId });

  const worker = new WorkerClass({ agentId, mailboxHub: mailbox, eventBus });
  const available = await worker.session.isAvailable();
  if (!available) {
    worker.stop(); eventBus.close(); logger.close();
    t.skip(`${agentId} app or Swift AX helper unavailable`);
    return;
  }
  await worker.start({ recoverPending: false });

  const token = `${tokenPrefix}_${Date.now()}`;
  const res = await mailbox.askAgent({
    fromAgent: 'peer-agent',
    toAgent: agentId,
    question: `Reply with exactly the token ${token} and nothing else.`,
    timeoutMs: 180000
  });

  assert.equal(res.status, 'completed', `${agentId} round trip failed: ${res.error}`);
  assert.ok(String(res.response).includes(token), `expected token in ${agentId} response, got: ${res.response}`);

  worker.stop();
  eventBus.close();
  logger.close();
  try { fs.unlinkSync(db); } catch {}
}

test('LIVE real desktop agent workers', { skip: !LIVE ? 'set AGENT_BRIDGE_LIVE_DESKTOP=1 to run' : false }, async (t) => {
  await t.test('Real ChatGPT Desktop worker round trip', async () => {
    await roundTrip(t, { WorkerClass: ChatGptDesktopWorker, agentId: 'chatgpt-desktop', tokenPrefix: 'LIVE_CHATGPT' });
  });

  await t.test('Real Claude Desktop worker round trip', async () => {
    await roundTrip(t, { WorkerClass: ClaudeDesktopWorker, agentId: 'claude-desktop', tokenPrefix: 'LIVE_CLAUDE' });
  });
});
