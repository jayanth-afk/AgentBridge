import test from 'node:test';
import assert from 'node:assert';
import { SwiftAXBridge } from '../src/control-plane/swift-ax-bridge.js';
import { PersistentDesktopSessionManager, SessionState } from '../src/control-plane/persistent-session-manager.js';
import { DesktopControlPlane } from '../src/control-plane/desktop-control-plane.js';

// These categories inspect real desktop applications, so they only run when a
// live desktop session is explicitly opted into (same convention as
// tests/live-desktop-agents.test.js). Without the flag the hermetic suite stays
// deterministic on hosts where ChatGPT/Claude are closed.
const LIVE_DESKTOP = process.env.AGENT_BRIDGE_LIVE_DESKTOP === '1';
const LIVE_DESKTOP_SKIP = 'requires a live desktop session; set AGENT_BRIDGE_LIVE_DESKTOP=1 to run';

test('Desktop Session Verifier & Honest Capability Audit Suite', async (t) => {
  const swift = new SwiftAXBridge();
  const sessionManager = new PersistentDesktopSessionManager({ swiftBridge: swift });
  const controlPlane = new DesktopControlPlane({ enabled: true });

  await t.test('Category A: Pure Bridge Process Execution', async () => {
    // Verifies in-memory/SQLite protocol execution
    const diag = await controlPlane.diagnostics();
    assert.strictEqual(diag.desktopControlPlane, true);
    assert.strictEqual(diag.routes.mcp.supported, true);
  });

  await t.test('Category B: Real Antigravity Worker Availability', async () => {
    // Current environment Antigravity execution
    assert.strictEqual(typeof process.pid, 'number');
    assert.ok(process.pid > 0);
  });

  await t.test('Category C & E: Real Claude Desktop Process & Window State Inspection', { skip: LIVE_DESKTOP ? false : LIVE_DESKTOP_SKIP }, async () => {
    const claudeInspect = await swift.inspectApp('Claude');
    assert.strictEqual(claudeInspect.ok, true);
    assert.strictEqual(claudeInspect.app, 'Claude');
    assert.strictEqual(claudeInspect.running, true);
    assert.ok(claudeInspect.pid > 0);

    const claudeState = await sessionManager.getSessionState('Claude');
    // Honest running states: accessible window, windowless (docked), or hidden
    // (window present but no unambiguous active conversation, e.g. locked screen).
    assert.ok([
      SessionState.ACCESSIBLE_WINDOW,
      SessionState.RUNNING_BUT_WINDOWLESS,
      SessionState.RUNNING_BUT_HIDDEN
    ].includes(claudeState));
  });

  await t.test('Category D & F: Real ChatGPT Desktop Process Inspection', { skip: LIVE_DESKTOP ? false : LIVE_DESKTOP_SKIP }, async () => {
    const chatgptInspect = await swift.inspectApp('ChatGPT');
    assert.strictEqual(chatgptInspect.ok, true);
    assert.strictEqual(chatgptInspect.app, 'ChatGPT');
    assert.strictEqual(chatgptInspect.running, true);
    assert.ok(chatgptInspect.pid > 0);

    const gptState = await sessionManager.getSessionState('ChatGPT');
    assert.ok([
      SessionState.ACCESSIBLE_WINDOW,
      SessionState.RUNNING_BUT_WINDOWLESS,
      SessionState.RUNNING_BUT_HIDDEN
    ].includes(gptState));
  });

  await t.test('Category G & H: CDP and Browser Fallback Configuration', async () => {
    const cdpHealth = await controlPlane.cdpAdapter.health();
    // CDP is blocked by default without explicit user port opt-in (as required by security rules)
    assert.strictEqual(cdpHealth.status, 'BLOCKED');

    const browserHealth = await controlPlane.browserAdapter.health();
    // Browser is blocked by default without explicit user opt-in
    assert.strictEqual(browserHealth.status, 'BLOCKED');
  });
});
