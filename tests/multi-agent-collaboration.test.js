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
import { ChatGptDesktopWorker } from '../src/control-plane/chatgpt-desktop-worker.js';
import { ClaudeDesktopWorker } from '../src/control-plane/claude-desktop-worker.js';
import { GeminiDesktopWorker } from '../src/control-plane/gemini-desktop-worker.js';
import {
  AutonomousCollaborationOrchestrator,
  CollaborationStatus
} from '../src/control-plane/autonomous-collaboration-orchestrator.js';
import { ModelOrchestrator } from '../src/control-plane/model-orchestrator.js';

test('End-to-End Autonomous Multi-Agent Collaboration & Lifecycle Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-e2e-'));
  const dbPath = path.join(tmpDir, 'collab_e2e.sqlite');

  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const presence = new PresenceManager(logger);

  t.after(() => {
    eventBus.close();
    logger.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test('1. Multi-Round Autonomous Collaboration: ChatGPT <-> Gemini with Follow-Up & Critique', async () => {
    // Model sessions that simulate authentic model thinking and follow-up turns
    const geminiHistory = [];
    const geminiSession = {
      send: async ({ text, requestId }) => {
        geminiHistory.push({ text, requestId });
        if (text.toLowerCase().includes('critique') || text.toLowerCase().includes('revise')) {
          return {
            success: true,
            status: 'COMPLETED',
            response: `[Gemini Revised Proposal]: Addressing critique on caching and backoff. We add token bucket rate limiting and LRU bounded context cache.`
          };
        }
        return {
          success: true,
          status: 'COMPLETED',
          response: `[Gemini Initial Design]: Distributed multi-agent pipeline using SSE transport and durable SQLite outbox.`
        };
      }
    };

    const chatgptSession = {
      send: async ({ text, requestId }) => {
        if (text.toLowerCase().includes('incorporate') || text.toLowerCase().includes('synthesize')) {
          return {
            success: true,
            status: 'COMPLETED',
            response: `[ChatGPT Final Response to User]: Consensus reached with Gemini. Architectural plan adopts SSE streaming, token-bucket rate limiting, and durable SQLite outbox.`
          };
        }
        return {
          success: true,
          status: 'COMPLETED',
          response: `[ChatGPT Turn]: Delegating system architecture design to Gemini.`
        };
      }
    };

    // Instantiate workers
    const geminiWorker = new GeminiDesktopWorker({
      agentId: 'gemini',
      mailboxHub: mailbox,
      eventBus,
      presenceManager: presence,
      session: geminiSession,
      logger
    });
    await geminiWorker.start({ recoverPending: false });

    const chatgptWorker = new ChatGptDesktopWorker({
      agentId: 'chatgpt-desktop',
      mailboxHub: mailbox,
      eventBus,
      presenceManager: presence,
      session: chatgptSession,
      logger
    });
    await chatgptWorker.start({ recoverPending: false });

    // Round 1: ChatGPT delegates initial task to Gemini
    const convId = `conv_collab_${Date.now()}`;
    const round1 = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'gemini',
      question: 'Design the distributed agent transport architecture for Agent Bridge.',
      conversationId: convId,
      timeoutMs: 5000
    });

    assert.equal(round1.status, 'completed');
    assert.equal(round1.fromAgent, 'chatgpt-desktop');
    assert.equal(round1.toAgent, 'gemini');
    assert.ok(round1.response.includes('[Gemini Initial Design]'), `Expected initial design, got: ${round1.response}`);

    // Round 2: ChatGPT sends follow-up / critique to Gemini in the same conversation
    const round2 = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'gemini',
      question: `Critique on ${round1.requestId}: Initial design lacks caching and backoff strategies. Please revise the proposal.`,
      conversationId: convId,
      timeoutMs: 5000
    });

    assert.equal(round2.status, 'completed');
    assert.equal(round2.fromAgent, 'chatgpt-desktop');
    assert.equal(round2.toAgent, 'gemini');
    assert.ok(round2.response.includes('[Gemini Revised Proposal]'), `Expected revised proposal, got: ${round2.response}`);
    assert.ok(round2.response.includes('token bucket rate limiting'));

    // Round 3: ChatGPT synthesizes final response
    const round3Res = await chatgptSession.send({
      text: `Synthesize user answer incorporating: ${round2.response}`,
      requestId: `req_synth_${Date.now()}`
    });

    assert.equal(round3Res.success, true);
    assert.ok(round3Res.response.includes('[ChatGPT Final Response to User]'));
    assert.ok(round3Res.response.includes('Consensus reached with Gemini'));

    geminiWorker.stop();
    chatgptWorker.stop();
  });

  await t.test('2. Three-Agent Autonomous Collaboration Orchestrator: ChatGPT -> Gemini -> Claude -> ChatGPT', async () => {
    // ModelOrchestrator with mock sessions for all 3 agents
    const orchestratorModel = new ModelOrchestrator({
      chatgptSession: {
        send: async ({ text, requestId }) => ({
          success: true,
          status: 'COMPLETED',
          response: `[ChatGPT Model Turn]: Coordinated objective decomposition and requirements synthesis for turn ${requestId}.`
        })
      },
      geminiSession: {
        send: async ({ text, requestId }) => ({
          success: true,
          status: 'COMPLETED',
          response: `[Gemini Model Turn]: Multimodal context ingestion and data layout completed for turn ${requestId}.`
        })
      },
      claudeSession: {
        send: async ({ text, requestId }) => ({
          success: true,
          status: 'COMPLETED',
          response: `[Claude Model Turn]: Formal invariant verification and security boundary audit verified for turn ${requestId}.`
        })
      },
      mailboxHub: mailbox
    });

    const collabOrchestrator = new AutonomousCollaborationOrchestrator({
      modelOrchestrator: orchestratorModel,
      mailboxHub: mailbox,
      invisibilityMonitor: null, // Pure state test
      maxHops: 6
    });

    // 1. Create collaboration
    const session = collabOrchestrator.createCollaboration({
      objective: 'Verify end-to-end multi-agent protocol safety and token caching across all 3 models',
      authorizedAgents: ['chatgpt', 'gemini', 'claude'],
      initiator: 'chatgpt'
    });

    assert.equal(session.status, CollaborationStatus.ACTIVE);
    assert.equal(session.turns.length, 0);

    // Hop 1: ChatGPT -> Gemini
    const turn1 = await collabOrchestrator.executeTurn({
      collaborationId: session.id,
      fromAgent: 'chatgpt',
      toAgent: 'gemini',
      instruction: 'Analyze the data payload requirements and cache layout.'
    });
    assert.equal(turn1.success, true);
    assert.ok((turn1.turn?.response || turn1.response).includes('[Gemini Model Turn]'));
    assert.equal(session.turns.length, 1);

    // Hop 2: Gemini -> Claude (Security & Verification)
    const turn2 = await collabOrchestrator.executeTurn({
      collaborationId: session.id,
      fromAgent: 'gemini',
      toAgent: 'claude',
      instruction: 'Audit the Gemini cache layout for potential race conditions or authorization leaks.'
    });
    assert.equal(turn2.success, true);
    assert.ok((turn2.turn?.response || turn2.response).includes('[Claude Model Turn]'));
    assert.equal(session.turns.length, 2);

    // Hop 3: Claude -> ChatGPT (Review Delivery & Final Sign-off)
    const turn3 = await collabOrchestrator.executeTurn({
      collaborationId: session.id,
      fromAgent: 'claude',
      toAgent: 'chatgpt',
      instruction: 'Incorporate Claude security verdict into master execution plan.'
    });
    assert.equal(turn3.success, true);
    assert.ok((turn3.turn?.response || turn3.response).includes('[ChatGPT Model Turn]'));
    assert.equal(session.turns.length, 3);

    // Context validation: Prompt passed to Turn 3 contained history of Turn 1 & Turn 2
    const formattedPrompt = collabOrchestrator.formatContextualPrompt({
      session,
      toAgent: 'chatgpt',
      instruction: 'Final check'
    });
    assert.ok(formattedPrompt.includes('[Turn 1] (chatgpt -> gemini)'));
    assert.ok(formattedPrompt.includes('[Turn 2] (gemini -> claude)'));
  });

  await t.test('3. Requester Disconnection and Reconnection Lifecycle', async () => {
    // A requester submits a task in async mode or times out, worker finishes later, requester recovers
    const testSession = {
      send: async () => ({
        success: true,
        status: 'COMPLETED',
        response: 'ASYNC_COMPLETION_RESULT_772'
      })
    };

    const worker = new GeminiDesktopWorker({
      agentId: 'gemini',
      mailboxHub: mailbox,
      eventBus,
      session: testSession,
      logger
    });
    await worker.start({ recoverPending: false });

    // Step A: Requester submits with short timeout (simulating caller disconnect / timeout)
    const shortTimeoutRes = await mailbox.askAgent({
      fromAgent: 'requester-a',
      toAgent: 'gemini',
      question: 'Task that will outlive caller connection',
      timeoutMs: 1 // Instant timeout
    });

    // Step B: Worker processes the task
    await worker.handleRequest(shortTimeoutRes.requestId);

    // Step C: Requester reconnects and retrieves the request status
    const recovered = mailbox.getRequest(shortTimeoutRes.requestId);
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.response, 'ASYNC_COMPLETION_RESULT_772');

    // Step D: Re-calling askAgent with identical requestId returns the completed response idempotently
    const idempotentCall = await mailbox.askAgent({
      fromAgent: 'requester-a',
      toAgent: 'gemini',
      question: 'Task that will outlive caller connection',
      requestId: shortTimeoutRes.requestId,
      timeoutMs: 5000
    });

    assert.equal(idempotentCall.status, 'completed');
    assert.equal(idempotentCall.response, 'ASYNC_COMPLETION_RESULT_772');

    worker.stop();
  });

  await t.test('4. Truthful Error Handling: Provider Failure is Not Fabricated or Masked', async () => {
    // Worker where model returns an explicit API or accessibility error
    const failingSession = {
      send: async () => ({
        success: false,
        status: 'APP_NOT_AVAILABLE',
        error: 'Gemini.app is not running or has no accessible window'
      })
    };

    const failingWorker = new GeminiDesktopWorker({
      agentId: 'gemini',
      mailboxHub: mailbox,
      eventBus,
      session: failingSession,
      logger
    });
    await failingWorker.start({ recoverPending: false });

    const callResult = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'gemini',
      question: 'Should fail gracefully and truthfully',
      timeoutMs: 3000
    });

    assert.equal(callResult.status, 'failed');
    assert.ok(callResult.error.includes('Gemini.app is not running') || callResult.error.includes('APP_NOT_AVAILABLE'),
      `Expected truthful error, got: ${callResult.error}`);

    // Verify task and request records reflect failure in SQLite
    const reqRow = mailbox.getRequest(callResult.requestId);
    assert.equal(reqRow.status, 'failed');
    assert.ok(reqRow.error.includes('Gemini.app is not running') || reqRow.error.includes('APP_NOT_AVAILABLE'));

    failingWorker.stop();
  });

  await t.test('5. Duplicate Delivery Suppression and Monotonic Lease Fencing', async () => {
    let callCount = 0;
    const countingSession = {
      send: async () => {
        callCount++;
        return { success: true, status: 'COMPLETED', response: `TURN_COUNT_${callCount}` };
      }
    };

    const worker = new ClaudeDesktopWorker({
      agentId: 'claude-desktop',
      mailboxHub: mailbox,
      eventBus,
      session: countingSession,
      logger
    });
    await worker.start({ recoverPending: false });

    // Submit request once
    const reqRes = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'Compute nonce turn',
      timeoutMs: 5000
    });
    assert.equal(reqRes.status, 'completed');
    assert.equal(callCount, 1);

    // Attempting to deliver the same requestId again to the worker is suppressed as already delivered
    const duplicateDeliver = await worker.handleRequest(reqRes.requestId);
    assert.equal(duplicateDeliver.duplicate, true);
    assert.equal(duplicateDeliver.reason, 'ALREADY_DELIVERED');
    assert.equal(callCount, 1, 'Model turn must NOT be re-executed for an already-delivered request');

    worker.stop();
  });
});
