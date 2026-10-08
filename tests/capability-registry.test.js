import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  CapabilityRegistry,
  CapabilityState,
  CapabilityDimension,
  TrustTier
} from '../src/capabilities/capability-registry.js';

test('CapabilityRegistry: Scoped Capabilities & Truthful Probing', async (t) => {
  const db = new DatabaseSync(':memory:');
  const mockLogger = { db };
  const registry = new CapabilityRegistry(mockLogger);

  await t.test('1. Capabilities are scoped to (agent_id, route_id), not agent_id alone', () => {
    registry.setCapability({
      agentId: 'claude-desktop',
      routeId: 'mcp-stdio',
      dimension: CapabilityDimension.AUTONOMOUS_WAKEUP,
      state: CapabilityState.UNSUPPORTED,
      evidence: 'MCP cannot initiate model turn',
      trustTier: TrustTier.T1_ACTIVE_MCP
    });

    registry.setCapability({
      agentId: 'claude-desktop',
      routeId: 'accessibility',
      dimension: CapabilityDimension.AUTONOMOUS_WAKEUP,
      state: CapabilityState.PROBED,
      evidence: 'Synthetic keystrokes via Swift AX',
      trustTier: TrustTier.T4_UI_AUTOMATION
    });

    const mcpWake = registry.getCapability('claude-desktop', 'mcp-stdio', CapabilityDimension.AUTONOMOUS_WAKEUP);
    const axWake = registry.getCapability('claude-desktop', 'accessibility', CapabilityDimension.AUTONOMOUS_WAKEUP);

    assert.equal(mcpWake.state, CapabilityState.UNSUPPORTED);
    assert.equal(mcpWake.trustTier, TrustTier.T1_ACTIVE_MCP);
    assert.equal(axWake.state, CapabilityState.PROBED);
    assert.equal(axWake.trustTier, TrustTier.T4_UI_AUTOMATION);
  });

  await t.test('2. Claude Desktop stdio MCP truthfully marks autonomous_wakeup as UNSUPPORTED', async () => {
    const caps = await registry.probe('claude-desktop', 'mcp-stdio');
    assert.equal(caps.autonomous_wakeup.state, CapabilityState.UNSUPPORTED);
    assert.ok(caps.autonomous_wakeup.evidence.includes('MCP specification does not support server-initiated LLM turn'));
    assert.equal(registry.hasVerifiedCapability('claude-desktop', 'mcp-stdio', CapabilityDimension.AUTONOMOUS_WAKEUP), false);
  });

  await t.test('3. ChatGPT Local Engine probes real codex binary presence', async () => {
    const caps = await registry.probe('chatgpt-desktop', 'chatgpt-local-engine');
    assert.equal(caps.model_execution.state, CapabilityState.VERIFIED);
    assert.equal(caps.autonomous_wakeup.state, CapabilityState.VERIFIED);
    assert.equal(caps.background_execution.state, CapabilityState.VERIFIED);
    assert.equal(registry.hasVerifiedCapability('chatgpt-desktop', 'chatgpt-local-engine', CapabilityDimension.AUTONOMOUS_WAKEUP), true);
  });

  await t.test('4. Declared or Unknown capability is never treated as verified', () => {
    registry.setCapability({
      agentId: 'mystery-agent',
      routeId: 'custom-route',
      dimension: CapabilityDimension.EFFECT_EXECUTION,
      state: CapabilityState.DECLARED,
      evidence: 'Self-declared by untrusted prompt',
      trustTier: TrustTier.T5_NOTIFICATION_HUMAN
    });

    assert.equal(registry.hasVerifiedCapability('mystery-agent', 'custom-route', CapabilityDimension.EFFECT_EXECUTION), false);
  });

  await t.test('5. Notification route is marked UNSUPPORTED for autonomous wakeup', async () => {
    const caps = await registry.probe('chatgpt-desktop', 'notification');
    assert.equal(caps.connectivity.state, CapabilityState.VERIFIED);
    assert.equal(caps.autonomous_wakeup.state, CapabilityState.UNSUPPORTED);
    assert.equal(caps.response_correlation.state, CapabilityState.UNSUPPORTED);
  });
});
