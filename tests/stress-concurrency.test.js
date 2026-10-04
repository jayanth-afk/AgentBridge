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

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_stress.sqlite');
const WS = CONFIG.TEST_WORKSPACE;
const PORT = 8996;
const AGENT = 'claude-desktop';

function rmDb() {
  for (const s of ['', '-wal', '-shm']) {
    const p = `${TEST_DB}${s}`;
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
  }
}

async function call(method, params, id) {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  const json = await res.json();
  const result = json.result || {};
  const text = result.content ? result.content.map(c => c.text).join('\n') : JSON.stringify(result);
  return { id: json.id, isError: result.isError === true, text };
}

test('Concurrency & resource stress', async (t) => {
  rmDb();
  if (!fs.existsSync(WS)) fs.mkdirSync(WS, { recursive: true });
  const logger = new AuditLogger(TEST_DB);
  const guard = new PermissionGuard(CONFIG);
  const controller = new ProjectController(guard, logger);
  const server = new BridgeHttpServer({
    port: PORT, host: '127.0.0.1',
    auditLogger: logger, permissionGuard: guard,
    mailboxHub: new MailboxHub(logger), projectController: controller
  });
  await server.start();
  t.after(async () => {
    try { await server.stop(); } catch {}
    try { logger.close(); } catch {}
    rmDb();
  });

  await t.test('100 sequential pings stay correct and low-latency', async () => {
    const lat = [];
    for (let i = 0; i < 100; i++) {
      const t0 = Date.now();
      const r = await call('tools/call', { name: 'bridge_ping', arguments: { agentId: AGENT } }, i);
      lat.push(Date.now() - t0);
      assert.strictEqual(r.id, i);
      assert.ok(r.text.includes(CONFIG.RESPONSE_TOKEN));
    }
    lat.sort((a, b) => a - b);
    const p95 = lat[Math.floor(lat.length * 0.95)];
    assert.ok(p95 < 250, `p95 latency ${p95}ms too high (progressive degradation?)`);
  });

  await t.test('100 concurrent mixed calls preserve correlation', async () => {
    const tasks = [];
    for (let i = 0; i < 100; i++) {
      const id = 5000 + i;
      if (i % 3 === 0) tasks.push(call('tools/call', { name: 'bridge_ping', arguments: { agentId: AGENT } }, id));
      else if (i % 3 === 1) tasks.push(call('tools/call', { name: 'bridge_batch_stat', arguments: { paths: [CONFIG.BRIDGE_ROOT], agentId: AGENT } }, id));
      else tasks.push(call('tools/list', {}, id));
    }
    const results = await Promise.all(tasks);
    results.forEach((r, i) => {
      assert.strictEqual(r.id, 5000 + i, `id mismatch at ${i}`);
      assert.strictEqual(r.isError, false, `unexpected error at ${i}: ${r.text}`);
    });
  });

  await t.test('memory does not grow unbounded across the workload', () => {
    const heapMb = process.memoryUsage().heapUsed / 1024 / 1024;
    assert.ok(heapMb < 400, `heap ${Math.round(heapMb)}MB suggests a leak`);
  });
});
