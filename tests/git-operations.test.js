import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { GitController } from '../src/git-controller.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_git.sqlite');

test('Structured Git Operations & Push Safeguards Suite', async (t) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const logger = new AuditLogger(TEST_DB);
  const guard = new PermissionGuard();
  const git = new GitController(guard, logger);

  t.after(() => {
    try {
      if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    } catch {}
  });

  await t.test('1. Git Status & Current Branch', async () => {
    const status = await git.getStatus(CONFIG.BRIDGE_ROOT, 'antigravity-ide');
    assert.ok(status.branch);
    assert.strictEqual(status.repoPath, CONFIG.BRIDGE_ROOT);
    assert.strictEqual(typeof status.isClean, 'boolean');
  });

  await t.test('2. Git Branches List', async () => {
    const branches = await git.getBranches(CONFIG.BRIDGE_ROOT, 'antigravity-ide');
    assert.ok(branches.currentBranch);
    assert.ok(Array.isArray(branches.localBranches));
    assert.ok(branches.localBranches.some(b => b.name === branches.currentBranch));
  });

  await t.test('3. Branch Creation with Validation', async () => {
    const testBranch = `test-branch-${Date.now()}`;
    const res = await git.createBranch(CONFIG.BRIDGE_ROOT, 'antigravity-ide', testBranch);
    assert.strictEqual(res.created, true);
    assert.strictEqual(res.branch, testBranch);

    // Clean up test branch
    try {
      await git._execGit(CONFIG.BRIDGE_ROOT, ['branch', '-D', testBranch]);
    } catch {}

    // Verify invalid branch name is rejected
    await assert.rejects(async () => {
      await git.createBranch(CONFIG.BRIDGE_ROOT, 'antigravity-ide', 'bad..branch..name?*');
    }, /Invalid Git branch name/);
  });

  await t.test('4. Git Push Safeguards (Permission Guard & Explicit Confirmation)', async () => {
    // 1. Unprivileged agent push is gated by PermissionGuard
    await assert.rejects(async () => {
      await git.push(CONFIG.BRIDGE_ROOT, 'antigravity-ide', {
        remote: 'origin',
        branch: 'some-feature',
        explicitConfirmation: true
      });
    }, /requires 'PUSH' permission which is gated/);

    // 2. Authorized system agent without explicitConfirmation -> MUST be rejected
    await assert.rejects(async () => {
      await git.push(CONFIG.BRIDGE_ROOT, 'system', {
        remote: 'origin',
        branch: 'some-feature',
        explicitConfirmation: false
      });
    }, /GitPushBlocked: Push requires explicit authorization/);

    // 3. Attempt push to protected branch (main/master) without allowProtected -> MUST be rejected
    await assert.rejects(async () => {
      await git.push(CONFIG.BRIDGE_ROOT, 'system', {
        remote: 'origin',
        branch: 'main',
        explicitConfirmation: true,
        allowProtected: false
      });
    }, /GitPushBlocked: Pushing to protected branch 'main' is forbidden/);
  });
});
