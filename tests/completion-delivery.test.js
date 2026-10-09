import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { DesktopControlPlane } from '../src/control-plane/desktop-control-plane.js';
import { ResponseObserver } from '../src/control-plane/response-observer.js';

/** A deterministic accessibility probe: marker first, then the response text. */
function makeProbe(requestId, responseText, { markerAppearsAtCall = 1, responseAppearsAtCall = 2 } = {}) {
  let calls = 0;
  return async () => {
    calls++;
    const regions = [];
    if (calls >= markerAppearsAtCall) regions.push({ snippet: `[AB:${requestId}]\nsubmitted prompt` });
    if (calls >= responseAppearsAtCall) regions.push({ snippet: responseText });
    return { running: true, textRegions: regions };
  };
}

function makeEnv(dbPath) {
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger, { fallbackIntervalMs: 100 });
  const tasks = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, tasks, eventBus);
  return { logger, eventBus, tasks, mailbox };
}

test('Completion-triggered event-driven response delivery', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-test-'));
  const dbPath = path.join(tmpDir, 'completion.sqlite');
  const env = makeEnv(dbPath);

  t.after(() => {
    try { env.eventBus.close(); } catch {}
    try { env.logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  async function makePendingRequest(suffix) {
    const queued = await env.mailbox.askAgent({
      fromAgent: 'antigravity-ide',
      toAgent: 'claude-desktop',
      question: `question ${suffix}`,
      asyncMode: true,
      timeoutMs: 60000
    });
    return queued;
  }

  await t.test('1. observer completion settles the durable request and resolves the waiter without polling', async () => {
    const { requestId } = await makePendingRequest('obs1');
    const waiter = env.eventBus.waitForResponse({ requestId, timeoutMs: 5000 });

    const plane = new DesktopControlPlane({
      mailboxHub: env.mailbox,
      pollIntervalMs: 15,
      probe: makeProbe(requestId, 'OBSERVER_ANSWER')
    });

    plane.observer.startObservation({ targetApp: 'Claude', requestId, timeoutMs: 3000 });
    const outcome = await waiter;
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.response, 'OBSERVER_ANSWER');

    const durable = env.mailbox.getRequest(requestId);
    assert.equal(durable.status, 'completed');
    assert.equal(durable.response, 'OBSERVER_ANSWER');

    const timeline = env.mailbox.tracer.getTimeline(requestId).map(s => s.stage);
    assert.ok(timeline.includes('RESULT_PERSISTED'), 'result must be persisted');
    assert.ok(timeline.includes('WAITER_RESOLVED'), 'waiter must resolve on completion');
  });

  await t.test('2. duplicate completion notifications settle once (idempotent)', async () => {
    const { requestId, taskId } = await makePendingRequest('dup');
    const plane = new DesktopControlPlane({ mailboxHub: env.mailbox });

    const first = await plane.settleFromCompletion({ requestId, targetApp: 'Claude', response: 'ONCE' });
    assert.equal(first.handled, true);

    const second = await plane.settleFromCompletion({ requestId, targetApp: 'Claude', response: 'AGAIN' });
    assert.equal(second.handled, false);
    assert.equal(second.reason, 'ALREADY_TERMINAL');

    const durable = env.mailbox.getRequest(requestId);
    assert.equal(durable.response, 'ONCE', 'the first durable result must stand');
    assert.ok(taskId);
  });

  await t.test('3. completion before waiter registration still resolves (no missed-completion race)', async () => {
    const { requestId } = await makePendingRequest('pre');
    const plane = new DesktopControlPlane({ mailboxHub: env.mailbox });
    const res = await plane.settleFromCompletion({ requestId, targetApp: 'Claude', response: 'EARLY' });
    assert.equal(res.handled, true);

    // Register the waiter only AFTER the completion exists.
    const outcome = await env.eventBus.waitForResponse({ requestId, timeoutMs: 1000 });
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.response, 'EARLY');
  });

  await t.test('4. multiple simultaneous waiters all receive the completion', async () => {
    const { requestId } = await makePendingRequest('multi');
    const w1 = env.eventBus.waitForResponse({ requestId, timeoutMs: 3000 });
    const w2 = env.eventBus.waitForResponse({ requestId, timeoutMs: 3000 });
    const plane = new DesktopControlPlane({ mailboxHub: env.mailbox });
    await plane.settleFromCompletion({ requestId, targetApp: 'Claude', response: 'BOTH' });

    const [r1, r2] = await Promise.all([w1, w2]);
    assert.equal(r1.response, 'BOTH');
    assert.equal(r2.response, 'BOTH');
  });

  await t.test('5. a completion for a different target application is refused (correlation safety)', async () => {
    const { requestId } = await makePendingRequest('mismatch');
    const plane = new DesktopControlPlane({ mailboxHub: env.mailbox });
    const res = await plane.settleFromCompletion({ requestId, targetApp: 'ChatGPT', response: 'WRONG' });
    assert.equal(res.handled, false);
    assert.equal(res.reason, 'TARGET_MISMATCH');
    assert.equal(env.mailbox.getRequest(requestId).status, 'pending', 'request must remain pending');
  });

  await t.test('6. an empty completion is never persisted as success', async () => {
    const { requestId } = await makePendingRequest('empty');
    const plane = new DesktopControlPlane({ mailboxHub: env.mailbox });
    const res = await plane.settleFromCompletion({ requestId, targetApp: 'Claude', response: '' });
    assert.equal(res.handled, false);
    assert.equal(res.reason, 'EMPTY_RESPONSE');
    assert.equal(env.mailbox.getRequest(requestId).status, 'pending');
  });

  await t.test('7. late completion after a caller timeout stays durable and retrievable', async () => {
    const { requestId } = await makePendingRequest('late');
    const timedOut = await env.eventBus.waitForResponse({ requestId, timeoutMs: 30 });
    assert.equal(timedOut.status, 'timeout');
    assert.equal(timedOut.recoverable, true);

    const plane = new DesktopControlPlane({ mailboxHub: env.mailbox });
    const res = await plane.settleFromCompletion({ requestId, targetApp: 'Claude', response: 'LATE_BUT_VALID' });
    assert.equal(res.handled, true);

    const durable = env.mailbox.getRequest(requestId);
    assert.equal(durable.status, 'completed');
    assert.equal(durable.response, 'LATE_BUT_VALID');

    const reattached = await env.eventBus.waitForResponse({ requestId, timeoutMs: 1000 });
    assert.equal(reattached.response, 'LATE_BUT_VALID');
  });

  await t.test('8. without a durable request store the control plane is a safe no-op', async () => {
    const plane = new DesktopControlPlane({});
    const res = await plane.settleFromCompletion({ requestId: 'req_absent', response: 'X' });
    assert.equal(res.handled, false);
    assert.equal(res.reason, 'NO_MAILBOX_OR_REQUEST_ID');
  });

  await t.test('9. observer timeout does not overwrite durable state (truthful failure, late result preserved)', async () => {
    const { requestId } = await makePendingRequest('obstimeout');
    // Probe that never surfaces the correlated response => observer times out.
    const plane = new DesktopControlPlane({
      mailboxHub: env.mailbox,
      pollIntervalMs: 10,
      probe: async () => ({ running: true, textRegions: [{ snippet: `[AB:${requestId}]\nprompt` }] })
    });
    let failedEvent = null;
    plane.on('observer_failed', (e) => { failedEvent = e; });
    plane.observer.startObservation({ targetApp: 'Claude', requestId, timeoutMs: 60 });
    await new Promise(r => setTimeout(r, 160));

    assert.ok(failedEvent, 'observer failure should be surfaced as an event');
    assert.equal(env.mailbox.getRequest(requestId).status, 'pending',
      'an observer timeout must not mark the durable request failed');
  });

  await t.test('10. ResponseObserver emits completion exactly once and never a partial response', async () => {
    let calls = 0;
    const observer = new ResponseObserver({
      pollIntervalMs: 10,
      probe: async () => {
        calls++;
        const regions = [{ snippet: '[AB:req_observer_unit]\nprompt' }];
        if (calls === 2) regions.push({ snippet: 'PART' });
        if (calls >= 3) regions.push({ snippet: 'PARTIAL_GROWTH' });
        return { running: true, textRegions: regions };
      }
    });

    const completions = [];
    observer.on('response_completed', (ev) => completions.push(ev));
    observer.startObservation({ targetApp: 'Claude', requestId: 'req_observer_unit', timeoutMs: 2000 });

    // Poll until completion or a bounded wait.
    for (let i = 0; i < 50 && completions.length === 0; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(completions.length, 1, 'completion must fire exactly once');
    assert.equal(completions[0].response, 'PARTIAL_GROWTH');
  });

  await t.test('11. completion is delivered across processes (peer process settles the durable row)', async () => {
    const { requestId } = await makePendingRequest('xp');
    const peerLogger = new AuditLogger(dbPath);
    const peerBus = new EventBus(peerLogger, { fallbackIntervalMs: 100 });
    const peerMailbox = new MailboxHub(peerLogger, new TaskManager(peerLogger), peerBus);

    const waiter = env.eventBus.waitForResponse({ requestId, timeoutMs: 5000 });
    const peerPlane = new DesktopControlPlane({ mailboxHub: peerMailbox });
    const res = await peerPlane.settleFromCompletion({ requestId, targetApp: 'Claude', response: 'FROM_PEER' });
    assert.equal(res.handled, true);

    const outcome = await waiter;
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.response, 'FROM_PEER');

    peerBus.close();
    try { peerLogger.close(); } catch {}
  });
});
