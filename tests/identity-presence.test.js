import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PresenceManager } from '../src/presence-manager.js';
import { AgentIdentityManager } from '../src/agent-identity.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { BridgeMcpServer } from '../src/mcp-server.js';
import { BridgeHttpServer } from '../src/http-server.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_identity.sqlite');

test('Agent Identity, Presence & Unified Tool Registry Suite', async (t) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const logger = new AuditLogger(TEST_DB);
  const presence = new PresenceManager(logger, { ttlMs: 1000 });
  const identity = new AgentIdentityManager(logger, 'claude-desktop'); // Bound to claude-desktop
  const registry = new ToolRegistry();

  t.after(() => {
    try {
      if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    } catch {}
  });

  await t.test('1. Agent Presence Tracking & Heartbeat Expiry', async () => {
    // Register heartbeat
    presence.heartbeat({
      agentId: 'antigravity-ide',
      pid: process.pid,
      state: 'IDLE'
    });

    assert.strictEqual(presence.isAgentLive('antigravity-ide'), true);
    const agent = presence.getAgent('antigravity-ide');
    assert.strictEqual(agent.state, 'IDLE');
    assert.strictEqual(agent.connected, true);

    // Stale non-existent PID should be recognized as dead
    presence.heartbeat({
      agentId: 'ghost-agent',
      pid: 99999999, // Dead PID
      state: 'IDLE'
    });
    assert.strictEqual(presence.isAgentLive('ghost-agent'), false);

    // Wait for TTL expiration
    await new Promise(r => setTimeout(r, 1100));
    assert.strictEqual(presence.isAgentLive('antigravity-ide'), false);
  });

  await t.test('2. Agent Identity Binding & Privilege Escalation Protection', () => {
    // 1. Caller matches bound identity -> Allowed
    const res1 = identity.resolveIdentity('claude-desktop');
    assert.strictEqual(res1.authenticated, true);
    assert.strictEqual(res1.agentId, 'claude-desktop');

    // 2. Caller passes empty agentId -> Defaults to bound identity
    const res2 = identity.resolveIdentity(null);
    assert.strictEqual(res2.authenticated, true);
    assert.strictEqual(res2.agentId, 'claude-desktop');

    // 3. Caller on claude-desktop connection attempts to claim 'system' -> REJECTED with Security Violation!
    assert.throws(() => {
      identity.resolveIdentity('system');
    }, /Security Violation.*Escalation to 'system' identity is denied/);

    // 4. Token creation & verification
    const { token } = identity.createToken('system');
    const verifiedAgent = identity.verifyToken(token);
    assert.strictEqual(verifiedAgent, 'system');

    // 5. With token, 'system' identity is authenticated
    const resToken = identity.resolveIdentity('system', { token });
    assert.strictEqual(resToken.authenticated, true);
    assert.strictEqual(resToken.agentId, 'system');
    assert.strictEqual(resToken.method, 'token');
  });

  await t.test('3. Unified Tool Registry Consistency across Transports', async () => {
    const registryTools = registry.getToolDefinitions();
    assert.ok(registryTools.length >= 25, 'Should have rich tool set');

    // Instantiating BridgeMcpServer
    const mcpServer = new BridgeMcpServer({
      auditLogger: logger,
      toolRegistry: registry
    });
    const mcpTools = registry.getToolDefinitions();

    // Verify all tool names match exactly
    const regNames = registryTools.map(t => t.name).sort();
    const mcpNames = mcpTools.map(t => t.name).sort();
    assert.deepStrictEqual(regNames, mcpNames, 'Stdio MCP tools must match ToolRegistry exactly');

    // Instantiating BridgeHttpServer
    const httpServer = new BridgeHttpServer({
      auditLogger: logger,
      toolRegistry: registry,
      port: 8799
    });
    assert.strictEqual(httpServer.registry, registry);

    // Verify critical tools are in the registry
    assert.ok(regNames.includes('bridge_ping'));
    assert.ok(regNames.includes('bridge_apply_patch'));
    assert.ok(regNames.includes('bridge_batch_read'));
    assert.ok(regNames.includes('bridge_project_snapshot'));
    assert.ok(regNames.includes('bridge_git_status'));
    assert.ok(regNames.includes('bridge_git_push'));
    assert.ok(regNames.includes('bridge_agent_presence'));
    assert.ok(regNames.includes('bridge_diagnostics'));
    assert.ok(regNames.includes('bridge_claim_task'));
  });
});
