import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';
import { AttemptLedger } from '../src/attempts/attempt-ledger.js';
import { WorkspaceManager, IntegrationStatus } from '../src/workspaces/workspace-manager.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { ProjectController } from '../src/project-controller.js';
import { EffectsLedger } from '../src/effects/effects-ledger.js';
import { CONFIG } from '../src/config.js';

test('Workspace Isolation & Worktree Invariants Suite', async (t) => {
  const tmpRoot = path.join(process.cwd(), 'tmp-ws-test-' + Date.now());
  const worktreesDir = path.join(tmpRoot, 'worktrees');
  const mockRepo = path.join(tmpRoot, 'repo');
  const protectedRepo = path.join(tmpRoot, 'protected-zia-mock');

  fs.mkdirSync(worktreesDir, { recursive: true });
  fs.mkdirSync(mockRepo, { recursive: true });
  fs.mkdirSync(protectedRepo, { recursive: true });

  const dbPath = path.join(tmpRoot, 'test.sqlite');
  const logger = new AuditLogger(dbPath);
  const attemptLedger = new AttemptLedger(logger);
  const taskManager = new TaskManager(logger, attemptLedger);
  const guard = new PermissionGuard({ ...CONFIG, ALLOWED_ROOTS: [tmpRoot] });
  const controller = new ProjectController(guard, logger);
  const effectsLedger = new EffectsLedger(logger);
  const registry = new ToolRegistry();

  const mockGit = {
    _execGit: async (repo, args) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        const targetDir = args[4];
        fs.mkdirSync(targetDir, { recursive: true });
        return { stdout: `Prepared worktree in ${targetDir}` };
      }
      if (args[0] === 'diff') {
        return { stdout: 'src/modified-file.js\npackage.json' };
      }
      return { stdout: '' };
    }
  };

  const wsManager = new WorkspaceManager({
    gitController: mockGit,
    auditLogger: logger,
    worktreesRoot: worktreesDir,
    protectedProjects: [protectedRepo]
  });

  const baseContext = {
    logger,
    db: logger.db,
    taskManager,
    attemptLedger,
    effectsLedger,
    workspaceManager: wsManager,
    controller,
    enforcementMode: 'V2_ATTEMPT_SCOPED'
  };

  t.after(() => {
    logger.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await t.test('1. Write task receives an isolated worktree bound to attempt', async () => {
    const task = taskManager.createTask({
      fromAgent: 'antigravity',
      toAgent: 'freebuff',
      title: 'Isolated write task',
      instructions: 'Write in worktree'
    });

    const wt = await wsManager.createAttemptWorktree({
      repoPath: mockRepo,
      taskId: task.id,
      attemptId: 'att_iso_01'
    });

    assert.ok(wt.worktreePath);
    assert.strictEqual(fs.existsSync(wt.worktreePath), true);
    assert.ok(wt.branchName.includes('att_iso_01'));

    const att = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'freebuff',
      worktreePath: wt.worktreePath
    });
    attemptLedger.acquireAttempt(att.attemptId, 'freebuff');

    assert.strictEqual(att.worktreePath, wt.worktreePath);

    // Writing inside authorized worktree succeeds
    const insideFile = path.join(wt.worktreePath, 'file1.txt');
    const result = await registry.executeTool('bridge_create_file', {
      filePath: insideFile,
      content: 'authorized worktree write',
      overwrite: true,
      agentId: 'freebuff',
      attemptId: att.attemptId,
      epoch: att.epoch
    }, baseContext);

    assert.ok(result);
    assert.strictEqual(fs.existsSync(insideFile), true);
  });

  await t.test('2. Agent cannot substitute another worktree path', async () => {
    const task = taskManager.createTask({
      fromAgent: 'antigravity',
      toAgent: 'freebuff',
      title: 'Substitution attempt',
      instructions: 'Try substituting another path'
    });

    const wt = await wsManager.createAttemptWorktree({
      repoPath: mockRepo,
      taskId: task.id,
      attemptId: 'att_iso_02'
    });

    const att = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'freebuff',
      worktreePath: wt.worktreePath
    });
    attemptLedger.acquireAttempt(att.attemptId, 'freebuff');

    const fakeWorktree = path.join(tmpRoot, 'fake-worktree');
    fs.mkdirSync(fakeWorktree, { recursive: true });

    // Agent attempts to pass a substituted worktreePath
    await assert.rejects(
      async () => {
        await registry.executeTool('bridge_create_file', {
          filePath: path.join(fakeWorktree, 'exploit.txt'),
          content: 'exploit',
          agentId: 'freebuff',
          attemptId: att.attemptId,
          epoch: att.epoch,
          worktreePath: fakeWorktree
        }, baseContext);
      },
      /WORKSPACE_ISOLATION_ERROR.*substitution/i
    );
  });

  await t.test('3. Protected project (Zia) strictly forbids direct writes without isolated worktree', async () => {
    const task = taskManager.createTask({
      fromAgent: 'antigravity',
      toAgent: 'freebuff',
      title: 'Protected write attempt',
      instructions: 'Try writing directly to protected repo'
    });

    const att = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'freebuff',
      worktreePath: null // No isolated worktree!
    });
    attemptLedger.acquireAttempt(att.attemptId, 'freebuff');

    const targetProtectedFile = path.join(protectedRepo, 'infiltrate.txt');
    await assert.rejects(
      async () => {
        await registry.executeTool('bridge_create_file', {
          filePath: targetProtectedFile,
          content: 'infiltrate',
          agentId: 'freebuff',
          attemptId: att.attemptId,
          epoch: att.epoch
        }, baseContext);
      },
      /PROTECTED_PROJECT_ERROR/
    );
  });

  await t.test('4. Direct project-root write is rejected when external write isolation is required', async () => {
    const task = taskManager.createTask({
      fromAgent: 'antigravity',
      toAgent: 'freebuff',
      title: 'External write task',
      instructions: 'Requires isolation'
    });

    const att = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'freebuff',
      worktreePath: null // Missing worktree
    });
    attemptLedger.acquireAttempt(att.attemptId, 'freebuff');

    const directRepoFile = path.join(mockRepo, 'direct.txt');
    await assert.rejects(
      async () => {
        await registry.executeTool('bridge_create_file', {
          filePath: directRepoFile,
          content: 'direct write',
          agentId: 'freebuff',
          attemptId: att.attemptId,
          epoch: att.epoch,
          isExternalWrite: true
        }, baseContext);
      },
      /WORKSPACE_ISOLATION_ERROR.*external write tasks require an isolated worktree/
    );
  });

  await t.test('5. Post-attempt diff verification inspects worktree changes accurately', async () => {
    const diffRes = await wsManager.verifyWorktreeDiff({
      repoPath: mockRepo,
      worktreePath: path.join(worktreesDir, 'repo', 'task_1', 'att_1'),
      baseCommit: 'main'
    });

    assert.strictEqual(diffRes.ok, true);
    assert.deepStrictEqual(diffRes.changedFiles, ['src/modified-file.js', 'package.json']);
  });
});
