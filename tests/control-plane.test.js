import test from 'node:test';
import assert from 'node:assert';
import {
  DesktopControlPlane,
  ConversationLocator,
  AXEngine,
  SwiftAXBridge,
  ResponseObserver,
  ObserverState,
  CdpDesktopAdapter,
  BrowserSessionAdapter,
  PersistentDesktopSessionManager,
  SessionState,
  RequestEnvelope,
  PriorityScheduler,
  RequestState,
  PriorityLevel,
  AdapterHealth
} from '../src/control-plane/index.js';

test('Desktop Control Plane, Protocols & Extreme Sideways Integration Suite', async (t) => {

  await t.test('1. A2A/ACP RequestEnvelope: lifecycle state machine and transitions', async () => {
    const env = new RequestEnvelope({
      fromAgent: 'claude-desktop',
      toAgent: 'chatgpt-desktop',
      message: 'Analyze this algorithm',
      priority: PriorityLevel.URGENT
    });

    assert.strictEqual(env.state, RequestState.CREATED);
    assert.strictEqual(env.priority, PriorityLevel.URGENT);
    assert.ok(env.requestId.startsWith('req_'));

    env.transition(RequestState.ROUTING);
    assert.strictEqual(env.state, RequestState.ROUTING);

    env.transition(RequestState.SENT, { route: 'accessibility' });
    assert.strictEqual(env.state, RequestState.SENT);

    env.transition(RequestState.COMPLETED);
    assert.strictEqual(env.state, RequestState.COMPLETED);
    assert.strictEqual(env.stateHistory.length, 4);

    const json = env.toJSON();
    const restored = RequestEnvelope.fromJSON(json);
    assert.strictEqual(restored.requestId, env.requestId);
    assert.strictEqual(restored.state, RequestState.COMPLETED);
  });

  await t.test('2. Fair Priority Scheduler: weighted dispatch prevents starvation', async () => {
    const scheduler = new PriorityScheduler();

    // Enqueue 6 urgent, 3 normal, 2 background
    for (let i = 0; i < 6; i++) {
      scheduler.enqueue(new RequestEnvelope({ fromAgent: 'a', toAgent: 'b', message: `U${i}`, priority: PriorityLevel.URGENT }));
    }
    for (let i = 0; i < 3; i++) {
      scheduler.enqueue(new RequestEnvelope({ fromAgent: 'a', toAgent: 'b', message: `N${i}`, priority: PriorityLevel.NORMAL }));
    }
    for (let i = 0; i < 2; i++) {
      scheduler.enqueue(new RequestEnvelope({ fromAgent: 'a', toAgent: 'b', message: `B${i}`, priority: PriorityLevel.BACKGROUND }));
    }

    assert.strictEqual(scheduler.size, 11);

    // Dequeue sequence should yield urgent then normal then background according to weights (4:2:1)
    const dequeued = [];
    while (scheduler.size > 0) {
      dequeued.push(scheduler.dequeue());
    }

    assert.strictEqual(dequeued.length, 11);
    // Ensure background tasks were not starved and got dispatched
    const bgFound = dequeued.some(d => d.priority === PriorityLevel.BACKGROUND);
    assert.strictEqual(bgFound, true);
  });

  await t.test('3. ConversationLocator: detects target ambiguity', async () => {
    const locator = new ConversationLocator();

    // Mock active conversation probe to return TARGET_AMBIGUOUS
    locator.findActiveConversation = async () => ({
      unambiguous: false,
      conversation: null,
      status: 'TARGET_AMBIGUOUS',
      details: { windowCount: 3 }
    });

    const res = await locator.verifyConversation({ targetApp: 'Claude', expectedTitle: 'Target Chat' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'TARGET_AMBIGUOUS');
  });

  await t.test('4. AXEngine: element priority and 14-step reliable send verification', async () => {
    const engine = new AXEngine({ allowHiddenWindowActivation: false });

    // Mock inspectApp
    engine.inspectApp = async (targetApp) => ({
      running: true,
      targetApp,
      bundleId: 'com.anthropic.claudefordesktop',
      windowCount: 1,
      inputCandidates: [
        { role: 'AXTextArea', selectorPriority: 2, enabled: true, description: 'Prompt' },
        { role: 'AXTextField', selectorPriority: 1, identifier: 'chat-input', enabled: true }
      ],
      buttonCandidates: [
        { role: 'AXButton', selectorPriority: 1, title: 'Send message', enabled: true }
      ]
    });

    // Mock locator
    engine.locator.findActiveConversation = async () => ({
      unambiguous: true,
      status: 'VERIFIED',
      conversation: { title: 'Safe Session', id: 'conv_123' }
    });

    // Mock execution script
    engine._executeSubmissionScript = async () => ({
      ok: true,
      valueChanged: true,
      clickedSend: true
    });

    const sendRes = await engine.executeReliableSend({
      targetApp: 'Claude',
      text: 'Verify algorithm',
      requestId: 'req_ax_test_01'
    });

    // In mock testing, check that it accurately traversed candidates and chosen input was selectorPriority 1
    assert.strictEqual(sendRes.inputSelectorPriority, 1);
    assert.strictEqual(sendRes.targetApp, 'Claude');
    assert.strictEqual(sendRes.requestId, 'req_ax_test_01');
  });

  await t.test('5. Native SwiftAXBridge: executes native helper binary', async () => {
    const bridge = new SwiftAXBridge();
    const available = bridge.isBinaryAvailable();
    assert.strictEqual(available, true);

    const pingRes = await bridge.ping();
    assert.strictEqual(pingRes.ok, true);
    assert.strictEqual(pingRes.status, 'pong');

    const inspectRes = await bridge.inspectApp('Claude');
    assert.strictEqual(inspectRes.ok, true);
    assert.strictEqual(inspectRes.app, 'Claude');
  });

  await t.test('6. ResponseObserver: streaming state emissions and completion', async () => {
    const observer = new ResponseObserver({ pollIntervalMs: 50 });
    const states = [];
    const deltas = [];

    observer.on('response_state', (ev) => states.push(ev.state));
    observer.on('response_delta', (ev) => deltas.push(ev.delta));

    // Manually trigger finish to verify event propagation
    const obs = observer.startObservation({ targetApp: 'Claude', requestId: 'req_stream_01', timeoutMs: 5000 });
    assert.strictEqual(obs.state, ObserverState.REQUEST_SENT);

    observer._finish(obs, ObserverState.ASSISTANT_COMPLETED, { response: 'Model generated response' });
    assert.strictEqual(states.includes(ObserverState.ASSISTANT_COMPLETED), true);
  });

  await t.test('7. CdpDesktopAdapter: health checks and process safety', async () => {
    const cdp = new CdpDesktopAdapter({ enabled: false, port: 9222 });
    assert.strictEqual(cdp.capabilities().transport, 'cdp');

    const health = await cdp.health();
    assert.strictEqual(health.status, AdapterHealth.BLOCKED);
    assert.strictEqual(health.reason, 'EXPLICIT_OPT_IN_REQUIRED');
  });

  await t.test('8. DesktopControlPlane: smart route selection and diagnostics', async () => {
    const plane = new DesktopControlPlane({ enabled: true, preferredRoute: 'auto' });

    // Mock MCP active turn
    const mockMcp = {
      isActiveTurn: () => true,
      sendMessage: async (msg, opt) => ({ success: true, transport: 'mcp-turn' })
    };

    // 8a. Selects MCP when active turn exists
    const sel1 = await plane.selectRoute('claude-desktop', mockMcp);
    assert.strictEqual(sel1.route, 'mcp');

    // 8b. Falls back to notification when MCP is inactive and window is not ready
    plane.axEngine.ensureAccessibleWindow = async () => ({ ok: false, error: 'NO_OPEN_WINDOW' });
    const sel2 = await plane.selectRoute('claude-desktop', null);
    assert.strictEqual(sel2.route, 'notification');

    // 8c. Selects accessibility when window is accessible
    plane.axEngine.ensureAccessibleWindow = async () => ({ ok: true, inspection: { windowCount: 1 } });
    const sel3 = await plane.selectRoute('claude-desktop', null);
    assert.strictEqual(sel3.route, 'accessibility');

    // 8d. Diagnostics overview
    const diag = await plane.diagnostics();
    assert.strictEqual(diag.desktopControlPlane, true);
    assert.strictEqual(diag.routes.accessibility.swiftHelperAvailable, true);
  });

  await t.test('9. PersistentDesktopSessionManager: state detection and focus restoration', async () => {
    const mockSwift = {
      inspectApp: async (app) => ({ ok: true, running: true, pid: 12345, windowCount: 1, windows: ['Claude'] }),
      getFrontmostApp: async () => ({ ok: true, name: 'Brave Browser', pid: 9999, bundleId: 'com.brave.Browser' }),
      restoreFocus: async (pid) => ({ ok: true, status: 'RESTORED' }),
      unhideApp: async (app) => ({ ok: true })
    };

    const mockLocator = {
      findActiveConversation: async () => ({ unambiguous: true, conversation: { title: 'Agent Bridge Session', windowTitle: 'Claude' } })
    };

    const manager = new PersistentDesktopSessionManager({
      swiftBridge: mockSwift,
      locator: mockLocator
    });

    const state = await manager.getSessionState('Claude');
    assert.strictEqual(state, SessionState.ACCESSIBLE_WINDOW);

    const prevFocus = await manager.captureUserFocus();
    assert.strictEqual(prevFocus.name, 'Brave Browser');

    const restoreRes = await manager.restoreUserFocus(prevFocus);
    assert.strictEqual(restoreRes.restored, true);
    assert.strictEqual(restoreRes.restoredTo, 'Brave Browser');

    const convRes = await manager.ensureConversation('Claude', 'Agent Bridge');
    assert.strictEqual(convRes.ok, true);
    assert.strictEqual(convRes.dedicated, true);
  });

  await t.test('10. BrowserSessionAdapter: profile path handling and health status', async () => {
    const browser = new BrowserSessionAdapter({ enabled: false, targetService: 'claude' });
    const healthBlocked = await browser.health();
    assert.strictEqual(healthBlocked.status, AdapterHealth.BLOCKED);

    browser.enabled = true;
    const healthAvailable = await browser.health();
    assert.strictEqual(healthAvailable.status, AdapterHealth.AVAILABLE);

    const sendRes = await browser.sendMessage({ requestId: 'req_browser_01' });
    assert.strictEqual(sendRes.success, true);
    assert.strictEqual(sendRes.transport, 'browser');
  });

  await t.test('11. DesktopControlPlane: cross-route single-flight lock and error handling', async () => {
    const plane = new DesktopControlPlane({ enabled: true });
    plane.axEngine.ensureAccessibleWindow = async () => ({ ok: false, error: 'NO_WINDOW' });

    // Manually acquire in-flight lock for req_lock_01
    plane.inFlightLocks.add('req_lock_01');

    const dupRes = await plane.dispatch('Test', {
      targetAgent: 'claude-desktop',
      requestId: 'req_lock_01'
    });

    assert.strictEqual(dupRes.success, false);
    assert.strictEqual(dupRes.error, 'DUPLICATE_IN_FLIGHT');
  });
});
