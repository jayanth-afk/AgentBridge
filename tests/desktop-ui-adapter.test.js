import test from 'node:test';
import assert from 'node:assert';
import {
  DesktopUIAdapter,
  ClaudeDesktopUIAdapter,
  ChatGPTDesktopUIAdapter
} from '../src/session-adapters/desktop-ui-adapter.js';
import { CompositeSessionAdapter } from '../src/session-adapters/composite-adapter.js';
import { createSessionAdapter } from '../src/session-adapters/index.js';

test('Desktop UI Automation & Composite Session Adapter Suite', async (t) => {

  await t.test('1. DesktopUIAdapter default safety: requires explicit opt-in', async () => {
    const adapter = new DesktopUIAdapter({ appName: 'Claude' });
    assert.strictEqual(adapter.enabled, false);
    assert.strictEqual(adapter.isActive(), false);

    // Attempting to send without opt-in must be rejected cleanly
    const res = await adapter.sendMessage('Hello Claude', { requestId: 'req_test_01' });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, 'opt_in_required');
    assert.strictEqual(res.status, 'blocked');
  });

  await t.test('2. Failsafe: aborts when target app is not running', async () => {
    const adapter = new DesktopUIAdapter({
      appName: 'NonExistentApplication12345',
      enabled: true
    });
    assert.strictEqual(await adapter.isRunning(), false);

    const res = await adapter.sendMessage('Hello', { requestId: 'req_test_02' });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, 'app_not_running');
    assert.strictEqual(res.status, 'not_running');
  });

  await t.test('3. Failsafe: TARGET_AMBIGUOUS when window count is ambiguous or unverified', async () => {
    const adapter = new DesktopUIAdapter({
      appName: 'TestApp',
      enabled: true,
      requireUnambiguousTarget: true
    });
    adapter.isRunning = async () => true;

    // Mock probe inspection with multiple windows
    adapter.inspectApp = () => ({
      application: 'TestApp',
      running: true,
      accessibilitySupported: true,
      windows: [
        { title: 'Chat Window A', index: 1 },
        { title: 'Chat Window B', index: 2 }
      ],
      inputElements: [],
      buttons: []
    });

    const res = await adapter.sendMessage('Hello', { requestId: 'req_test_03' });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, 'TARGET_AMBIGUOUS');
    assert.strictEqual(res.status, 'target_ambiguous');
    assert.strictEqual(res.windowCount, 2);
  });

  await t.test('4. Duplication protection: prevents sending duplicate requestId', async () => {
    const adapter = new DesktopUIAdapter({
      appName: 'TestApp',
      enabled: true,
      requireUnambiguousTarget: false
    });
    adapter.isRunning = async () => true;

    // Mock inspection to return a valid single window and input
    adapter.inspectApp = () => ({
      application: 'TestApp',
      running: true,
      accessibilitySupported: true,
      windows: [{ title: 'Single Chat Window', index: 1 }],
      inputElements: [{ role: 'AXTextArea', description: 'Prompt' }],
      buttons: [{ title: 'Send', role: 'AXButton' }]
    });

    // Mock execution to avoid actual keystrokes
    adapter._executeAutomation = () => ({
      success: true,
      submitted: true,
      app: 'TestApp',
      window: 'Single Chat Window'
    });

    // First send succeeds
    const firstRes = await adapter.sendMessage('First payload', { requestId: 'req_dup_01' });
    assert.strictEqual(firstRes.success, true);
    assert.strictEqual(firstRes.requestId, 'req_dup_01');

    // Second send with same requestId is blocked
    const secondRes = await adapter.sendMessage('Duplicate payload', { requestId: 'req_dup_01' });
    assert.strictEqual(secondRes.success, false);
    assert.strictEqual(secondRes.duplicate, true);
    assert.strictEqual(secondRes.error, 'duplicate_prevented');
  });

  await t.test('5. ClaudeDesktopUIAdapter and ChatGPTDesktopUIAdapter capabilities and metadata', async () => {
    const claudeAdapter = new ClaudeDesktopUIAdapter({ enabled: false });
    assert.strictEqual(claudeAdapter.appName, 'Claude');
    assert.strictEqual(claudeAdapter.bundleId, 'com.anthropic.claudefordesktop');
    const claudeCaps = claudeAdapter.capabilities();
    assert.strictEqual(claudeCaps.transport, 'desktop-ui');
    assert.strictEqual(claudeCaps.canWake, true);
    assert.strictEqual(claudeCaps.requiresExplicitOptIn, true);

    const chatGptAdapter = new ChatGPTDesktopUIAdapter({ enabled: false });
    assert.strictEqual(chatGptAdapter.appName, 'ChatGPT');
    assert.strictEqual(chatGptAdapter.bundleId, 'com.openai.chat');
    const gptCaps = chatGptAdapter.capabilities();
    assert.strictEqual(gptCaps.transport, 'desktop-ui');
    assert.strictEqual(gptCaps.canWake, true);
  });

  await t.test('6. CompositeSessionAdapter transport routing and fallbacks', async () => {
    const mockMcp = {
      connected: false,
      activeTurn: false,
      isConnected() { return this.connected; },
      isActiveTurn() { return this.activeTurn; },
      sendMessage: async (msg) => ({ success: true, transport: 'mcp', message: msg }),
      capabilities: () => ({ transport: 'mcp', canWake: false })
    };

    const mockUI = new DesktopUIAdapter({
      appName: 'Claude',
      enabled: false // disabled initially
    });

    const composite = new CompositeSessionAdapter({
      agentId: 'claude-desktop',
      mcpAdapter: mockMcp,
      desktopUIAdapter: mockUI
    });

    // 6a. Neither MCP nor UI active -> falls back to notification
    const fallbackRes = await composite.sendMessage('Notification test', { requestId: 'req_comp_01' });
    assert.strictEqual(fallbackRes.success, true);
    assert.strictEqual(fallbackRes.transport, 'notification');

    // 6b. UI enabled with valid mock window -> uses UI adapter
    mockUI.enabled = true;
    mockUI.isRunning = async () => true;
    mockUI.inspectApp = () => ({
      application: 'Claude',
      running: true,
      accessibilitySupported: true,
      windows: [{ title: 'Claude - Chat', index: 1 }],
      inputElements: [{ role: 'AXTextArea', description: 'Prompt' }],
      buttons: []
    });
    mockUI._executeAutomation = () => ({
      success: true,
      submitted: true,
      app: 'Claude',
      window: 'Claude - Chat'
    });

    const uiRes = await composite.sendMessage('UI test', { requestId: 'req_comp_02' });
    assert.strictEqual(uiRes.success, true);
    assert.strictEqual(uiRes.transport, 'desktop-ui');

    // 6c. Active MCP turn -> MCP takes precedence
    mockMcp.connected = true;
    mockMcp.activeTurn = true;
    const mcpRes = await composite.sendMessage('MCP test', { requestId: 'req_comp_03' });
    assert.strictEqual(mcpRes.success, true);
    assert.strictEqual(mcpRes.transport, 'mcp');
  });

  await t.test('7. createSessionAdapter factory initialization', async () => {
    const claudeComposite = createSessionAdapter('claude-desktop', {
      desktopAutomation: { enabled: false }
    });
    assert.ok(claudeComposite instanceof CompositeSessionAdapter);
    const caps = claudeComposite.capabilities();
    assert.strictEqual(caps.agentId, 'claude-desktop');
    assert.strictEqual(caps.transport, 'composite');
    assert.strictEqual(caps.canWake, true); // Since UI adapter is attached

    const status = claudeComposite.diagnostics();
    assert.strictEqual(status.agentId, 'claude-desktop');
    assert.ok('mcp' in status);
    assert.ok('desktopUi' in status);
  });
});
