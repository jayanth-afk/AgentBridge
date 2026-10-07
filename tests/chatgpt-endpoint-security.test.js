import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { ProjectController } from '../src/project-controller.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { BridgeHttpServer } from '../src/http-server.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_chatgpt_security.sqlite');
const PORT = 8996;
const KEY = 'chatgpt-brain-test-key';

function removeDb() {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = `${TEST_DB}${suffix}`;
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
  }
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

function fakeReq({ remoteAddress = '127.0.0.1', host = `127.0.0.1:${PORT}`, origin, key, authorization } = {}) {
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  if (key !== undefined) headers['x-api-key'] = key;
  if (authorization !== undefined) headers.authorization = authorization;
  return { socket: { remoteAddress }, headers };
}

function fakeRes() {
  return {
    headersSent: false,
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code; },
    end(body) { if (body !== undefined) this.body = body; this.headersSent = true; }
  };
}

function rawRequest({ port = PORT, path: reqPath, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// C1: the ChatGPT brain endpoints can invoke the user's own authenticated
// ChatGPT, so they enforce a stricter boundary than the general control plane:
// loopback-only, no browser Origin, validated Host, and a mandatory API key.
test('ChatGPT brain endpoint security boundary', async (t) => {
  removeDb();

  await t.test('guard: non-loopback client rejected (403)', () => {
    const { server } = buildServer({ apiKey: KEY });
    const res = fakeRes();
    assert.strictEqual(server.guardChatGPTRequest(fakeReq({ remoteAddress: '10.0.0.5', key: KEY }), res), false);
    assert.strictEqual(res.statusCode, 403);
  });

  await t.test('guard: browser Origin rejected (403)', () => {
    const { server } = buildServer({ apiKey: KEY });
    const res = fakeRes();
    assert.strictEqual(server.guardChatGPTRequest(fakeReq({ origin: 'https://evil.example', key: KEY }), res), false);
    assert.strictEqual(res.statusCode, 403);
  });

  await t.test('guard: non-loopback Host rejected (403)', () => {
    const { server } = buildServer({ apiKey: KEY });
    const res = fakeRes();
    assert.strictEqual(server.guardChatGPTRequest(fakeReq({ host: 'evil.example', key: KEY }), res), false);
    assert.strictEqual(res.statusCode, 403);
  });

  await t.test('guard: no configured key fails closed (503)', () => {
    const { server } = buildServer({ apiKey: null });
    const res = fakeRes();
    assert.strictEqual(server.guardChatGPTRequest(fakeReq({ key: 'anything' }), res), false);
    assert.strictEqual(res.statusCode, 503);
  });

  await t.test('guard: missing or wrong key rejected (401)', () => {
    const { server } = buildServer({ apiKey: KEY });
    let res = fakeRes();
    assert.strictEqual(server.guardChatGPTRequest(fakeReq(), res), false);
    assert.strictEqual(res.statusCode, 401);
    res = fakeRes();
    assert.strictEqual(server.guardChatGPTRequest(fakeReq({ key: 'wrong' }), res), false);
    assert.strictEqual(res.statusCode, 401);
  });

  await t.test('guard: correct key on loopback passes without writing a response', () => {
    const { server } = buildServer({ apiKey: KEY });
    const res = fakeRes();
    assert.strictEqual(server.guardChatGPTRequest(fakeReq({ key: KEY }), res), true);
    assert.strictEqual(res.statusCode, null);

    // Bearer form is accepted too.
    const bearer = fakeReq({ authorization: `Bearer ${KEY}` });
    assert.strictEqual(server.guardChatGPTRequest(bearer, fakeRes()), true);
  });

  // HTTP-level: every rejection happens BEFORE the brain handler runs, so no
  // ChatGPT process is ever spawned by these requests.
  await t.test('HTTP: rejections precede the brain handler', async (tHttp) => {
    const { server, logger } = buildServer({ apiKey: KEY });
    await server.start();
    tHttp.after(async () => {
      try { await server.stop(); } catch {}
      try { logger.close(); } catch {}
    });

    const jsonHeaders = { 'Content-Type': 'application/json' };
    const payload = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });

    const noKey = await rawRequest({ path: '/api/chatgpt/complete', method: 'POST', headers: jsonHeaders, body: payload });
    assert.strictEqual(noKey.status, 401);

    const originRejected = await rawRequest({
      path: '/api/chatgpt/health',
      headers: { Origin: 'https://evil.example', 'x-api-key': KEY }
    });
    assert.strictEqual(originRejected.status, 403);

    const healthNoKey = await rawRequest({ path: '/api/chatgpt/health' });
    assert.strictEqual(healthNoKey.status, 401);

    const badHost = await rawRequest({ path: '/api/chatgpt/health', headers: { Host: 'evil.example', 'x-api-key': KEY } });
    assert.strictEqual(badHost.status, 403);
  });

  await t.test('HTTP: no configured key -> 503 (fail closed)', async (tHttp) => {
    const { server, logger } = buildServer({ apiKey: null, port: PORT + 1 });
    await server.start();
    tHttp.after(async () => {
      try { await server.stop(); } catch {}
      try { logger.close(); } catch {}
    });
    const res = await rawRequest({
      port: PORT + 1,
      path: '/api/chatgpt/complete',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.strictEqual(res.status, 503);
  });

  removeDb();
});
