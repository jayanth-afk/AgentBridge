import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelOrchestrator } from '../src/control-plane/model-orchestrator.js';
import { ChatGptLocalEngineAdapter } from '../src/control-plane/chatgpt-local-engine.js';
import { ClaudeAutonomousSession } from '../src/control-plane/claude-autonomous-session.js';
import { ConversationRegistry } from '../src/control-plane/conversation-registry.js';
import { SwiftAXBridge } from '../src/control-plane/swift-ax-bridge.js';
import { RequestState } from '../src/protocol/envelope.js';

test('ConversationRegistry & Session Lifecycle Suite', async (t) => {
  const registry = new ConversationRegistry();

  await t.test('1. Create, query, and update conversational activity', () => {
    const record = registry.createConversation({
      conversationId: 'conv_unit_01',
      agent: 'chatgpt',
      transport: 'chatgpt-local-engine',
      threadId: 'thread_abc123'
    });

    assert.equal(record.conversationId, 'conv_unit_01');
    assert.equal(record.agent, 'chatgpt');
    assert.equal(record.turnCount, 0);

    registry.updateActivity('conv_unit_01', {
      request: 'Hello',
      response: 'World',
      latencyMs: 120
    });

    const updated = registry.get('conv_unit_01');
    assert.equal(updated.turnCount, 1);
    assert.equal(updated.lastResponse, 'World');
    assert.equal(updated.lastLatencyMs, 120);
  });

  await t.test('2. Attach newly discovered threadId and metadata', () => {
    registry.attach('conv_unit_01', {
      threadId: 'thread_updated_999',
      windowTitle: 'ChatGPT - Active Session'
    });

    const updated = registry.get('conv_unit_01');
    assert.equal(updated.threadId, 'thread_updated_999');
    assert.equal(updated.windowTitle, 'ChatGPT - Active Session');
  });

  await t.test('3. Query by agent and invalidation', () => {
    const list = registry.findByAgent('chatgpt');
    assert.equal(list.length, 1);

    registry.invalidate('conv_unit_01', 'USER_CLOSED');
    const invalidated = registry.get('conv_unit_01');
    assert.equal(invalidated.status, 'invalidated');

    const activeList = registry.findByAgent('chatgpt');
    assert.equal(activeList.length, 0);
  });
});

test('ClaudeAutonomousSession Unified Transport Suite', async (t) => {
  const swiftBridge = new SwiftAXBridge();
  const claudeSession = new ClaudeAutonomousSession({ swiftBridge });

  await t.test('1. Transport resolution hierarchy', async () => {
    // When MCP adapter is active
    const mockMcp = { isActiveTurn: () => true };
    const t1 = await claudeSession.selectTransport(mockMcp);
    assert.equal(t1.transport, 'mcp');

    // Without active MCP: checks live window accessibility or falls back
    const t2 = await claudeSession.selectTransport(null);
    assert.ok(['accessibility', 'notification', 'cdp', 'browser'].includes(t2.transport));
  });

  await t.test('2. Health inspection against live Mac system', async () => {
    const health = await claudeSession.health();
    // Claude is running on this Mac
    assert.equal(health.running, true);
    assert.ok(health.windowCount >= 0);
  });
});

test('ChatGptLocalEngineAdapter Advanced Capabilities Suite', async (t) => {
  const engine = new ChatGptLocalEngineAdapter();

  await t.test('1. Discover and capabilities reporting', () => {
    const disc = engine.discover();
    assert.equal(disc.installed, true);
    assert.equal(disc.idleModelWake, true);

    const caps = engine.capabilities();
    assert.equal(caps.idleModelWake, true);
    assert.equal(caps.multiTurnSupported, true);
    assert.equal(caps.cancellationSupported, true);
  });

  await t.test('2. Cancellation stops in-flight execution and releases resources', async () => {
    const reqId = `req_cancel_${Date.now()}`;
    const p = engine.executeTurn({
      prompt: 'Write a 5000 word essay about astrophysics',
      requestId: reqId,
      timeoutMs: 30000
    });

    // Wait 250ms for process spawn then cancel
    await new Promise(r => setTimeout(r, 250));
    const cancelRes = await engine.cancel(reqId);
    assert.equal(cancelRes.cancelled, true);

    const turnRes = await p;
    assert.equal(turnRes.ok, false);
    assert.equal(turnRes.error, 'CANCELLED');
  });

  await t.test('3. Real streaming events emission', async () => {
    const events = [];
    const res = await engine.executeTurn({
      prompt: 'Reply with the number 42.',
      timeoutMs: 25000,
      onEvent: (evt) => events.push(evt.type)
    });

    assert.equal(res.ok, true);
    assert.ok(events.includes('thread.started'));
    assert.ok(events.includes('turn.started'));
    assert.ok(events.includes('turn.completed'));
    assert.ok(res.response.includes('42'));
  });
});

test('ModelOrchestrator Autonomous Multi-Hop & Delegation Suite', async (t) => {
  const orchestrator = new ModelOrchestrator();

  await t.test('1. Live Status Reporting (bridge status)', async () => {
    const status = await orchestrator.getLiveStatus();
    assert.ok(status.timestamp);
    assert.equal(status.agents.chatgpt.running, true);
    assert.equal(status.agents.claude.running, true);
    assert.equal(status.agents.chatgpt.idleModelWake, true);
    assert.equal(status.agents.antigravity.idleModelWake, true);
  });

  await t.test('2. LIVE_MODEL Delegation to ChatGPT Desktop', async () => {
    const res = await orchestrator.delegateModelTask({
      fromAgent: 'antigravity-ide',
      toAgent: 'chatgpt-desktop',
      message: 'Compute 17 + 25. Reply with just the numeric answer.'
    });

    assert.equal(res.success, true);
    assert.equal(res.toAgent, 'chatgpt-desktop');
    assert.equal(res.transport, 'chatgpt-local-engine');
    assert.ok(res.response.includes('42'));
    assert.equal(res.state, RequestState.DELIVERED);
    assert.ok(res.latencyMs > 0);
  });

  // Hop 3 drives the real Claude Desktop model, so it needs live Claude quota and
  // is gated like the other live tests. Run with: AGENT_BRIDGE_LIVE_MODELS=1 npm test
  await t.test('3. Autonomous Multi-Hop Loop with Live Model Turn', { skip: process.env.AGENT_BRIDGE_LIVE_MODELS === '1' ? false : 'requires live Claude quota; set AGENT_BRIDGE_LIVE_MODELS=1' }, async () => {
    const hopRecords = [];

    // Hop 1: ChatGPT starts task asking Antigravity for a math token
    const t0 = Date.now();
    const hop1Res = await orchestrator.delegateModelTask({
      fromAgent: 'chatgpt',
      toAgent: 'antigravity',
      message: 'math_double 50'
    });
    hopRecords.push({ hop: 1, from: 'chatgpt', to: 'antigravity', res: hop1Res, latencyMs: Date.now() - t0 });

    // Hop 2: Antigravity sends result to real ChatGPT model for verification
    const t1 = Date.now();
    const hop2Res = await orchestrator.delegateModelTask({
      fromAgent: 'antigravity',
      toAgent: 'chatgpt',
      message: `Antigravity computed: ${hop1Res.response}. Is double of 50 equal to 100? Answer YES or NO.`
    });
    hopRecords.push({ hop: 2, from: 'antigravity', to: 'chatgpt', res: hop2Res, latencyMs: Date.now() - t1 });

    // Hop 3: Return result back through Claude session
    const t2 = Date.now();
    const hop3Res = await orchestrator.delegateModelTask({
      fromAgent: 'chatgpt',
      toAgent: 'claude',
      message: `Verified math output from ChatGPT: ${hop2Res.response}`
    });
    hopRecords.push({ hop: 3, from: 'chatgpt', to: 'claude', res: hop3Res, latencyMs: Date.now() - t2 });

    assert.equal(hopRecords.length, 3);
    assert.equal(hop1Res.success, true);
    assert.equal(hop2Res.success, true);
    assert.ok(hop2Res.response.toUpperCase().includes('YES'));
    assert.equal(hop3Res.success, true);

    // Verify metrics separation
    assert.ok(hop1Res.latencyMs < 50, 'Antigravity worker should be sub-50ms');
    assert.ok(hop2Res.latencyMs > 1000, 'Real ChatGPT model turn should be > 1000ms');
  });
});
