import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { AgentIdentityManager } from '../src/agent-identity.js';
import { BridgeHttpServer } from '../src/http-server.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_http_parity.sqlite');
const KEY = 'parity-secret-key';

async function post(port, endpoint, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

test('HTTP MCP: /mcp and /api/mcp/call share one authenticated path', async (t) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const logger = new AuditLogger(TEST_DB);
  const mailbox = new MailboxHub(logger);
  const port = 8792;
  const server = new BridgeHttpServer({
    port,
    host: '127.0.0.1',
    auditLogger: logger,
    permissionGuard: new PermissionGuard(CONFIG),
    mailboxHub: mailbox,
    identityManager: new AgentIdentityManager(logger, 'gemini'),
    apiKey: KEY
  });
  await server.start();

  t.after(async () => {
    await server.stop();
    try { mailbox.eventBus.close(); } catch {}
    try { logger.close(); } catch {}
    try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch {}
  });

  const call = (endpoint, body, headers) => post(port, endpoint, body, headers);
  const authed = { 'X-API-Key': KEY };

  await t.test('1. Missing authentication is rejected on both endpoints', async () => {
    for (const ep of ['/mcp', '/api/mcp/call']) {
      const r = await call(ep, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(r.status, 401, `${ep} must require the API key`);
    }
  });

  await t.test('2. Invalid authentication is rejected', async () => {
    const r = await call('/api/mcp/call', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'X-API-Key': 'wrong' });
    assert.equal(r.status, 401);
  });

  await t.test('3. Both endpoints return the identical tool list when authenticated', async () => {
    const a = await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authed);
    const b = await call('/api/mcp/call', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, authed);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.ok(Array.isArray(a.json.result.tools) && a.json.result.tools.length > 0);
    assert.deepEqual(
      a.json.result.tools.map(x => x.name),
      b.json.result.tools.map(x => x.name),
      'both paths must expose the same tools'
    );
  });

  await t.test('4. A real tool call returns a real result through both endpoints', async () => {
    for (const ep of ['/mcp', '/api/mcp/call']) {
      const r = await call(ep, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'bridge_ping', arguments: { agentId: 'gemini' } }
      }, authed);
      assert.equal(r.status, 200);
      assert.ok(r.json.result, `${ep} must return a JSON-RPC result`);
      const payload = JSON.parse(r.json.result.content[0].text);
      assert.equal(payload.status, 'OK');
    }
  });

  await t.test('5. Unknown tools report an error result, not a false success', async () => {
    const r = await call('/api/mcp/call', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} }
    }, authed);
    assert.equal(r.status, 200);
    assert.equal(r.json.result.isError, true);
    assert.match(r.json.result.content[0].text, /Unknown tool/);
  });

  await t.test('6. Malformed JSON-RPC yields a 400, never a silent success', async () => {
    const r = await call('/mcp', 'this is not json', authed);
    assert.equal(r.status, 400);
  });

  await t.test('7. Concurrent calls through both endpoints resolve independently', async () => {
    const reqs = [];
    for (let i = 0; i < 10; i++) {
      const ep = i % 2 === 0 ? '/mcp' : '/api/mcp/call';
      reqs.push(call(ep, {
        jsonrpc: '2.0', id: 100 + i, method: 'tools/call',
        params: { name: 'bridge_ping', arguments: { agentId: 'gemini' } }
      }, authed));
    }
    const out = await Promise.all(reqs);
    for (const r of out) {
      assert.equal(r.status, 200);
      const payload = JSON.parse(r.json.result.content[0].text);
      assert.equal(payload.status, 'OK');
    }
  });

  await t.test('8. Unknown JSON-RPC method returns -32601 on both endpoints', async () => {
    for (const ep of ['/mcp', '/api/mcp/call']) {
      const r = await call(ep, { jsonrpc: '2.0', id: 42, method: 'unsupported/method' }, authed);
      assert.equal(r.status, 200);
      assert.ok(r.json.error);
      assert.equal(r.json.error.code, -32601);
      assert.match(r.json.error.message, /Method not found/);
    }
  });

  await t.test('9. Missing tool name returns -32602 on both endpoints', async () => {
    for (const ep of ['/mcp', '/api/mcp/call']) {
      const r = await call(ep, { jsonrpc: '2.0', id: 43, method: 'tools/call', params: {} }, authed);
      assert.equal(r.status, 200);
      assert.ok(r.json.error);
      assert.equal(r.json.error.code, -32602);
      assert.match(r.json.error.message, /Invalid params/);
    }
  });

  await t.test('10. Oversized request body (>5MB) yields 413', async () => {
    const huge = JSON.stringify({ jsonrpc: '2.0', id: 44, method: 'tools/call', padding: 'X'.repeat(5 * 1024 * 1024 + 100) });
    const r = await call('/mcp', huge, authed);
    assert.equal(r.status, 413);
  });

  await t.test('11. Escalation to system over HTTP is denied', async () => {
    const r = await call('/mcp', {
      jsonrpc: '2.0', id: 45, method: 'tools/call',
      params: { name: 'bridge_ping', arguments: { agentId: 'system' } }
    }, authed);
    assert.equal(r.status, 200);
    assert.equal(r.json.result.isError, true);
    assert.match(r.json.result.content[0].text, /Security Violation/);
  });
});
