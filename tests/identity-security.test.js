import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { AgentIdentityManager } from '../src/agent-identity.js';
import { ToolRegistry } from '../src/tool-registry.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_identity_sec.sqlite');

test('Identity binding & impersonation security', async (t) => {
  for (const s of ['', '-wal', '-shm']) {
    const p = `${TEST_DB}${s}`;
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
  }
  const logger = new AuditLogger(TEST_DB);
  const registry = new ToolRegistry();

  t.after(() => {
    try { logger.close(); } catch {}
    for (const s of ['', '-wal', '-shm']) {
      const p = `${TEST_DB}${s}`;
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
    }
  });

  await t.test('bound connection cannot impersonate a different agent', () => {
    const identity = new AgentIdentityManager(logger, 'claude-desktop');
    const res = identity.resolveIdentity('chatgpt-desktop');
    assert.strictEqual(res.agentId, 'claude-desktop', 'must stay bound, not adopt requested id');
    assert.strictEqual(res.authenticated, true);
    assert.strictEqual(res.requestedAgentId, 'chatgpt-desktop');
    assert.strictEqual(res.method, 'connection_binding_forced');
  });

  await t.test('bound connection cannot escalate to system', () => {
    const identity = new AgentIdentityManager(logger, 'claude-desktop');
    assert.throws(() => identity.resolveIdentity('system'), /Security Violation/);
  });

  await t.test('valid token authoritatively overrides the bound identity', () => {
    const identity = new AgentIdentityManager(logger, 'claude-desktop');
    const { token } = identity.createToken('system');
    const res = identity.resolveIdentity('claude-desktop', { token });
    assert.strictEqual(res.agentId, 'system');
    assert.strictEqual(res.authenticated, true);
    assert.strictEqual(res.method, 'token');
  });

  await t.test('legacy impersonation only via explicit opt-in', () => {
    const identity = new AgentIdentityManager(logger, 'claude-desktop');
    const res = identity.resolveIdentity('chatgpt-desktop', { allowCompatibility: true });
    assert.strictEqual(res.agentId, 'chatgpt-desktop');
    assert.strictEqual(res.authenticated, false);
    assert.strictEqual(res.compatibilityMode, true);
  });

  await t.test('unbound caller cannot claim system; known identity is unauthenticated', () => {
    const identity = new AgentIdentityManager(logger, null);
    const sys = identity.resolveIdentity('system');
    assert.strictEqual(sys.agentId, 'freebuff');
    assert.strictEqual(sys.authenticated, false);

    const known = identity.resolveIdentity('claude-desktop');
    assert.strictEqual(known.agentId, 'claude-desktop');
    assert.strictEqual(known.authenticated, false);
  });

  await t.test('tool execution uses bound identity, not a supplied one', async () => {
    const identity = new AgentIdentityManager(logger, 'claude-desktop');
    const res = await registry.executeTool('bridge_ping', { agentId: 'chatgpt-desktop' }, { identity });
    assert.strictEqual(res.caller, 'claude-desktop');
  });

  await t.test('requireAuthentication rejects unauthenticated callers', async () => {
    const unbound = new AgentIdentityManager(logger, null);
    await assert.rejects(
      () => registry.executeTool('bridge_ping', { agentId: 'claude-desktop' }, { identity: unbound, requireAuthentication: true }),
      /Unauthorized/
    );
  });

  await t.test('requireAuthentication accepts a bound caller', async () => {
    const bound = new AgentIdentityManager(logger, 'claude-desktop');
    const res = await registry.executeTool('bridge_ping', { agentId: 'claude-desktop' }, { identity: bound, requireAuthentication: true });
    assert.strictEqual(res.status, 'OK');
  });
});
