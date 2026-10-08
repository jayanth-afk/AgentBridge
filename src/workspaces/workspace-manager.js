import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { CONFIG } from '../config.js';

export const IntegrationStatus = Object.freeze({
  QUEUED: 'QUEUED',
  VERIFYING: 'VERIFYING',
  READY_FOR_MERGE: 'READY_FOR_MERGE',
  NEEDS_APPROVAL: 'NEEDS_APPROVAL',
  CONFLICT: 'NEEDS_RESOLUTION',
  MERGED: 'MERGED',
  REJECTED: 'REJECTED'
});

export class WorkspaceManager {
  constructor({
    gitController,
    auditLogger = null,
    worktreesRoot = null,
    protectedProjects = []
  }) {
    this.git = gitController;
    this.logger = auditLogger;
    this.db = auditLogger?.db || null;
    this.worktreesRoot = worktreesRoot || path.join(os.homedir(), '.agent-bridge', 'worktrees');

    // Canonicalize protected project paths (e.g. Zia)
    const defaultProtected = [
      CONFIG.ZIA_ROOT ? path.resolve(CONFIG.ZIA_ROOT) : null
    ].filter(Boolean);

    this.protectedProjects = new Set([
      ...defaultProtected,
      ...protectedProjects.map(p => path.resolve(p))
    ]);

    if (!fs.existsSync(this.worktreesRoot)) {
      try {
        fs.mkdirSync(this.worktreesRoot, { recursive: true });
      } catch {}
    }

    if (this.db) {
      this.initTables();
    }
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS integration_queue (
        item_id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        source_branch TEXT NOT NULL,
        target_branch TEXT NOT NULL DEFAULT 'main',
        status TEXT NOT NULL,
        requires_human_approval INTEGER NOT NULL DEFAULT 0,
        verification_result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        merged_at TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_iq_status ON integration_queue(status);
      CREATE INDEX IF NOT EXISTS idx_iq_project ON integration_queue(project_path);
    `);
  }

  isProtectedProject(targetPath) {
    if (!targetPath) return false;
    const resolved = path.resolve(targetPath);
    for (const prot of this.protectedProjects) {
      if (resolved === prot || resolved.startsWith(prot + path.sep)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Creates an isolated Git worktree for an attempt so the main checkout is never modified directly.
   */
  async createAttemptWorktree({ repoPath, taskId, attemptId, baseCommit = 'HEAD' }) {
    const resolvedRepo = path.resolve(repoPath);
    const projectName = path.basename(resolvedRepo);
    const worktreeDir = path.join(this.worktreesRoot, projectName, taskId, attemptId);
    const branchName = `bridge/${taskId}/${attemptId}`;

    if (fs.existsSync(worktreeDir)) {
      try {
        await this.git._execGit(resolvedRepo, ['worktree', 'remove', '--force', worktreeDir]);
      } catch {}
    }

    const parentDir = path.dirname(worktreeDir);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // git worktree add -b <branch> <path> <baseCommit>
    await this.git._execGit(resolvedRepo, [
      'worktree',
      'add',
      '-b',
      branchName,
      worktreeDir,
      baseCommit
    ]);

    this.logger?.log({
      agentId: 'system',
      action: 'create_attempt_worktree',
      status: 'created',
      details: { repoPath: resolvedRepo, worktreeDir, branchName, baseCommit }
    });

    return {
      worktreePath: worktreeDir,
      branchName,
      baseCommit,
      repoPath: resolvedRepo
    };
  }

  /**
   * Cleans up an isolated worktree after attempt completion or cancellation
   */
  async removeAttemptWorktree({ repoPath, worktreePath, deleteBranch = false, branchName = null }) {
    const resolvedRepo = path.resolve(repoPath);
    try {
      await this.git._execGit(resolvedRepo, ['worktree', 'remove', '--force', worktreePath]);
    } catch {}

    if (deleteBranch && branchName) {
      try {
        await this.git._execGit(resolvedRepo, ['branch', '-D', branchName]);
      } catch {}
    }

    try {
      await this.git._execGit(resolvedRepo, ['worktree', 'prune']);
    } catch {}

    return { removed: true, worktreePath };
  }

  /**
   * Enqueue a completed attempt branch for verified integration into the target branch
   */
  enqueueIntegration({
    projectPath,
    taskId,
    attemptId,
    sourceBranch,
    targetBranch = 'main',
    requiresApproval = null
  }) {
    const resolvedProject = path.resolve(projectPath);
    const isProtected = this.isProtectedProject(resolvedProject);
    const mustApprove = requiresApproval !== null ? Boolean(requiresApproval) : isProtected;

    const itemId = `iq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    if (this.db) {
      this.db.prepare(`
        INSERT INTO integration_queue (
          item_id, project_path, task_id, attempt_id, source_branch, target_branch,
          status, requires_human_approval, verification_result, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', ?, NULL, ?, ?)
      `).run(
        itemId,
        resolvedProject,
        taskId,
        attemptId,
        sourceBranch,
        targetBranch,
        mustApprove ? 1 : 0,
        now,
        now
      );
    }

    this.logger?.log({
      agentId: 'system',
      action: 'enqueue_integration',
      status: 'queued',
      details: { itemId, projectPath: resolvedProject, sourceBranch, targetBranch, mustApprove }
    });

    return {
      itemId,
      projectPath: resolvedProject,
      taskId,
      attemptId,
      sourceBranch,
      targetBranch,
      status: IntegrationStatus.QUEUED,
      requiresHumanApproval: mustApprove,
      isProtectedProject: isProtected,
      createdAt: now
    };
  }

  /**
   * Process the next queued item with conflict checking and approval gates
   */
  async processIntegrationItem(itemId, { verificationFn = null, approvedByHuman = false } = {}) {
    if (!this.db) throw new Error('Database required for integration queue processing');

    const item = this.db.prepare(`SELECT * FROM integration_queue WHERE item_id = ?`).get(itemId);
    if (!item) throw new Error(`Integration item '${itemId}' not found.`);

    const now = new Date().toISOString();
    const repoPath = item.project_path;

    // 1. Run Verification
    if (verificationFn) {
      this.db.prepare(`UPDATE integration_queue SET status = 'VERIFYING', updated_at = ? WHERE item_id = ?`).run(now, itemId);
      try {
        const verifyOutcome = await verificationFn(item);
        if (!verifyOutcome.ok) {
          this.db.prepare(`
            UPDATE integration_queue SET status = 'REJECTED', verification_result = ?, updated_at = ? WHERE item_id = ?
          `).run(JSON.stringify(verifyOutcome), now, itemId);
          return { status: IntegrationStatus.REJECTED, error: verifyOutcome.error || 'Verification failed' };
        }
      } catch (err) {
        this.db.prepare(`
          UPDATE integration_queue SET status = 'REJECTED', error = ?, updated_at = ? WHERE item_id = ?
        `).run(err.message, now, itemId);
        return { status: IntegrationStatus.REJECTED, error: err.message };
      }
    }

    // 2. Check for merge conflict using git merge-tree
    let hasConflict = false;
    try {
      const { stdout } = await this.git._execGit(repoPath, [
        'merge-tree',
        '--write-tree',
        item.target_branch,
        item.source_branch
      ]);
    } catch (mergeTreeErr) {
      hasConflict = true;
      this.db.prepare(`
        UPDATE integration_queue
        SET status = 'NEEDS_RESOLUTION', error = ?, updated_at = ?
        WHERE item_id = ?
      `).run(`Merge Conflict: ${mergeTreeErr.message}`, now, itemId);

      return { status: IntegrationStatus.CONFLICT, error: mergeTreeErr.message };
    }

    // 3. Human Approval Gate
    const needsApproval = Boolean(item.requires_human_approval);
    if (needsApproval && !approvedByHuman) {
      this.db.prepare(`
        UPDATE integration_queue SET status = 'NEEDS_APPROVAL', updated_at = ? WHERE item_id = ?
      `).run(now, itemId);

      return {
        status: IntegrationStatus.NEEDS_APPROVAL,
        requiresApproval: true,
        project: item.project_path,
        message: 'Protected project change verified and awaiting human approval.'
      };
    }

    // 4. Clean Fast-Forward / Merge into Target Branch
    try {
      await this.git._execGit(repoPath, ['merge', '--no-ff', '-m', `Merge ${item.source_branch} into ${item.target_branch}`, item.source_branch]);

      this.db.prepare(`
        UPDATE integration_queue
        SET status = 'MERGED', merged_at = ?, updated_at = ?
        WHERE item_id = ?
      `).run(now, now, itemId);

      return { status: IntegrationStatus.MERGED, mergedAt: now };
    } catch (err) {
      this.db.prepare(`
        UPDATE integration_queue SET status = 'NEEDS_RESOLUTION', error = ?, updated_at = ? WHERE item_id = ?
      `).run(err.message, now, itemId);
      return { status: IntegrationStatus.CONFLICT, error: err.message };
    }
  }

  getQueueItem(itemId) {
    if (!this.db) return null;
    return this.db.prepare(`SELECT * FROM integration_queue WHERE item_id = ?`).get(itemId);
  }
}
