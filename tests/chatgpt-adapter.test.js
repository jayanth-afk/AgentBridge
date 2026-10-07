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
import { ResponseCorrelator } from '../src/control-plane/response-correlator.js';
import { ChatGptAutonomousSession } from '../src/control-plane/chatgpt-autonomous-session.js';
import { ZiABackgroundGPT } from '../src/control-plane/zia-background-gpt.js';
import { ChatGptDesktopWorker } from '../src/control-plane/chatgpt-desktop-worker.js';
import { ChatGPTSessionAdapter } from '../src/session-adapters/chatgpt-adapter.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_chatgpt_adapter.sqlite');

function makeFakeBridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    frontmost: { ok: true, name: 'Visual Studio Code', pid: 12345, bundleId: 'com.microsoft.VSCode' },
    isBinaryAvailable: () => true,
    inspectApp: async () => ({ ok: true, running: true, windowCount: 1 }),
    async getFrontmostApp() {
      return this.frontmost;
    },
    async restoreFocus(pid) {
      this.calls.push({ restoreFocus: pid });
      this.frontmost = { ok: true, name: 'Visual Studio Code', pid, bundleId: 'com.microsoft.VSCode' };
      return { ok: true, status: 'RESTORED' };
    },
    async sendAndObserve(app, text, requestId, timeout, options = {}) {
      calls.push({ app, text, requestId, timeout, activate: options && options.activate });
      return { ok: true, status: 'COMPLETED', response: 'REAL_MODEL_RESPONSE', latencyMs: 5, error: null };
    },
    async executeChatGPTJavaScript(javascript) {
      if (javascript.includes('document.title')) return { ok: true, result: 'ChatGPT' };
      if (javascript.includes('document.querySelectorAll')) calls.push({ background: true });
      if (javascript.includes('document.body?.innerText')) return { ok: true, response: 'REAL_MODEL_RESPONSE' };
      return { ok: true, result: '{"ok":true}' };
    },
    async submitBackgroundDom() {
      calls.push({ background: true });
      return { ok: true };
    },
    async readBackgroundDomResponse() {
      return { ok: true, response: 'REAL_MODEL_RESPONSE' };
    },
    async setChatGPTMinimized(minimized) {
      calls.push({ minimized });
      return { ok: true, status: minimized ? 'MINIMIZED_STATE_SET' : 'MINIMIZED_STATE_SET' };
    },
    ...overrides
  };
}

test('ChatGPT Autonomous Desktop Delivery Suite', async (t) => {
  // ---------------------------------------------------------------------------
  // Session-level (real-model transport) with an injected Swift bridge fake.
  // ---------------------------------------------------------------------------
  await t.test('1. Session submits a correlation-tagged request to the real app', async () => {
    const fakeBridge = makeFakeBridge();
    const session = new ChatGptAutonomousSession({ swiftBridge: fakeBridge });
    const res = await session.send({ text: 'Please reply with a token', requestId: 'req_session_01' });

    assert.equal(res.success, true);
    assert.equal(res.modelTurnConfirmed, true);
    assert.equal(res.status, 'COMPLETED');
    assert.equal(res.response, 'REAL_MODEL_RESPONSE');
    assert.equal(fakeBridge.calls.length, 1);
    assert.equal(fakeBridge.calls[0].app, 'ChatGPT');
    assert.equal(fakeBridge.calls[0].requestId, 'req_session_01');
    // The correlation marker must be embedded in the submitted payload.
    assert.match(fakeBridge.calls[0].text, /\[AB:req_session_01\]/);
  });

  await t.test('2. Session reports accessibility unavailable truthfully', async () => {
    const session = new ChatGptAutonomousSession({
      swiftBridge: makeFakeBridge({ isBinaryAvailable: () => false })
    });
    const res = await session.send({ text: 'hi', requestId: 'req_noax_01' });
    assert.equal(res.success, false);
    assert.equal(res.modelTurnConfirmed, false);
    assert.equal(res.status, 'CHATGPT_ACCESSIBILITY_UNAVAILABLE');
  });

  await t.test('3. Response timeout never reports a completed model turn', async () => {
    const fakeBridge = makeFakeBridge({
      sendAndObserve: async () => ({
        ok: false,
        status: 'CHATGPT_RESPONSE_TIMEOUT',
        response: null,
        error: 'no correlated response observed'
      })
    });
    const session = new ChatGptAutonomousSession({ swiftBridge: fakeBridge });
    const res = await session.send({ text: 'hi', requestId: 'req_timeout_01' });
    assert.equal(res.success, false);
    assert.equal(res.modelTurnConfirmed, false);
    assert.equal(res.status, 'CHATGPT_RESPONSE_TIMEOUT');
    assert.equal(res.response, null);
    // Submission happened, but no model turn was confirmed.
    assert.equal(res.uiSubmitted, true);
  });

  await t.test('4. Session capabilities are truthful (GUI engine, not headless)', async () => {
    const session = new ChatGptAutonomousSession({ swiftBridge: makeFakeBridge() });
    const caps = await session.capabilities();
    assert.equal(caps.trueHeadlessEngine, false);
    assert.equal(caps.idleModelWake, true);
    assert.equal(caps.transport, 'chatgpt-desktop-accessibility');
  });

  // ---------------------------------------------------------------------------
  // Correlation acceptance / rejection.
  // ---------------------------------------------------------------------------
  await t.test('5. Background mode never asks the AX bridge to activate ChatGPT', async () => {
    const fakeBridge = makeFakeBridge();
    const backgroundTarget = { resolvePersisted: async () => ({ ok: true, status: 'BACKGROUND_TARGET_READY' }) };
    const session = new ChatGptAutonomousSession({ swiftBridge: fakeBridge, background: true, backgroundTarget });
    const res = await session.send({ text: 'background turn', requestId: 'req_background_01' });
    assert.equal(res.success, true);
    assert.equal(fakeBridge.calls.some(call => call.background === true), true);
    assert.equal(fakeBridge.calls.some(call => call.activate === true), false);
    assert.equal(fakeBridge.calls.some(call => call.minimized === true), false);
    const caps = await session.capabilities();
    assert.equal(caps.backgroundSubmission, true);
    assert.equal(caps.backgroundModelWake, true);
    assert.equal(caps.trueHeadlessEngine, false);
  });

  await t.test('6. Foreground/default mode preserves activation behavior', async () => {
    const fakeBridge = makeFakeBridge();
    const session = new ChatGptAutonomousSession({ swiftBridge: fakeBridge });
    await session.send({ text: 'foreground turn', requestId: 'req_foreground_01' });
    assert.equal(fakeBridge.calls[0].activate, true);
  });

  await t.test('6a. Background mode repeatedly enforces the minimized ChatGPT invariant', async () => {
    const fakeBridge = makeFakeBridge();
    const backgroundTarget = { resolvePersisted: async () => ({ ok: true, status: 'BACKGROUND_TARGET_READY' }) };
    const session = new ChatGptAutonomousSession({ swiftBridge: fakeBridge, background: true, backgroundTarget });
    const res = await session.send({ text: 'minimized invariant', requestId: 'req_minimized_01' });

    assert.equal(res.success, true);
    assert.equal(fakeBridge.calls.some(call => call.restoreFocus), false);
  });

  await t.test('6aa. Background mode never activates or restores frontmost focus', async () => {
    const fakeBridge = makeFakeBridge();
    fakeBridge.getFrontmostApp = async () => {
      throw new Error('background GPT must not require frontmost inspection during a turn');
    };
    fakeBridge.restoreFocus = async () => {
      throw new Error('restoreFocus must never be used by background GPT');
    };

    const backgroundTarget = { resolvePersisted: async () => ({ ok: true, status: 'BACKGROUND_TARGET_READY' }) };
    const session = new ChatGptAutonomousSession({ swiftBridge: fakeBridge, background: true, backgroundTarget });
    const res = await session.send({ text: 'stay on dedicated Space', requestId: 'req_background_space_02' });

    assert.equal(res.success, true);
    assert.equal(fakeBridge.calls.some(call => call.restoreFocus), false);
    assert.equal(fakeBridge.calls.some(call => call.activate === true), false);
  });

  await t.test('6b. ZiA Background GPT falls back to non-activating AX when JS is unavailable', async () => {
    const fakeBridge = makeFakeBridge({
      async executeChatGPTJavaScript() { return { ok: false, error: 'APPLE_EVENTS_JS_UNAVAILABLE' }; },
      async sendAndObserve(app, text, requestId, timeout, options = {}) {
        this.calls.push({ app, text, requestId, timeout, activate: options.activate, background: true });
        return { ok: true, status: 'COMPLETED', response: 'AX_BACKGROUND_RESPONSE', latencyMs: 7, error: null };
      }
    });
    const backgroundTarget = { resolvePersisted: async () => ({ ok: true, status: 'BACKGROUND_TARGET_READY' }) };
    const session = new ZiABackgroundGPT({ swiftBridge: fakeBridge, backgroundTarget });
    const res = await session.send({ text: 'background AX fallback', requestId: 'req_background_ax_01' });

    assert.equal(res.success, true);
    assert.equal(res.modelTurnConfirmed, true);
    assert.equal(res.response, 'AX_BACKGROUND_RESPONSE');
    assert.equal(res.transport, 'chatgpt-desktop-background-ax');
    assert.equal(fakeBridge.calls.some(call => call.activate === false), true);
    assert.equal(session.backgroundWorkerName, 'ZiA Background GPT');
  });

  await t.test('6c. Background mode fails closed when the dedicated target is unavailable', async () => {
    const fakeBridge = makeFakeBridge();
    const backgroundTarget = {
      resolvePersisted: async () => ({
        ok: false,
        status: 'BACKGROUND_TARGET_NOT_FOUND',
        error: 'Dedicated conversation missing'
      })
    };
    const session = new ZiABackgroundGPT({ swiftBridge: fakeBridge, backgroundTarget });
    const res = await session.send({ text: 'must not be sent elsewhere', requestId: 'req_target_missing_01' });

    assert.equal(res.success, false);
    assert.equal(res.status, 'BACKGROUND_TARGET_NOT_FOUND');
    assert.equal(res.modelTurnConfirmed, false);
    assert.equal(fakeBridge.calls.some(call => call.background === true), false);
  });

  await t.test('7. Correlation accepts the request marker and rejects stale output', () => {
    const rc = new ResponseCorrelator();
    assert.equal(rc.hasMarker('[AB:req_ok]\nthe answer', 'req_ok'), true);
    assert.equal(rc.hasMarker('an older unrelated answer', 'req_ok'), false);
    const good = rc.correlateTurn({ rawResponse: '[AB:req_ok]\nreal answer', expectedRequestId: 'req_ok' });
    assert.equal(good.correlated, true);
    assert.equal(good.cleanedText, 'real answer');
    assert.equal(good.foundMarker, 'req_ok');
  });

  // ---------------------------------------------------------------------------
  // Worker + EventBus + correlated request/response chain (deterministic).
  // ---------------------------------------------------------------------------
  await t.test('6. EventBus wakes the worker and resolves a correlated request', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const logger = new AuditLogger(TEST_DB);
    const presence = new PresenceManager(logger);
    const eventBus = new EventBus(logger);
    const taskManager = new TaskManager(logger);
    const mailbox = new MailboxHub(logger, taskManager, eventBus);

    presence.heartbeat({ agentId: 'claude-desktop' });
    presence.heartbeat({ agentId: 'chatgpt-desktop' });

    // Use the REAL session (with a fake AX bridge) so correlation tagging and
    // the response path are exercised end to end but deterministically.
    const fakeBridge = makeFakeBridge({
      sendAndObserve: async (app, text, requestId) => {
        fakeBridge.calls.push({ app, text, requestId });
        return { ok: true, status: 'COMPLETED', response: `ChatGPT_REAL_ANSWER for ${requestId}`, latencyMs: 3 };
      }
    });
    const workerSession = new ChatGptAutonomousSession({ swiftBridge: fakeBridge });

    const worker = new ChatGptDesktopWorker({
      agentId: 'chatgpt-desktop',
      mailboxHub: mailbox,
      eventBus,
      session: workerSession
    });
    await worker.start({ recoverPending: false });

    const res = await mailbox.askAgent({
      fromAgent: 'claude-desktop',
      toAgent: 'chatgpt-desktop',
      question: 'Round trip through the bridge',
      timeoutMs: 6000
    });

    assert.equal(res.status, 'completed');
    assert.match(res.response, /ChatGPT_REAL_ANSWER/);
    // The correlated payload submitted to the app carried the request marker.
    assert.equal(fakeBridge.calls.length, 1);
    assert.match(fakeBridge.calls[0].text, new RegExp(`\\[AB:${res.requestId}\\]`));

    // bridge_requests row is resolved with the real response.
    const row = mailbox.getRequest(res.requestId);
    assert.equal(row.status, 'completed');
    assert.match(row.response, /ChatGPT_REAL_ANSWER/);

    worker.stop();
    eventBus.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  await t.test('7. Duplicate delivery of the same requestId is suppressed', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const logger = new AuditLogger(TEST_DB);
    const eventBus = new EventBus(logger);
    const taskManager = new TaskManager(logger);
    const mailbox = new MailboxHub(logger, taskManager, eventBus);

    const req = mailbox.askAgent({
      fromAgent: 'claude-desktop',
      toAgent: 'chatgpt-desktop',
      question: 'dupe test',
      timeoutMs: 800
    }); // no worker subscribed -> will time out, but we control delivery manually below

    // Directly craft a request row + task for deterministic duplicate testing.
    const now = new Date().toISOString();
    mailbox.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, timeout_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 5000, ?, ?)
    `).run('req_dupe_01', 'conv_dupe', 'claude-desktop', 'chatgpt-desktop', 'dupe', now, now);

    let sendCount = 0;
    const worker = new ChatGptDesktopWorker({
      agentId: 'chatgpt-desktop',
      mailboxHub: mailbox,
      eventBus,
      session: {
        async send() { sendCount++; return { success: true, status: 'COMPLETED', response: 'once', modelTurnConfirmed: true }; },
        async capabilities() { return {}; }
      }
    });
    await worker.start({ recoverPending: false });

    const first = await worker.handleRequest('req_dupe_01');
    assert.equal(first.handled, true);
    const second = await worker.handleRequest('req_dupe_01');
    assert.equal(second.duplicate, true);
    assert.equal(second.reason, 'ALREADY_DELIVERED');
    assert.equal(sendCount, 1);

    worker.stop();
    eventBus.close();
    req.catch(() => {});
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  await t.test('8. A failed model turn fails the correlated request (never success)', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    const logger = new AuditLogger(TEST_DB);
    const eventBus = new EventBus(logger);
    const taskManager = new TaskManager(logger);
    const mailbox = new MailboxHub(logger, taskManager, eventBus);

    const worker = new ChatGptDesktopWorker({
      agentId: 'chatgpt-desktop',
      mailboxHub: mailbox,
      eventBus,
      session: {
        async send() { return { success: false, status: 'CHATGPT_RESPONSE_TIMEOUT', response: null, error: 'timeout' }; },
        async capabilities() { return {}; }
      }
    });
    await worker.start({ recoverPending: false });

    const res = await mailbox.askAgent({
      fromAgent: 'claude-desktop',
      toAgent: 'chatgpt-desktop',
      question: 'will fail',
      timeoutMs: 6000
    });

    assert.equal(res.status, 'failed');
    const row = mailbox.getRequest(res.requestId);
    assert.equal(row.status, 'failed');
    assert.equal(row.response, null);

    worker.stop();
    eventBus.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  // ---------------------------------------------------------------------------
  // Session adapter wiring.
  // ---------------------------------------------------------------------------
  await t.test('9. Adapter default capabilities are unchanged (no regression)', async () => {
    const adapter = new ChatGPTSessionAdapter({});
    const caps = adapter.capabilities();
    assert.equal(caps.autonomousExecution, false);
    assert.equal(caps.externalModelWakeup, false);
    assert.equal(caps.requiresUserPrompt, true);
  });

  await t.test('10. Adapter reports real autonomous delivery when a session is injected', async () => {
    const adapter = new ChatGPTSessionAdapter({
      chatgptSession: new ChatGptAutonomousSession({ swiftBridge: makeFakeBridge() })
    });
    const caps = adapter.capabilities();
    assert.equal(caps.autonomousExecution, true);
    assert.equal(caps.externalModelWakeup, true);
    assert.equal(caps.requiresUserPrompt, false);

    const wake = await adapter.wake('test');
    assert.equal(wake.success, true);
    assert.equal(wake.wakeupType, 'chatgpt-desktop-accessibility');
  });
});
