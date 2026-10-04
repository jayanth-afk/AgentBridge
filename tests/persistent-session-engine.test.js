import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DesktopControlPlane,
  PersistentSessionRegistry,
  RegistrySessionState,
  PersistentDesktopLauncher,
  ResponseCorrelator,
  ChatGptLocalEngineAdapter,
  SwiftAXBridge,
  RequestEnvelope,
  RequestState
} from '../src/control-plane/index.js';

test('PersistentSessionRegistry Suite', async (t) => {
  await t.test('1. Session registration, querying, and audit history', async () => {
    const registry = new PersistentSessionRegistry();
    const session = registry.registerSession({
      agentId: 'claude-desktop',
      application: 'Claude',
      pid: 78396,
      state: RegistrySessionState.ACCESSIBLE,
      capabilities: { cdpAvailable: false }
    });

    assert.ok(session.sessionId);
    assert.equal(session.agentId, 'claude-desktop');
    assert.equal(session.state, RegistrySessionState.ACCESSIBLE);
    assert.equal(session.history.length, 1);

    const queried = registry.getSession(session.sessionId);
    assert.equal(queried.sessionId, session.sessionId);

    const foundByAgent = registry.findSessionForAgent('claude-desktop');
    assert.equal(foundByAgent.sessionId, session.sessionId);
  });

  await t.test('2. Session state transition with events and audit trail', async () => {
    const registry = new PersistentSessionRegistry();
    const session = registry.registerSession({
      agentId: 'chatgpt-desktop',
      application: 'ChatGPT',
      pid: 21757,
      state: RegistrySessionState.RUNNING
    });

    let eventFired = false;
    registry.on('state_changed', ({ sessionId, fromState, toState }) => {
      if (sessionId === session.sessionId) {
        eventFired = true;
        assert.equal(fromState, RegistrySessionState.RUNNING);
        assert.equal(toState, RegistrySessionState.MODEL_TURN_ACTIVE);
      }
    });

    registry.updateSessionState(session.sessionId, RegistrySessionState.MODEL_TURN_ACTIVE, {
      turnId: 'turn-123'
    });

    assert.ok(eventFired);
    assert.equal(session.state, RegistrySessionState.MODEL_TURN_ACTIVE);
    assert.equal(session.history.length, 2);
  });

  await t.test('3. Live revalidation against OS process state', async () => {
    const swiftBridge = new SwiftAXBridge();
    const registry = new PersistentSessionRegistry({ swiftBridge });

    const session = registry.registerSession({
      agentId: 'claude',
      application: 'Claude',
      state: RegistrySessionState.UNKNOWN
    });

    await registry.revalidateSession(session.sessionId);

    // Claude is running on this machine: state should be ACCESSIBLE or WINDOWLESS
    assert.ok([RegistrySessionState.ACCESSIBLE, RegistrySessionState.WINDOWLESS].includes(session.state));
    assert.ok(session.pid > 0);
  });
});

test('ResponseCorrelator Suite', async (t) => {
  const correlator = new ResponseCorrelator();

  await t.test('1. Tagging message embeds compact marker', () => {
    const tagged = correlator.tagMessage('Analyze the git repository.', 'req_test_99');
    assert.equal(tagged, '[AB:req_test_99]\nAnalyze the git repository.');
  });

  await t.test('2. Extracting marker and presence check', () => {
    const text = '[AB:req_test_99]\nAnalyze the git repository.';
    assert.equal(correlator.extractMarker(text), 'req_test_99');
    assert.ok(correlator.hasMarker(text, 'req_test_99'));
    assert.ok(!correlator.hasMarker(text, 'req_other'));
  });

  await t.test('3. Clean response cleanly strips machine marker without polluting user output', () => {
    const raw = '[AB:req_test_99] Here is the requested analysis:\nEverything is clean.';
    const cleaned = correlator.cleanResponse(raw);
    assert.equal(cleaned, 'Here is the requested analysis:\nEverything is clean.');
    assert.ok(!cleaned.includes('[AB:'));
  });

  await t.test('4. Correlate turn returns clean text and verification status', () => {
    const res = correlator.correlateTurn({
      rawResponse: '[AB:req_42] Task complete.',
      expectedRequestId: 'req_42'
    });
    assert.ok(res.correlated);
    assert.equal(res.cleanedText, 'Task complete.');
  });
});

test('PersistentDesktopLauncher Suite', async (t) => {
  await t.test('1. Detect running application readiness without stealing focus', async () => {
    const swiftBridge = new SwiftAXBridge();
    const registry = new PersistentSessionRegistry({ swiftBridge });
    const launcher = new PersistentDesktopLauncher({ swiftBridge, registry });

    const ready = await launcher.ensureAppReady('Claude');
    assert.ok(ready.ok);
    assert.ok(ready.pid > 0);
    assert.ok(ready.windowCount >= 0);
    assert.ok(ready.session);
  });
});

test('ChatGptLocalEngineAdapter Suite', async (t) => {
  const engine = new ChatGptLocalEngineAdapter();

  await t.test('1. Capability reporting and installation check', async () => {
    const caps = engine.capabilities();
    assert.equal(caps.transport, 'chatgpt-local-engine');
    assert.ok(caps.idleModelWake);
    assert.ok(caps.canWake);

    const isInstalled = engine.isInstalled();
    assert.ok(isInstalled);
  });

  await t.test('2. Real non-interactive model execution test', { skip: process.env.AGENT_BRIDGE_LIVE_MODELS === '1' ? false : 'requires live ChatGPT/Codex quota; set AGENT_BRIDGE_LIVE_MODELS=1' }, async () => {
    const testToken = `TEST_TOKEN_${Date.now()}`;
    const result = await engine.executeTurn({
      prompt: `Respond with only the token: ${testToken}`,
      timeoutMs: 30000
    });

    assert.ok(result.ok, `Execution failed: ${result.error}`);
    assert.ok(result.response.includes(testToken) || result.response.length > 0);
    assert.ok(result.latencyMs > 0);
    assert.ok(result.threadId);
  });
});

test('DesktopControlPlane Advanced Routing & State Machine Suite', async (t) => {
  await t.test('1. Smart route selection hierarchy', async () => {
    const plane = new DesktopControlPlane();

    // With active MCP adapter: selects mcp
    const mockMcp = { isActiveTurn: () => true };
    const route1 = await plane.selectRoute('claude', mockMcp);
    assert.equal(route1.route, 'mcp');

    // Without active MCP: ChatGPT selects chatgpt-local-engine
    const route2 = await plane.selectRoute('chatgpt');
    assert.equal(route2.route, 'chatgpt-local-engine');
  });

  await t.test('2. Single-flight lock prevents duplicate dispatch across routes', async () => {
    const plane = new DesktopControlPlane();
    const reqId = `req_lock_${Date.now()}`;

    // Fake lock in flight
    plane.inFlightLocks.add(reqId);

    const res = await plane.dispatch('Test message', {
      targetAgent: 'chatgpt',
      requestId: reqId
    });

    assert.equal(res.success, false);
    assert.equal(res.error, 'DUPLICATE_IN_FLIGHT');
    assert.equal(res.requestId, reqId);
  });

  await t.test('3. Extended RequestState lifecycle tracking', () => {
    const envelope = new RequestEnvelope({
      fromAgent: 'antigravity',
      toAgent: 'chatgpt',
      message: 'Hello'
    });

    envelope.transition(RequestState.ROUTING);
    envelope.transition(RequestState.TRANSPORT_CONNECTED);
    envelope.transition(RequestState.MODEL_TURN_CONFIRMED);
    envelope.transition(RequestState.RESPONSE_CORRELATED);
    envelope.transition(RequestState.DELIVERED);

    assert.equal(envelope.state, RequestState.DELIVERED);
    assert.ok(envelope.isTerminal());
    assert.equal(envelope.stateHistory.length, 6);
  });
});
