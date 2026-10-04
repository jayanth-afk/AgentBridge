import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { ProjectController } from '../src/project-controller.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_fs_sec.sqlite');
const WS = CONFIG.TEST_WORKSPACE;
const AGENT = 'claude-desktop';

test('Filesystem sandbox adversarial audit', async (t) => {
  if (!fs.existsSync(WS)) fs.mkdirSync(WS, { recursive: true });
  const logger = new AuditLogger(TEST_DB);
  const controller = new ProjectController(new PermissionGuard(CONFIG), logger);

  // Narrow root so containment and traversal are actually observable
  // (the production config intentionally also allows the whole home dir).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-fs-root-'));
  const narrow = new PermissionGuard({ ...CONFIG, ALLOWED_ROOTS: [root] });
  const realRoot = fs.realpathSync(root);

  t.after(() => {
    try { logger.close(); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  await t.test('sibling prefix (/X vs /X-evil) is not confused', () => {
    const evil = `${root}-evil`;
    assert.strictEqual(narrow.validatePathAccess(path.join(evil, 'secret.txt'), 'READ').allowed, false);
    assert.strictEqual(narrow.validatePathAccess(evil, 'READ').allowed, false);
    assert.strictEqual(narrow.validatePathAccess(path.join(root, 'ok.txt'), 'WRITE').allowed, true);
  });

  await t.test('dot-segment and absolute traversal variants are denied', () => {
    const variants = [
      path.join(root, '..', '..', '..', 'etc', 'passwd'),
      '/etc/passwd',
      path.join(root, 'sub', '..', '..', '..', 'etc', 'hosts')
    ];
    for (const v of variants) {
      assert.strictEqual(narrow.validatePathAccess(v, 'READ').allowed, false, `must deny: ${v}`);
    }
  });

  await t.test('leading-space path never resolves to an outside absolute path', () => {
    const res = narrow.validatePathAccess('   /etc/passwd', 'READ');
    if (res.allowed) {
      assert.ok(res.path.startsWith(realRoot), 'must stay under the narrow root');
      assert.notStrictEqual(res.path, '/etc/passwd');
    }
  });

  await t.test('percent-encoded traversal does not escape (treated literally)', () => {
    const weird = path.join(root, '%2e%2e/%2e%2e/etc/passwd');
    const res = narrow.validatePathAccess(weird, 'READ');
    if (res.allowed) {
      assert.ok(res.path.startsWith(realRoot), 'resolved path must stay in root');
    }
  });

  await t.test('symlink to outside the narrow root is denied', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-out-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    const link = path.join(root, 'link_out.txt');
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), link);
      assert.strictEqual(narrow.validatePathAccess(link, 'READ').allowed, false);
    } finally {
      try { fs.unlinkSync(link); } catch {}
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  await t.test('authorized result path is the symlink-resolved real path', () => {
    const real = path.join(WS, 'fs_real_target.txt');
    fs.writeFileSync(real, 'real');
    const link = path.join(WS, 'fs_link.txt');
    try { fs.unlinkSync(link); } catch {}
    fs.symlinkSync(real, link);
    const res = new PermissionGuard(CONFIG).validatePathAccess(link, 'READ');
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.path, fs.realpathSync(real), 'must authorize the real target, not the link');
    try { fs.unlinkSync(link); fs.unlinkSync(real); } catch {}
  });

  await t.test('symlink chain escaping the root is denied', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-chain-'));
    const secret = path.join(outside, 'chain_secret.txt');
    fs.writeFileSync(secret, 'secret');
    const mid = path.join(root, 'chain_mid');
    const end = path.join(root, 'chain_end');
    try {
      fs.symlinkSync(secret, mid);
      fs.symlinkSync(mid, end);
      assert.strictEqual(narrow.validatePathAccess(end, 'READ').allowed, false);
      assert.strictEqual(narrow.validatePathAccess(mid, 'READ').allowed, false);
    } finally {
      try { fs.unlinkSync(end); } catch {}
      try { fs.unlinkSync(mid); } catch {}
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  await t.test('controller rejects a symlink-swapped write target', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-swap-'));
    const link = path.join(WS, 'fs_swap.txt');
    try {
      fs.symlinkSync(path.join(outside, 'pwn.txt'), link);
      await assert.rejects(() => controller.createFile(link, AGENT, 'x'), /outside allowed roots|resolves to/);
      assert.strictEqual(fs.existsSync(path.join(outside, 'pwn.txt')), false);
    } finally {
      try { fs.unlinkSync(link); } catch {}
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  await t.test('symlink loop is denied, not fatal', () => {
    const a = path.join(root, 'loop_a');
    const b = path.join(root, 'loop_b');
    try {
      fs.symlinkSync(b, a);
      fs.symlinkSync(a, b);
      const res = narrow.validatePathAccess(a, 'READ');
      assert.strictEqual(res.allowed, false);
    } finally {
      try { fs.unlinkSync(a); } catch {}
      try { fs.unlinkSync(b); } catch {}
    }
  });
});
