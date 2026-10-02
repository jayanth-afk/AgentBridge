import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

const execAsync = promisify(exec);

export class GitController {
  constructor(permissionGuard, auditLogger) {
    this.guard = permissionGuard;
    this.logger = auditLogger;
  }

  async _execGit(repoPath, args, timeoutMs = 20000) {
    const resolved = path.resolve(repoPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Directory '${resolved}' does not exist.`);
    }

    const scrubbedEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin',
      HOME: process.env.HOME || '/Users/jayanthpranaykonada',
      USER: process.env.USER || 'jayanthpranaykonada',
      GIT_TERMINAL_PROMPT: '0'
    };

    const cmd = `git ${args.join(' ')}`;
    return execAsync(cmd, {
      cwd: resolved,
      env: scrubbedEnv,
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024
    });
  }

  async getStatus(repoPath, agentId) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_READ');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'READ');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    try {
      const { stdout } = await this._execGit(pathCheck.path, ['status', '--porcelain=v2', '--branch']);
      const lines = stdout.trim().split('\n').filter(Boolean);

      let branch = 'unknown';
      let upstream = null;
      let ahead = 0;
      let behind = 0;
      const staged = [];
      const unstaged = [];
      const untracked = [];

      for (const line of lines) {
        if (line.startsWith('# branch.head ')) {
          branch = line.replace('# branch.head ', '').trim();
        } else if (line.startsWith('# branch.upstream ')) {
          upstream = line.replace('# branch.upstream ', '').trim();
        } else if (line.startsWith('# branch.ab ')) {
          const m = line.match(/\+(\d+)\s+-(\d+)/);
          if (m) {
            ahead = parseInt(m[1], 10);
            behind = parseInt(m[2], 10);
          }
        } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
          // Changed tracked file: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
          const parts = line.split(/\s+/);
          const xy = parts[1];
          const file = parts.slice(8).join(' ');
          if (xy[0] !== '.') staged.push({ file, status: xy[0] });
          if (xy[1] !== '.') unstaged.push({ file, status: xy[1] });
        } else if (line.startsWith('? ')) {
          untracked.push(line.replace('? ', '').trim());
        }
      }

      const summary = {
        repoPath: pathCheck.path,
        branch,
        upstream,
        ahead,
        behind,
        isClean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
        stagedCount: staged.length,
        unstagedCount: unstaged.length,
        untrackedCount: untracked.length,
        staged,
        unstaged: unstaged.slice(0, 50),
        untracked: untracked.slice(0, 50)
      };

      this.logger.log({
        agentId,
        action: 'git_status',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { branch, clean: summary.isClean }
      });

      return summary;
    } catch (err) {
      throw new Error(`Git status failed in '${repoPath}': ${err.message}`);
    }
  }

  async getBranches(repoPath, agentId) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_READ');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'READ');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    try {
      const { stdout } = await this._execGit(pathCheck.path, ['branch', '-a', '--format="%(refname:short)|%(HEAD)|%(upstream:short)"']);
      const lines = stdout.trim().split('\n').filter(Boolean);

      let currentBranch = null;
      const localBranches = [];
      const remoteBranches = [];

      for (const line of lines) {
        const cleaned = line.replace(/^"/, '').replace(/"$/, '');
        const [ref, isHead, upstream] = cleaned.split('|');
        const isCurrent = isHead === '*';
        if (isCurrent) currentBranch = ref;

        if (ref.startsWith('origin/') || ref.startsWith('remotes/')) {
          remoteBranches.push(ref);
        } else {
          localBranches.push({
            name: ref,
            current: isCurrent,
            upstream: upstream || null
          });
        }
      }

      this.logger.log({
        agentId,
        action: 'git_branches',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { currentBranch, localCount: localBranches.length }
      });

      return {
        currentBranch,
        localBranches,
        remoteBranches: remoteBranches.slice(0, 20)
      };
    } catch (err) {
      throw new Error(`Git list branches failed in '${repoPath}': ${err.message}`);
    }
  }

  async createBranch(repoPath, agentId, branchName, startPoint = null) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_WRITE');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'WRITE');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    // Sanitize branch name
    const sanitized = (branchName || '').trim();
    if (!sanitized || /[\s~^:?*\[\\]/.test(sanitized) || sanitized.startsWith('-')) {
      throw new Error(`Invalid Git branch name: '${branchName}'`);
    }

    const args = ['branch', sanitized];
    if (startPoint) args.push(startPoint);

    try {
      await this._execGit(pathCheck.path, args);

      this.logger.log({
        agentId,
        action: 'git_create_branch',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { branch: sanitized, startPoint }
      });

      return {
        created: true,
        branch: sanitized,
        repoPath: pathCheck.path
      };
    } catch (err) {
      throw new Error(`Failed to create branch '${sanitized}': ${err.message}`);
    }
  }

  async switchBranch(repoPath, agentId, branchName, createIfMissing = false) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_WRITE');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'WRITE');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    const sanitized = (branchName || '').trim();
    if (!sanitized || sanitized.startsWith('-')) {
      throw new Error(`Invalid branch name: '${branchName}'`);
    }

    const args = ['checkout'];
    if (createIfMissing) args.push('-B');
    args.push(sanitized);

    try {
      const { stderr } = await this._execGit(pathCheck.path, args);

      this.logger.log({
        agentId,
        action: 'git_switch_branch',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { branch: sanitized }
      });

      return {
        switched: true,
        currentBranch: sanitized,
        message: stderr.trim()
      };
    } catch (err) {
      throw new Error(`Failed to switch to branch '${sanitized}': ${err.message}`);
    }
  }

  async commit(repoPath, agentId, message, files = null, stageAll = false) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_WRITE');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'WRITE');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('Commit message must not be empty.');
    }

    try {
      // 1. Staging
      if (stageAll) {
        await this._execGit(pathCheck.path, ['add', '-A']);
      } else if (Array.isArray(files) && files.length > 0) {
        for (const file of files) {
          await this._execGit(pathCheck.path, ['add', file]);
        }
      }

      // 2. Commit
      const authorStr = `${agentId} <${agentId}@agent-bridge.local>`;
      const safeMsg = message.replace(/"/g, '\\"');
      const { stdout } = await this._execGit(pathCheck.path, [
        '-c', `user.name="${agentId}"`,
        '-c', `user.email="${agentId}@agent-bridge.local"`,
        'commit', '-m', `"${safeMsg}"`
      ]);

      // 3. Get commit hash
      const { stdout: hashOut } = await this._execGit(pathCheck.path, ['rev-parse', '--short', 'HEAD']);
      const commitHash = hashOut.trim();

      this.logger.log({
        agentId,
        action: 'git_commit',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { commitHash, message }
      });

      return {
        committed: true,
        commitHash,
        message,
        summary: stdout.trim().split('\n')[0]
      };
    } catch (err) {
      throw new Error(`Git commit failed: ${err.message}`);
    }
  }

  async getLog(repoPath, agentId, maxCommits = 10) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_READ');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'READ');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    try {
      const format = '%h|%an|%ad|%s';
      const { stdout } = await this._execGit(pathCheck.path, [
        'log',
        `-n ${Math.min(maxCommits, 50)}`,
        `--format="${format}"`,
        '--date=short'
      ]);

      const lines = stdout.trim().split('\n').filter(Boolean);
      const commits = lines.map(line => {
        const cleaned = line.replace(/^"/, '').replace(/"$/, '');
        const [hash, author, date, ...subjectParts] = cleaned.split('|');
        return {
          hash,
          author,
          date,
          subject: subjectParts.join('|')
        };
      });

      return {
        repoPath: pathCheck.path,
        totalReturned: commits.length,
        commits
      };
    } catch (err) {
      throw new Error(`Git log failed in '${repoPath}': ${err.message}`);
    }
  }

  async getDiff(repoPath, agentId, staged = false, maxLines = 100) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_READ');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'READ');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    try {
      const args = ['diff'];
      if (staged) args.push('--staged');
      args.push('--stat');

      const { stdout: statOut } = await this._execGit(pathCheck.path, args);

      // Brief diff patch
      const patchArgs = ['diff'];
      if (staged) patchArgs.push('--staged');
      const { stdout: patchOut } = await this._execGit(pathCheck.path, patchArgs);

      const lines = patchOut.split('\n');
      const truncated = lines.length > maxLines;
      const snippet = lines.slice(0, maxLines).join('\n');

      return {
        repoPath: pathCheck.path,
        staged,
        stat: statOut.trim(),
        diff: snippet,
        truncated,
        totalDiffLines: lines.length
      };
    } catch (err) {
      throw new Error(`Git diff failed in '${repoPath}': ${err.message}`);
    }
  }

  /**
   * Git push with multi-point safeguards.
   * Prevents accidental pushes, protects master/main, and audits extensively.
   */
  async push(repoPath, agentId, {
    remote = 'origin',
    branch = null,
    explicitConfirmation = false,
    allowProtected = false,
    dryRun = false
  } = {}) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'PUSH');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'WRITE');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    // Safeguard 1: Explicit caller confirmation required
    if (!explicitConfirmation) {
      throw new Error(
        `GitPushBlocked: Push requires explicit authorization. Pass explicitConfirmation: true to confirm intent.`
      );
    }

    // Determine current branch if not provided
    let targetBranch = branch;
    if (!targetBranch) {
      const { stdout } = await this._execGit(pathCheck.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
      targetBranch = stdout.trim();
    }

    // Safeguard 2: Protected branch verification
    const protectedBranches = ['main', 'master', 'production', 'release'];
    if (protectedBranches.includes(targetBranch.toLowerCase()) && !allowProtected) {
      throw new Error(
        `GitPushBlocked: Pushing to protected branch '${targetBranch}' is forbidden unless allowProtected: true is explicitly provided.`
      );
    }

    // Capture current commit being pushed for the audit trail
    const { stdout: headOut } = await this._execGit(pathCheck.path, ['rev-parse', 'HEAD']);
    const headCommit = headOut.trim();

    this.logger.log({
      agentId,
      action: 'git_push_attempt',
      targetPath: pathCheck.path,
      status: 'pending',
      details: { remote, targetBranch, headCommit, dryRun }
    });

    const pushArgs = ['push', remote, targetBranch];
    if (dryRun) pushArgs.push('--dry-run');

    try {
      const { stdout, stderr } = await this._execGit(pathCheck.path, pushArgs, 30000);

      this.logger.log({
        agentId,
        action: 'git_push',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { remote, targetBranch, headCommit, dryRun }
      });

      return {
        pushed: true,
        dryRun,
        remote,
        branch: targetBranch,
        headCommit,
        output: (stdout || stderr).trim()
      };
    } catch (err) {
      this.logger.log({
        agentId,
        action: 'git_push',
        targetPath: pathCheck.path,
        status: 'failed',
        executionMs: Date.now() - t0,
        details: { remote, targetBranch, headCommit, error: err.message }
      });

      throw new Error(`Git push failed: ${err.message}`);
    }
  }
}
