import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { GitController } from '../src/git-controller.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_git.sqlite');

test('Autonomous Structured Git Operations & Validation Suite', async (t) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const logger = new AuditLogger(TEST_DB);
  const guard = new PermissionGuard();
  const git = new GitController(guard, logger);

  t.after(() => {
    try {
      if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    } catch {}
  });

  await t.test('1. Compact Git Status & Current Branch', async () => {
    const status = await git.getStatus(CONFIG.BRIDGE_ROOT, 'antigravity-ide', true);
    assert.ok(status.branch);
    assert.strictEqual(status.repoPath, CONFIG.BRIDGE_ROOT);
    assert.strictEqual(typeof status.isClean, 'boolean');
    assert.strictEqual(typeof status.staged, 'number');
    assert.strictEqual(typeof status.unstaged, 'number');
    assert.ok(Array.isArray(status.changedFiles));
  });

  await t.test('2. Compact Git Branches List', async () => {
    const branches = await git.getBranches(CONFIG.BRIDGE_ROOT, 'antigravity-ide', true);
    assert.ok(branches.current);
    assert.ok(Array.isArray(branches.branches));
    assert.ok(branches.branches.includes(branches.current));
  });

  await t.test('3. Branch Lifecycle: Creation, Switching & Deletion', async () => {
    const initialBranches = await git.getBranches(CONFIG.BRIDGE_ROOT, 'antigravity-ide', true);
    const originalBranch = initialBranches.current;
    const testBranch = `auto-branch-${Date.now()}`;
    // Create
    const resCreate = await git.createBranch(CONFIG.BRIDGE_ROOT, 'antigravity-ide', testBranch);
    assert.strictEqual(resCreate.success, true);
    assert.strictEqual(resCreate.branch, testBranch);

    // Switch
    const resSwitch = await git.switchBranch(CONFIG.BRIDGE_ROOT, 'antigravity-ide', testBranch);
    assert.strictEqual(resSwitch.success, true);
    assert.strictEqual(resSwitch.currentBranch, testBranch);

    // Switch back to original branch
    await git.switchBranch(CONFIG.BRIDGE_ROOT, 'antigravity-ide', originalBranch);

    // Delete
    const resDelete = await git.deleteBranch(CONFIG.BRIDGE_ROOT, 'antigravity-ide', testBranch, true);
    assert.strictEqual(resDelete.success, true);
    assert.strictEqual(resDelete.deleted, true);

    // Verify invalid branch name is rejected with concise error
    await assert.rejects(async () => {
      await git.createBranch(CONFIG.BRIDGE_ROOT, 'antigravity-ide', 'bad..branch..name?*');
    }, /Invalid Git branch name/);
  });

  await t.test('4. Staging, Committing, Log & Diff', async () => {
    const stageRepoPath = path.join(CONFIG.TEST_WORKSPACE, 'test-stage-repo');
    if (fs.existsSync(stageRepoPath)) fs.rmSync(stageRepoPath, { recursive: true, force: true });
    fs.mkdirSync(stageRepoPath, { recursive: true });

    await git._execGit(stageRepoPath, ['init', '-b', 'main']);
    await git._execGit(stageRepoPath, ['config', 'user.email', 'test@agent-bridge.local']);
    await git._execGit(stageRepoPath, ['config', 'user.name', 'Agent Bridge']);

    try {
      const testFile = path.join(stageRepoPath, 'git_test_stage.txt');
      fs.writeFileSync(testFile, 'Stage content ' + Date.now(), 'utf8');

      // Stage
      const stageRes = await git.stage(stageRepoPath, 'antigravity-ide', [testFile]);
      assert.strictEqual(stageRes.success, true);

      // Diff
      const diffRes = await git.getDiff(stageRepoPath, 'antigravity-ide', true, 10);
      assert.ok(diffRes.staged);

      // Commit
      const commitRes = await git.commit(stageRepoPath, 'antigravity-ide', 'test: autonomous git stage & commit');
      assert.strictEqual(commitRes.success, true);
      assert.ok(commitRes.commit);
      assert.ok(commitRes.branch);

      // Git arguments must never be interpreted by a shell.
      const markerFile = path.join(stageRepoPath, 'shell-injection-marker.txt');
      const hostileMessage = `test $(touch ${markerFile}) && echo hostile`;
      const secondFile = path.join(stageRepoPath, 'second.txt');
      fs.writeFileSync(secondFile, 'second', 'utf8');
      const hostileCommit = await git.commit(stageRepoPath, 'antigravity-ide', hostileMessage, [secondFile]);
      assert.strictEqual(hostileCommit.success, true);
      assert.strictEqual(fs.existsSync(markerFile), false);

      // Log
      const logRes = await git.getLog(stageRepoPath, 'antigravity-ide', 5);
      assert.ok(logRes.commits.length > 0);
      assert.strictEqual(logRes.commits[0].hash, hostileCommit.commit);
    } finally {
      fs.rmSync(stageRepoPath, { recursive: true, force: true });
    }
  });

  await t.test('5. Machine-Level Validations (Repository, Remote, Branch)', async () => {
    // 1. Invalid Repository Validation
    const invalidDir = path.join(CONFIG.TEST_WORKSPACE, 'not-a-git-repo');
    if (!fs.existsSync(invalidDir)) fs.mkdirSync(invalidDir, { recursive: true });
    try {
      await assert.rejects(async () => {
        await git.push(invalidDir, 'antigravity-ide', { remote: 'origin', branch: 'test' });
      }, /InvalidGitRepository/);
    } finally {
      try { fs.rmdirSync(invalidDir); } catch {}
    }

    // 2. Invalid Remote Validation. Use the active branch so this
    // validation remains valid after feature branches are merged/deleted.
    const activeBranchForValidation = (await git.getBranches(CONFIG.BRIDGE_ROOT, 'antigravity-ide', true)).current;
    await assert.rejects(async () => {
      await git.push(CONFIG.BRIDGE_ROOT, 'antigravity-ide', {
        remote: 'non-existent-remote-999',
        branch: activeBranchForValidation
      });
    }, /InvalidGitRemote/);

    // 3. Invalid Branch Validation
    await assert.rejects(async () => {
      await git.push(CONFIG.BRIDGE_ROOT, 'antigravity-ide', {
        remote: 'origin',
        branch: 'non-existent-local-branch-xyz'
      });
    }, /InvalidGitBranch/);
  });

  await t.test('6. Configurable Protected-Branch Policy (Deterministic, Non-Interactive)', async () => {
    const testRepo = path.join(CONFIG.TEST_WORKSPACE, 'test-push-repo-6');
    const bareRepo = path.join(CONFIG.TEST_WORKSPACE, 'bare-remote-6.git');
    if (fs.existsSync(testRepo)) fs.rmSync(testRepo, { recursive: true, force: true });
    if (fs.existsSync(bareRepo)) fs.rmSync(bareRepo, { recursive: true, force: true });
    fs.mkdirSync(testRepo, { recursive: true });
    fs.mkdirSync(bareRepo, { recursive: true });

    await git._execGit(bareRepo, ['init', '--bare']);
    await git._execGit(testRepo, ['init', '-b', 'master']);
    await git._execGit(testRepo, ['config', 'user.email', 'test@agent-bridge.local']);
    await git._execGit(testRepo, ['config', 'user.name', 'Agent Bridge']);
    fs.writeFileSync(path.join(testRepo, 'README.md'), 'initial', 'utf8');
    await git._execGit(testRepo, ['add', '.']);
    await git.commit(testRepo, 'antigravity-ide', 'initial commit');
    await git._execGit(testRepo, ['remote', 'add', 'test-bare-remote', bareRepo]);

    try {
      // 1. Pushing to protected branch 'master' without allowProtected when policy forbids -> concise policy block
      await assert.rejects(async () => {
        await git.push(testRepo, 'antigravity-ide', {
          remote: 'test-bare-remote',
          branch: 'master',
          allowProtected: false
        });
      }, /ProtectedBranchBlocked: Autonomous push to protected branch 'master' is disabled by policy/);

      // 2. Autonomous push to protected branch with allowProtected: true succeeds autonomously without prompt
      const protectedPush = await git.push(testRepo, 'antigravity-ide', {
        remote: 'test-bare-remote',
        branch: 'master',
        allowProtected: true,
        dryRun: true
      });
      assert.strictEqual(protectedPush.success, true);
      assert.strictEqual(protectedPush.branch, 'master');
      assert.strictEqual(protectedPush.remote, 'test-bare-remote');
      assert.ok(protectedPush.commit);
    } finally {
      fs.rmSync(testRepo, { recursive: true, force: true });
      fs.rmSync(bareRepo, { recursive: true, force: true });
    }
  });

  await t.test('7. Normal Autonomous Push with NO Confirmation & Full Audit Logging', async () => {
    const testRepo = path.join(CONFIG.TEST_WORKSPACE, 'test-push-repo-7');
    const bareRepo = path.join(CONFIG.TEST_WORKSPACE, 'bare-remote-7.git');
    if (fs.existsSync(testRepo)) fs.rmSync(testRepo, { recursive: true, force: true });
    if (fs.existsSync(bareRepo)) fs.rmSync(bareRepo, { recursive: true, force: true });
    fs.mkdirSync(testRepo, { recursive: true });
    fs.mkdirSync(bareRepo, { recursive: true });

    await git._execGit(bareRepo, ['init', '--bare']);
    await git._execGit(testRepo, ['init', '-b', 'feature/autonomous-sync']);
    await git._execGit(testRepo, ['config', 'user.email', 'test@agent-bridge.local']);
    await git._execGit(testRepo, ['config', 'user.name', 'Agent Bridge']);
    fs.writeFileSync(path.join(testRepo, 'feature.txt'), 'feature content', 'utf8');
    await git._execGit(testRepo, ['add', '.']);
    await git.commit(testRepo, 'antigravity-ide', 'feat: autonomous sync');
    await git._execGit(testRepo, ['remote', 'add', 'auto-remote', bareRepo]);

    try {
      // Autonomous push of feature branch 'feature/autonomous-sync' (NOT protected)
      // Notice: NO explicitConfirmation parameter is required or provided!
      const pushResult = await git.push(testRepo, 'antigravity-ide', {
        remote: 'auto-remote',
        branch: 'feature/autonomous-sync'
      });

      assert.strictEqual(pushResult.success, true);
      assert.strictEqual(pushResult.branch, 'feature/autonomous-sync');
      assert.strictEqual(pushResult.remote, 'auto-remote');
      assert.ok(pushResult.commit);

      // Verify Audit Logging
      const recentLogs = logger.getRecentLogs(10);
      const attemptLog = recentLogs.find(l => l.action === 'git_push_attempt');
      const successLog = recentLogs.find(l => l.action === 'git_push' && l.status === 'success');

      assert.ok(attemptLog, 'Push attempt must be recorded in audit log');
      assert.ok(successLog, 'Push success must be recorded in audit log');
      assert.strictEqual(successLog.agent_id, 'antigravity-ide');
    } finally {
      fs.rmSync(testRepo, { recursive: true, force: true });
      fs.rmSync(bareRepo, { recursive: true, force: true });
    }
  });
});
