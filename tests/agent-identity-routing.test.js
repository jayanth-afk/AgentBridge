import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AuditLogger } from '../src/audit-logger.js';
import { AgentIdentityManager, normalizeAgentId, AGENT_ALIASES } from '../src/agent-identity.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { EventBus } from '../src/event-bus.js';
import { PresenceManager } from '../src/presence-manager.js';
import { CONFIG } from '../src/config.js';

test('Stage 1 — Agent Identity, Alias Normalization & Non-Substitution Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-test-'));
  const dbPath = path.join(tmpDir, 'identity.sqlite');
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger);
  const presence = new PresenceManager(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);

  t.after(() => {
    eventBus.close();
    logger.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Alias normalization maps all supported logical aliases', () => {
    assert.strictEqual(normalizeAgentId('claude'), 'claude-desktop');
    assert.strictEqual(normalizeAgentId('claude-desktop'), 'claude-desktop');
    assert.strictEqual(normalizeAgentId('chatgpt'), 'chatgpt-desktop');
    assert.strictEqual(normalizeAgentId('chatgpt-desktop'), 'chatgpt-desktop');
    assert.strictEqual(normalizeAgentId('antigravity'), 'antigravity-ide');
    assert.strictEqual(normalizeAgentId('antigravity-ide'), 'antigravity-ide');
    assert.strictEqual(normalizeAgentId('gemini'), 'gemini');
    assert.strictEqual(normalizeAgentId('gemini-desktop'), 'gemini');
    assert.strictEqual(normalizeAgentId('google-gemini'), 'gemini');
    assert.strictEqual(normalizeAgentId('freebuff'), 'freebuff');
    assert.strictEqual(normalizeAgentId('zia'), 'zia');
    assert.strictEqual(normalizeAgentId('system'), 'system');
    assert.strictEqual(normalizeAgentId('unknown-bot'), 'unknown-bot');
  });

  await t.test('2. Unbound caller supplying Gemini NEVER falls back to Freebuff', () => {
    const identity = new AgentIdentityManager(logger, null);

    const directGemini = identity.resolveIdentity('gemini');
    assert.strictEqual(directGemini.agentId, 'gemini', 'Direct gemini identity must resolve to gemini');
    assert.notStrictEqual(directGemini.agentId, 'freebuff', 'Gemini must NEVER fall back to freebuff');

    const desktopGemini = identity.resolveIdentity('gemini-desktop');
    assert.strictEqual(desktopGemini.agentId, 'gemini', 'gemini-desktop must normalize and resolve to gemini');
    assert.notStrictEqual(desktopGemini.agentId, 'freebuff');

    const googleGemini = identity.resolveIdentity('google-gemini');
    assert.strictEqual(googleGemini.agentId, 'gemini', 'google-gemini must normalize and resolve to gemini');
    assert.notStrictEqual(googleGemini.agentId, 'freebuff');
  });

  await t.test('3. Unbound caller supplying unknown identity is marked isUnknown and never coerced to Freebuff', () => {
    const identity = new AgentIdentityManager(logger, null);
    const res = identity.resolveIdentity('nonexistent-third-party-agent');
    assert.strictEqual(res.agentId, 'nonexistent-third-party-agent');
    assert.strictEqual(res.isUnknown, true);
    assert.strictEqual(res.method, 'unbound_unknown_identity');
    assert.notStrictEqual(res.agentId, 'freebuff', 'Unknown identities must NOT be coerced to freebuff');
  });

  await t.test('4. Alias normalization emits auditable log entry', () => {
    const identity = new AgentIdentityManager(logger, null);
    identity.resolveIdentity('claude');

    const logRow = logger.db.prepare(`
      SELECT * FROM audit_log WHERE action = 'agent_alias_normalized' AND agent_id = 'claude-desktop' ORDER BY timestamp DESC LIMIT 1
    `).get();

    assert.ok(logRow, 'Audit log must record agent_alias_normalized');
    const details = JSON.parse(logRow.details);
    assert.strictEqual(details.raw, 'claude');
    assert.strictEqual(details.normalized, 'claude-desktop');
  });

  await t.test('5. askAgent with alias routes to canonical worker or handler', async () => {
    mailbox.registerAgentHandler('claude-desktop', async (q) => `Canonical Claude: ${q}`);

    // Call using alias 'claude'
    const res = await mailbox.askAgent({
      fromAgent: 'chatgpt',
      toAgent: 'claude',
      question: 'Hello via alias',
      timeoutMs: 1000
    });

    assert.strictEqual(res.status, 'completed');
    assert.strictEqual(res.response, 'Canonical Claude: Hello via alias');
    assert.strictEqual(res.toAgent, 'claude-desktop');
    assert.strictEqual(res.fromAgent, 'chatgpt-desktop');
  });

  await t.test('6. askAgent with missing target agent fails with EXECUTION_UNSUPPORTED', async () => {
    const res = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: null,
      question: 'Ping',
      timeoutMs: 500
    });

    assert.strictEqual(res.status, 'failed');
    assert.strictEqual(res.mode, 'request_failed');
    assert.ok(res.error.includes('EXECUTION_UNSUPPORTED'), 'Error must explicitly state EXECUTION_UNSUPPORTED');
  });

  await t.test('7. askAgent to agent without active worker stays durably pending and times out truthfully', async () => {
    const res = await mailbox.askAgent({
      fromAgent: 'claude-desktop',
      toAgent: 'chatgpt-desktop',
      question: 'Reply if active worker running',
      timeoutMs: 100
    });

    assert.strictEqual(res.status, 'timeout');
    assert.strictEqual(res.mode, 'request_timeout');
    assert.strictEqual(res.recoverable, true);

    // Verify request stays pending in database
    const req = mailbox.getRequest(res.requestId);
    assert.ok(req);
    assert.strictEqual(req.status, 'pending', 'Timed-out request must stay pending for late recovery');
  });
});
