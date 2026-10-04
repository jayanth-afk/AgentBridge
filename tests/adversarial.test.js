import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { CONFIG } from '../src/config.js';
import { resolveConfigValue } from '../src/config-resolver.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { ProjectController } from '../src/project-controller.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { BridgeHttpServer } from '../src/http-server.js';
import { ToolRegistry } from '../src/tool-registry.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_adversarial.sqlite');
const TEST_WORKSPACE = CONFIG.TEST_WORKSPACE;
const PORT = 8997;

function removeDb() {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = `${TEST_DB}${suffix}`;
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
  }
}

function freshController() {
  const logger = new AuditLogger(TEST_DB);
  const guard = new PermissionGuard(CONFIG);
  const controller = new ProjectController(guard, logger);
  return { logger, guard, controller };
}

function buildServer(overrides = {}) {
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
    ...overrides
  });
  return { server, logger };
}

async function rpc(port, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

test('Agent Bridge Adversarial & Security Suite', async (t) => {
  removeDb();
  if (!fs.existsSync(TEST_WORKSPACE)) fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

  // ---------------------------------------------------------------------------
  // Configuration resolution (env: references must fail loudly, never silently)
  // ---------------------------------------------------------------------------
  await t.test('CONFIG: env reference resolves when set', () => {
    process.env.AB_ADV_SECRET = 'resolved-secret';
    try {
      assert.strictEqual(resolveConfigValue('env:AB_ADV_SECRET', { name: 'k' }), 'resolved-secret');
    } finally {
      delete process.env.AB_ADV_SECRET;
    }
  });

  await t.test('CONFIG: missing env reference throws deterministically (no empty key)', () => {
    delete process.env.AB_ADV_MISSING;
    assert.throws(
      () => resolveConfigValue('env:AB_ADV_MISSING', { name: 'control_plane.api_key' }),
      /AB_ADV_MISSING.*not set or is empty/
    );
  });

  await t.test('CONFIG: empty env reference throws rather than disabling auth', () => {
    process.env.AB_ADV_EMPTY = '';
    try {
      assert.throws(() => resolveConfigValue('env:AB_ADV_EMPTY', { name: 'k' }), /not set or is empty/);
    } finally {
      delete process.env.AB_ADV_EMPTY;
    }
  });

  await t.test('CONFIG: literal passes through; bare env: is rejected', () => {
    assert.strictEqual(resolveConfigValue('literal-key', { name: 'k' }), 'literal-key');
    assert.throws(() => resolveConfigValue('env:', { name: 'k' }), /missing a variable name/);
    assert.throws(() => resolveConfigValue(undefined, { name: 'k', required: true }), /Missing required configuration/);
  });

  // ---------------------------------------------------------------------------
  // Filesystem sandbox: traversal + symlink escapes
  // ---------------------------------------------------------------------------
  await t.test('FS: lexical traversal outside roots is denied', () => {
    const { logger, guard } = freshController();
    try {
      const traversal = path.join(TEST_WORKSPACE, '..', '..', '..', 'etc', 'passwd');
      assert.strictEqual(guard.validatePathAccess(traversal, 'READ').allowed, false);
      assert.strictEqual(guard.validatePathAccess('/etc/passwd', 'READ').allowed, false);
    } finally {
      logger.close();
    }
  });

  await t.test('FS: symlink to a file outside roots is denied', async () => {
    const { logger, guard, controller } = freshController();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-outside-'));
    const secret = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(secret, 'TOP SECRET');
    const link = path.join(TEST_WORKSPACE, 'adv_symlink_file.txt');
    try {
      fs.symlinkSync(secret, link);
      const check = guard.validatePathAccess(link, 'READ');
      assert.strictEqual(check.allowed, false, 'symlink escape must be denied');
      await assert.rejects(() => controller.readFile(link, 'claude-desktop'), /outside allowed roots|resolves to/);
    } finally {
      try { fs.unlinkSync(link); } catch {}
      fs.rmSync(outsideDir, { recursive: true, force: true });
      logger.close();
    }
  });

  await t.test('FS: symlinked directory escape is denied for writes', async () => {
    const { logger, guard } = freshController();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-outdir-'));
    const linkDir = path.join(TEST_WORKSPACE, 'adv_symlink_dir');
    try {
      fs.symlinkSync(outsideDir, linkDir, 'dir');
      const target = path.join(linkDir, 'pwn.txt');
      const check = guard.validatePathAccess(target, 'CREATE');
      assert.strictEqual(check.allowed, false, 'write through symlinked dir must be denied');
    } finally {
      try { fs.unlinkSync(linkDir); } catch {}
      fs.rmSync(outsideDir, { recursive: true, force: true });
      logger.close();
    }
  });

  await t.test('FS: dangling symlink targeting outside root is denied', async () => {
    const { logger, guard } = freshController();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-dangle-'));
    const link = path.join(TEST_WORKSPACE, 'adv_dangling.txt');
    try {
      fs.symlinkSync(path.join(outsideDir, 'never-created.txt'), link);
      assert.strictEqual(guard.validatePathAccess(link, 'CREATE').allowed, false);
    } finally {
      try { fs.unlinkSync(link); } catch {}
      fs.rmSync(outsideDir, { recursive: true, force: true });
      logger.close();
    }
  });

  await t.test('FS: valid in-root path is allowed', () => {
    const { logger, guard } = freshController();
    try {
      assert.strictEqual(guard.validatePathAccess(path.join(TEST_WORKSPACE, 'ok.txt'), 'CREATE').allowed, true);
    } finally {
      logger.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Error propagation: failures must never be shaped as success
  // ---------------------------------------------------------------------------
  await t.test('ERR: non-zero command exit is surfaced as an error result', async () => {
    const { logger, controller } = freshController();
    try {
      const res = await controller.executeCommand('node -e "process.exit(3)"', TEST_WORKSPACE, 'claude-desktop');
      assert.strictEqual(res.exitCode, 3);
      assert.strictEqual(res.isError, true);
      assert.strictEqual(res.timedOut, false);
    } finally {
      logger.close();
    }
  });

  await t.test('ERR: command timeout is surfaced clearly (not success)', async () => {
    const { logger, controller } = freshController();
    try {
      const res = await controller.executeCommand(
        'node -e "setTimeout(()=>{}, 5000)"',
        TEST_WORKSPACE,
        'claude-desktop',
        400
      );
      assert.strictEqual(res.timedOut, true);
      assert.strictEqual(res.isError, true);
      assert.match(res.error, /timed out/i);
    } finally {
      logger.close();
    }
  });

  await t.test('ERR: permission denial throws instead of returning success', async () => {
    const { logger, guard, controller } = freshController();
    try {
      assert.strictEqual(guard.checkPermission('malicious-bot', 'READ').allowed, false);
      await assert.rejects(() => controller.readFile(path.join(TEST_WORKSPACE, 'x.txt'), 'malicious-bot'), /Unknown agent identity/);
    } finally {
      logger.close();
    }
  });

  await t.test('TOOLS: unknown tool is rejected', async () => {
    const registry = new ToolRegistry();
    await assert.rejects(() => registry.executeTool('does_not_exist', {}, {}), /Unknown tool/);
  });

  // ---------------------------------------------------------------------------
  // Live HTTP control plane lifecycle, auth, concurrency, recovery
  // ---------------------------------------------------------------------------
  const { server, logger } = buildServer();
  await server.start();
  t.after(async () => {
    try { await server.stop(); } catch {}
    try { logger.close(); } catch {}
  });

  await t.test('HTTP: health reports readiness without secrets', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'healthy');
    assert.strictEqual(body.authEnabled, false);
    assert.ok(Array.isArray(body.allowedRoots));
  });

  await t.test('HTTP: bridge_ping reaches the real server and returns the token', async () => {
    const { status, json } = await rpc(PORT, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'bridge_ping', arguments: { agentId: 'claude-desktop' } }
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(json.id, 1);
    assert.ok(json.result.content[0].text.includes(CONFIG.RESPONSE_TOKEN));
    assert.ok(!json.result.isError);
  });

  await t.test('HTTP: repeated pings stay correct (no progressive corruption)', async () => {
    for (let i = 0; i < 15; i++) {
      const { json } = await rpc(PORT, {
        jsonrpc: '2.0', id: i + 100, method: 'tools/call',
        params: { name: 'bridge_ping', arguments: { agentId: 'chatgpt-desktop' } }
      });
      assert.strictEqual(json.id, i + 100);
      assert.ok(json.result.content[0].text.includes(CONFIG.RESPONSE_TOKEN));
    }
  });

  await t.test('HTTP: concurrent requests preserve request/response correlation', async () => {
    const calls = Array.from({ length: 24 }, (_, i) => rpc(PORT, {
      jsonrpc: '2.0', id: 1000 + i, method: 'tools/call',
      params: { name: 'bridge_ping', arguments: { agentId: i % 2 ? 'claude-desktop' : 'chatgpt-desktop' } }
    }));
    const results = await Promise.all(calls);
    results.forEach((r, i) => {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.id, 1000 + i, `response id must match request id at index ${i}`);
      const payload = JSON.parse(r.json.result.content[0].text);
      const expected = i % 2 ? 'claude-desktop' : 'chatgpt-desktop';
      assert.strictEqual(payload.caller, expected);
    });
  });

  await t.test('HTTP: unknown tool fails safely (isError, no hang)', async () => {
    const { status, json } = await rpc(PORT, {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'nope_tool', arguments: {} }
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(json.result.isError, true);
    assert.match(json.result.content[0].text, /Unknown tool/);
  });

  await t.test('HTTP: missing required argument fails safely', async () => {
    const { json } = await rpc(PORT, {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'bridge_read_file', arguments: { agentId: 'claude-desktop' } }
    });
    assert.strictEqual(json.result.isError, true);
  });

  await t.test('HTTP: malformed JSON returns 400 rather than hanging or 500', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ this is not json'
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Malformed JSON/);
  });

  await t.test('HTTP: stop makes requests fail clearly; restart recovers', async () => {
    await server.stop();
    await assert.rejects(() => fetch(`http://127.0.0.1:${PORT}/health`));

    await server.start();
    const { status, json } = await rpc(PORT, {
      jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: { name: 'bridge_ping', arguments: { agentId: 'claude-desktop' } }
    });
    assert.strictEqual(status, 200);
    assert.ok(json.result.content[0].text.includes(CONFIG.RESPONSE_TOKEN));
  });

  // ---------------------------------------------------------------------------
  // Authentication boundary
  // ---------------------------------------------------------------------------
  await t.test('AUTH: key configured -> missing/wrong rejected, correct accepted', async () => {
    const { server: authServer, logger: authLogger } = buildServer({
      port: PORT + 1,
      apiKey: 'adv-test-key',
      requireApiKey: true
    });
    await authServer.start();
    try {
      const noKey = await rpc(PORT + 1, {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'bridge_ping', arguments: { agentId: 'claude-desktop' } }
      });
      assert.strictEqual(noKey.status, 401);

      const wrongKey = await rpc(PORT + 1, {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'bridge_ping', arguments: { agentId: 'claude-desktop' } }
      }, { Authorization: 'Bearer wrong-key' });
      assert.strictEqual(wrongKey.status, 401);

      const ok = await rpc(PORT + 1, {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'bridge_ping', arguments: { agentId: 'claude-desktop' } }
      }, { Authorization: 'Bearer adv-test-key' });
      assert.strictEqual(ok.status, 200);
      assert.ok(ok.json.result.content[0].text.includes(CONFIG.RESPONSE_TOKEN));

      const okHeader = await rpc(PORT + 1, {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'bridge_ping', arguments: { agentId: 'claude-desktop' } }
      }, { 'x-api-key': 'adv-test-key' });
      assert.strictEqual(okHeader.status, 200);
    } finally {
      await authServer.stop();
      authLogger.close();
    }
  });

  await t.test('AUTH: requireApiKey without a key refuses to start', async () => {
    const { server: badServer, logger: badLogger } = buildServer({
      port: PORT + 2,
      apiKey: null,
      requireApiKey: true
    });
    try {
      await assert.rejects(() => badServer.start(), /Authentication required but no control_plane\.api_key/);
    } finally {
      badLogger.close();
    }
  });

  removeDb();
});
