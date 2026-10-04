import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { ProjectController } from '../src/project-controller.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { BridgeHttpServer } from '../src/http-server.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_e2e.sqlite');
const WS = CONFIG.TEST_WORKSPACE;
const PORT = 8998;
const KEY = 'e2e-acceptance-key';
const AGENT = 'claude-desktop';

function rmDb() {
  for (const s of ['', '-wal', '-shm', '-journal']) {
    const p = `${TEST_DB}${s}`;
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
  }
}

async function post(port, method, params, { key = KEY, id = 1, rawHeaders = null } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(rawHeaders || {}) };
  if (key && !rawHeaders) headers['Authorization'] = `Bearer ${key}`;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function call(port, name, args, opts = {}) {
  const r = await post(port, 'tools/call', { name, arguments: args }, opts);
  if (r.status !== 200) return r;
  const text = r.json.result.content.map(c => c.text).join('\n');
  return { ...r, text, isError: r.json.result.isError === true };
}

test('Agent Bridge end-to-end acceptance (real HTTP stack)', async (t) => {
  rmDb();
  if (!fs.existsSync(WS)) fs.mkdirSync(WS, { recursive: true });

  const logger = new AuditLogger(TEST_DB);
  const guard = new PermissionGuard(CONFIG);
  const controller = new ProjectController(guard, logger);
  const mailbox = new MailboxHub(logger);
  const server = new BridgeHttpServer({
    port: PORT,
    host: '127.0.0.1',
    auditLogger: logger,
    permissionGuard: guard,
    mailboxHub: mailbox,
    projectController: controller,
    apiKey: KEY,
    requireApiKey: true
  });

  const created = path.join(WS, 'e2e_created.txt');
  if (fs.existsSync(created)) fs.unlinkSync(created);

  t.after(async () => {
    try { await server.stop(); } catch {}
    try { fs.unlinkSync(created); } catch {}
    try { logger.close(); } catch {}
    rmDb();
  });

  // 1. START
  await t.test('START: server binds and reports readiness', async () => {
    const info = await server.start();
    assert.strictEqual(info.port, PORT);
    const health = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { Authorization: `Bearer ${KEY}` } });
    assert.strictEqual(health.status, 200);
    const body = await health.json();
    assert.strictEqual(body.status, 'healthy');
    assert.strictEqual(body.authEnabled, true);
  });

  // 2. AUTH boundary precedes handlers
  await t.test('AUTH: unauthorized cannot reach tools/list or tools/call', async () => {
    assert.strictEqual((await post(PORT, 'tools/list', {}, { key: null })).status, 401);
    assert.strictEqual((await post(PORT, 'tools/call', { name: 'bridge_ping', arguments: {} }, { key: null })).status, 401);
    assert.strictEqual((await post(PORT, 'tools/list', {}, { key: 'wrong' })).status, 401);
    assert.strictEqual((await post(PORT, 'tools/list', {}, { key: '', rawHeaders: {} })).status, 401);
    assert.strictEqual((await post(PORT, 'tools/list', {}, { rawHeaders: { Authorization: 'Basic abc' } })).status, 401);
    assert.strictEqual((await post(PORT, 'tools/list', {}, { rawHeaders: { 'x-api-key': '' } })).status, 401);
    const okHeader = await post(PORT, 'tools/list', {}, { rawHeaders: { 'x-api-key': KEY } });
    assert.strictEqual(okHeader.status, 200);
  });

  // 3. DISCOVER
  await t.test('DISCOVER: tools/list returns 60 tools', async () => {
    const r = await post(PORT, 'tools/list', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.result.tools.length, 60);
  });

  // 4. PING
  await t.test('PING: bridge_ping returns real token', async () => {
    const r = await call(PORT, 'bridge_ping', { agentId: AGENT });
    assert.ok(!r.isError);
    assert.ok(r.text.includes(CONFIG.RESPONSE_TOKEN));
  });

  // 5. CREATE -> READ -> COMMAND -> DELETE
  await t.test('FILE+CMD: create, read, execute, delete round trip', async () => {
    const c = await call(PORT, 'bridge_create_file', { filePath: created, content: 'e2e line 1\ne2e line 2', agentId: AGENT });
    assert.ok(!c.isError, c.text);
    assert.ok(fs.existsSync(created));

    const r = await call(PORT, 'bridge_read_file', { filePath: created, agentId: AGENT });
    assert.ok(!r.isError, r.text);
    assert.ok(JSON.parse(r.text).content.includes('e2e line 1'));

    const cmd = await call(PORT, 'bridge_execute_command', { commandLine: 'echo e2e_cmd_ok', cwd: WS, agentId: AGENT });
    assert.ok(!cmd.isError, cmd.text);
    assert.ok(cmd.text.includes('e2e_cmd_ok'));

    const del = await call(PORT, 'bridge_delete_file', { filePath: created, agentId: AGENT });
    assert.ok(!del.isError, del.text);
    assert.strictEqual(fs.existsSync(created), false);
  });

  // 6. MULTIPLE SEQUENTIAL
  await t.test('MULTI: 20 sequential pings remain correct', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await call(PORT, 'bridge_ping', { agentId: AGENT }, { id: 200 + i });
      assert.strictEqual(r.json.id, 200 + i);
      assert.ok(r.text.includes(CONFIG.RESPONSE_TOKEN));
    }
  });

  // 7. CONCURRENT
  await t.test('CONCURRENT: 50 parallel calls preserve correlation', async () => {
    const calls = Array.from({ length: 50 }, (_, i) => call(PORT, 'bridge_ping', { agentId: AGENT }, { id: 1000 + i }));
    const results = await Promise.all(calls);
    results.forEach((r, i) => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.id, 1000 + i);
      assert.ok(r.text.includes(CONFIG.RESPONSE_TOKEN));
    });
  });

  // 8. STOP -> verify failure -> RESTART -> reconnect
  await t.test('RECOVERY: stop fails clearly, restart reconnects', async () => {
    await server.stop();
    await assert.rejects(() => fetch(`http://127.0.0.1:${PORT}/health`, { headers: { Authorization: `Bearer ${KEY}` } }));

    await server.start();
    const r = await call(PORT, 'bridge_ping', { agentId: AGENT });
    assert.ok(!r.isError);
    assert.ok(r.text.includes(CONFIG.RESPONSE_TOKEN));
  });
});
