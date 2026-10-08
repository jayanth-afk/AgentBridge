import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { CONFIG } from '../src/config.js';
import { WorkspaceManager, IntegrationStatus } from '../src/workspaces/workspace-manager.js';

test('WorkspaceManager & IntegrationQueue Safety', async (t) => {
  const db = new DatabaseSync(':memory:');
  const mockLogger = { db, log: () => {} };

  // Setup a temporary git repository for testing worktree creation
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ab_test_repo_'));
  const tempWorktrees = fs.mkdtempSync(path.join(os.tmpdir(), 'ab_test_worktrees_'));

  const mockGit = {
    _execGit: async (repo, args) => {
      // Return simulated git responses
      if (args[0] === 'worktree' && args[1] === 'add') {
        fs.mkdirSync(args[4], { recursive: true });
        return { stdout: `Preparing worktree ${args[4]}` };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        try { fs.rmSync(args[3], { recursive: true, force: true }); } catch {}
        return { stdout: 'Removed' };
      }
      if (args[0] === 'merge-tree') {
        if (args.includes('conflict_branch')) {
          const err = new Error('CONFLICT (content): Merge conflict in file.js');
          throw err;
        }
        return { stdout: 'tree_hash_123' };
      }
      if (args[0] === 'merge') {
        return { stdout: 'Merge complete' };
      }
      return { stdout: '' };
    }
  };

  const wsManager = new WorkspaceManager({
    gitController: mockGit,
    auditLogger: mockLogger,
    worktreesRoot: tempWorktrees,
    protectedProjects: [CONFIG.ZIA_ROOT || '/Users/jayanthpranaykonada/Zia']
  });

  t.after(() => {
    try { fs.rmSync(tempRepo, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempWorktrees, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Protected Project Detection (Zia Protection Invariant)', () => {
    assert.equal(wsManager.isProtectedProject('/Users/jayanthpranaykonada/Zia'), true);
    assert.equal(wsManager.isProtectedProject('/Users/jayanthpranaykonada/Zia/src/core.js'), true);
    assert.equal(wsManager.isProtectedProject('/Users/jayanthpranaykonada/unrelated'), false);
  });

  await t.test('2. Worktree Creation for Attempt Isolation', async () => {
    const res = await wsManager.createAttemptWorktree({
      repoPath: tempRepo,
      taskId: 'task_wt_1',
      attemptId: 'att_wt_1',
      baseCommit: 'main'
    });

    assert.ok(res.worktreePath);
    assert.equal(res.branchName, 'bridge/task_wt_1/att_wt_1');
    assert.ok(fs.existsSync(res.worktreePath));

    // Remove worktree cleanly
    const rm = await wsManager.removeAttemptWorktree({
      repoPath: tempRepo,
      worktreePath: res.worktreePath
    });
    assert.equal(rm.removed, true);
  });

  await t.test('3. Enqueue Integration automatically requires human approval on protected projects', () => {
    const item = wsManager.enqueueIntegration({
      projectPath: '/Users/jayanthpranaykonada/Zia',
      taskId: 'task_zia',
      attemptId: 'att_zia',
      sourceBranch: 'bridge/task_zia/att_zia',
      targetBranch: 'main'
    });

    assert.equal(item.status, IntegrationStatus.QUEUED);
    assert.equal(item.requiresHumanApproval, true);
    assert.equal(item.isProtectedProject, true);
  });

  await t.test('4. Integration item requires approval before merging protected branch', async () => {
    const item = wsManager.enqueueIntegration({
      projectPath: '/Users/jayanthpranaykonada/Zia',
      taskId: 'task_zia_appr',
      attemptId: 'att_zia_appr',
      sourceBranch: 'bridge/clean_branch',
      targetBranch: 'main'
    });

    const result = await wsManager.processIntegrationItem(item.itemId, { approvedByHuman: false });
    assert.equal(result.status, IntegrationStatus.NEEDS_APPROVAL);
    assert.equal(result.requiresApproval, true);

    // Now approve it
    const approved = await wsManager.processIntegrationItem(item.itemId, { approvedByHuman: true });
    assert.equal(approved.status, IntegrationStatus.MERGED);
  });

  await t.test('5. Merge Conflict enters NEEDS_RESOLUTION status', async () => {
    const item = wsManager.enqueueIntegration({
      projectPath: tempRepo,
      taskId: 'task_conflict',
      attemptId: 'att_conflict',
      sourceBranch: 'conflict_branch',
      targetBranch: 'main',
      requiresApproval: false
    });

    const result = await wsManager.processIntegrationItem(item.itemId);
    assert.equal(result.status, IntegrationStatus.CONFLICT);
    assert.ok(result.error.includes('Merge conflict'));
  });
});
