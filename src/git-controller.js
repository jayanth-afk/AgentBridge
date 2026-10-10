import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';


export class GitController {
  constructor(permissionGuard, auditLogger) {
    this.guard = permissionGuard;
    this.logger = auditLogger;
  }

  async _execGit(repoPath, args, timeoutMs = 25000) {
    const resolved = path.resolve(repoPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`InvalidDirectory: Path '${resolved}' is not an existing directory.`);
    }
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
      throw new Error('InvalidGitArguments: Git arguments must be an array of strings.');
    }

    const scrubbedEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin',
      HOME: process.env.HOME || '/Users/jayanthpranaykonada',
      USER: process.env.USER || 'jayanthpranaykonada',
      GIT_TERMINAL_PROMPT: '0'
    };

    return await new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd: resolved,
        env: scrubbedEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const append = (current, chunk) => current + chunk.toString();
      child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
      child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 1000).unref();
      }, timeoutMs);
      child.once('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', code => {
        clearTimeout(timer);
        if (code === 0 && !timedOut) return resolve({ stdout, stderr });
        const err = new Error(timedOut ? `Git command timed out after ${timeoutMs}ms` : `git exited with code ${code}: ${(stderr || stdout).trim()}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      });
    });
  }

  async _verifyGitRepo(repoPath) {
    const resolved = path.resolve(repoPath);
    try {
      const { stdout: topLevel } = await this._execGit(resolved, ['rev-parse', '--show-toplevel']);
      if (path.resolve(topLevel.trim()) !== resolved) {
        throw new Error(`Path '${resolved}' is not the root of a git repository (found top-level: '${topLevel.trim()}').`);
      }
    } catch (err) {
      // Check if bare repo
      try {
        const { stdout: isBare } = await this._execGit(resolved, ['rev-parse', '--is-bare-repository']);
        if (isBare.trim() === 'true') {
          return;
        }
      } catch {}
      throw new Error(`InvalidGitRepository: '${repoPath}' is not a valid git repository.`);
    }
  }

  async getStatus(repoPath, agentId, compact = true) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_READ');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'READ');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    await this._verifyGitRepo(pathCheck.path);

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
          const parts = line.split(/\s+/);
          const xy = parts[1];
          const file = parts.slice(8).join(' ');
          if (xy[0] !== '.') staged.push(file);
          if (xy[1] !== '.') unstaged.push(file);
        } else if (line.startsWith('? ')) {
          untracked.push(line.replace('? ', '').trim());
        }
      }

      const isClean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;

      this.logger.log({
        agentId,
        action: 'git_status',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { branch, isClean }
      });

      if (compact) {
        return {
          repoPath: pathCheck.path,
          branch,
          isClean,
          staged: staged.length,
          unstaged: unstaged.length,
          untracked: untracked.length,
          changedFiles: isClean ? [] : [...staged, ...unstaged, ...untracked].slice(0, 15)
        };
      }

      return {
        repoPath: pathCheck.path,
        branch,
        upstream,
        ahead,
        behind,
        isClean,
        stagedCount: staged.length,
        unstagedCount: unstaged.length,
        untrackedCount: untracked.length,
        staged,
        unstaged: unstaged.slice(0, 50),
        untracked: untracked.slice(0, 50)
      };
    } catch (err) {
      throw new Error(`Git status failed in '${repoPath}': ${err.message}`);
    }
  }

  async getBranches(repoPath, agentId, compact = true) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_READ');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'READ');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    await this._verifyGitRepo(pathCheck.path);

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

      if (compact) {
        return {
          current: currentBranch,
          branches: localBranches.map(b => b.name)
        };
      }

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

    await this._verifyGitRepo(pathCheck.path);

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
        success: true,
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

    await this._verifyGitRepo(pathCheck.path);

    const sanitized = (branchName || '').trim();
    if (!sanitized || sanitized.startsWith('-')) {
      throw new Error(`Invalid branch name: '${branchName}'`);
    }

    const args = ['checkout'];
    if (createIfMissing) args.push('-B');
    args.push(sanitized);

    try {
      await this._execGit(pathCheck.path, args);

      this.logger.log({
        agentId,
        action: 'git_switch_branch',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { branch: sanitized }
      });

      return {
        success: true,
        branch: sanitized,
        currentBranch: sanitized
      };
    } catch (err) {
      throw new Error(`Failed to switch to branch '${sanitized}': ${err.message}`);
    }
  }

  async deleteBranch(repoPath, agentId, branchName, force = false) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_WRITE');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'WRITE');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    await this._verifyGitRepo(pathCheck.path);

    const sanitized = (branchName || '').trim();
    if (!sanitized) throw new Error('Branch name required.');

    const flag = force ? '-D' : '-d';
    try {
      await this._execGit(pathCheck.path, ['branch', flag, sanitized]);

      this.logger.log({
        agentId,
        action: 'git_delete_branch',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { branch: sanitized, force }
      });

      return {
        success: true,
        branch: sanitized,
        deleted: true
      };
    } catch (err) {
      throw new Error(`Failed to delete branch '${sanitized}': ${err.message}`);
    }
  }

  async stage(repoPath, agentId, files = null, stageAll = false) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_WRITE');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'WRITE');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    await this._verifyGitRepo(pathCheck.path);

    try {
      if (stageAll || !files || files.length === 0) {
        await this._execGit(pathCheck.path, ['add', '-A']);
      } else {
        const fileList = Array.isArray(files) ? files : [files];
        for (const f of fileList) {
          await this._execGit(pathCheck.path, ['add', f]);
        }
      }

      this.logger.log({
        agentId,
        action: 'git_stage',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { stageAll }
      });

      return {
        success: true,
        staged: true
      };
    } catch (err) {
      throw new Error(`Git stage failed: ${err.message}`);
    }
  }

  async commit(repoPath, agentId, message, files = null, stageAll = false) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_WRITE');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'WRITE');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    await this._verifyGitRepo(pathCheck.path);

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
      await this._execGit(pathCheck.path, [
        '-c', `user.name="${agentId}"`,
        '-c', `user.email="${agentId}@agent-bridge.local"`,
        'commit', '-m', safeMsg
      ]);

      // 3. Commit SHA
      const { stdout: hashOut } = await this._execGit(pathCheck.path, ['rev-parse', '--short', 'HEAD']);
      const commitHash = hashOut.trim();

      const { stdout: branchOut } = await this._execGit(pathCheck.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = branchOut.trim();

      this.logger.log({
        agentId,
        action: 'git_commit',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { commitHash, message, branch }
      });

      return {
        success: true,
        commit: commitHash,
        branch,
        message
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

    await this._verifyGitRepo(pathCheck.path);

    try {
      const format = '%h|%an|%ad|%s';
      const { stdout } = await this._execGit(pathCheck.path, [
        'log',
        '-n', String(Math.min(maxCommits, 25)),
        `--format=${format}`,
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
        commits
      };
    } catch (err) {
      throw new Error(`Git log failed in '${repoPath}': ${err.message}`);
    }
  }

  async getDiff(repoPath, agentId, staged = false, maxLines = 80) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_READ');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'READ');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    await this._verifyGitRepo(pathCheck.path);

    try {
      const args = ['diff'];
      if (staged) args.push('--staged');
      args.push('--stat');

      const { stdout: statOut } = await this._execGit(pathCheck.path, args);

      const patchArgs = ['diff'];
      if (staged) patchArgs.push('--staged');
      const { stdout: patchOut } = await this._execGit(pathCheck.path, patchArgs);

      const lines = patchOut.split('\n');
      const snippet = lines.slice(0, maxLines).join('\n');

      return {
        repoPath: pathCheck.path,
        staged,
        stat: statOut.trim(),
        diff: snippet,
        truncated: lines.length > maxLines
      };
    } catch (err) {
      throw new Error(`Git diff failed in '${repoPath}': ${err.message}`);
    }
  }

  async pull(repoPath, agentId, { remote = 'origin', branch = null } = {}) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_WRITE');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'WRITE');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    await this._verifyGitRepo(pathCheck.path);

    let targetBranch = branch;
    if (!targetBranch) {
      const { stdout } = await this._execGit(pathCheck.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
      targetBranch = stdout.trim();
    }

    try {
      const { stdout } = await this._execGit(pathCheck.path, ['pull', remote, targetBranch]);

      this.logger.log({
        agentId,
        action: 'git_pull',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { remote, targetBranch }
      });

      return {
        success: true,
        remote,
        branch: targetBranch,
        summary: stdout.trim().split('\n')[0]
      };
    } catch (err) {
      throw new Error(`Git pull failed: ${err.message}`);
    }
  }

  async fetch(repoPath, agentId, { remote = 'origin' } = {}) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_READ');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'READ');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    await this._verifyGitRepo(pathCheck.path);

    try {
      await this._execGit(pathCheck.path, ['fetch', remote]);

      this.logger.log({
        agentId,
        action: 'git_fetch',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { remote }
      });

      return {
        success: true,
        remote
      };
    } catch (err) {
      throw new Error(`Git fetch failed: ${err.message}`);
    }
  }

  /**
   * Autonomous Git push with machine-level validation and low-token output.
   * NO human confirmation or interactive pause required.
   */
  async push(repoPath, agentId, {
    remote = 'origin',
    branch = null,
    allowProtected = false,
    dryRun = false,
    verbose = false
  } = {}) {
    const t0 = Date.now();

    // 1. Permission check (Autonomous PUSH granted)
    const perm = this.guard.checkPermission(agentId, 'PUSH');
    if (!perm.allowed) throw new Error(perm.reason);

    // 2. Path validation
    const pathCheck = this.guard.validatePathAccess(repoPath, 'WRITE');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    // 3. Repository validation
    await this._verifyGitRepo(pathCheck.path);

    // 4. Branch validation
    let targetBranch = branch;
    if (!targetBranch) {
      const { stdout: headBranchOut } = await this._execGit(pathCheck.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
      targetBranch = headBranchOut.trim();
    }

    // Check if target branch exists locally
    try {
      await this._execGit(pathCheck.path, ['show-ref', '--verify', '--quiet', `refs/heads/${targetBranch}`]);
    } catch {
      const errReason = `InvalidGitBranch: Branch '${targetBranch}' does not exist locally in repository '${pathCheck.path}'.`;
      this.logger.log({
        agentId,
        action: 'git_push_rejected',
        targetPath: pathCheck.path,
        status: 'failed',
        details: { reason: errReason, branch: targetBranch }
      });
      throw new Error(errReason);
    }

    // 5. Remote validation
    const { stdout: remotesOut } = await this._execGit(pathCheck.path, ['remote']);
    const configuredRemotes = remotesOut.trim().split(/\s+/).filter(Boolean);
    if (!configuredRemotes.includes(remote)) {
      const errReason = `InvalidGitRemote: Remote '${remote}' is not configured in repository '${pathCheck.path}'. Available: [${configuredRemotes.join(', ')}]`;
      this.logger.log({
        agentId,
        action: 'git_push_rejected',
        targetPath: pathCheck.path,
        status: 'failed',
        details: { reason: errReason, remote }
      });
      throw new Error(errReason);
    }

    // 6. Commit verification
    let headCommit;
    try {
      const { stdout: commitOut } = await this._execGit(pathCheck.path, ['rev-parse', '--short', targetBranch]);
      headCommit = commitOut.trim();
    } catch {
      throw new Error(`NoCommitsToPush: Branch '${targetBranch}' has no valid commits to push.`);
    }

    // 7. Protected branch policy check (configurable, deterministic, non-interactive)
    const protectedList = this.guard.config.GIT_PROTECTED_BRANCHES || ['main', 'master', 'production', 'release'];
    const isProtected = protectedList.map(b => b.toLowerCase()).includes(targetBranch.toLowerCase());
    const autonomousProtectedAllowed = this.guard.config.ALLOW_AUTONOMOUS_PROTECTED_PUSH === true || allowProtected === true;

    if (isProtected && !autonomousProtectedAllowed) {
      const errReason = `ProtectedBranchBlocked: Autonomous push to protected branch '${targetBranch}' is disabled by policy. Pass allowProtected: true or configure ALLOW_AUTONOMOUS_PROTECTED_PUSH: true to enable.`;
      this.logger.log({
        agentId,
        action: 'git_push_rejected',
        targetPath: pathCheck.path,
        status: 'blocked',
        details: { reason: errReason, targetBranch, headCommit }
      });
      throw new Error(errReason);
    }

    // 8. Record audit log before pushing
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
      const { stdout, stderr } = await this._execGit(pathCheck.path, pushArgs, 35000);

      // Audit log success
      this.logger.log({
        agentId,
        action: 'git_push',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { remote, targetBranch, headCommit, dryRun }
      });

      // Compact token-efficient response
      const result = {
        success: true,
        branch: targetBranch,
        commit: headCommit,
        remote,
        dryRun
      };

      if (verbose) {
        result.rawOutput = (stdout || stderr).trim();
      }

      return result;
    } catch (err) {
      this.logger.log({
        agentId,
        action: 'git_push',
        targetPath: pathCheck.path,
        status: 'failed',
        executionMs: Date.now() - t0,
        details: { remote, targetBranch, headCommit, error: err.message }
      });

      // Concise error
      const firstLine = err.message.split('\n')[0];
      throw new Error(`GitPushFailed: ${firstLine}`);
    }
  }

  async getSummary(repoPath, agentId) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_READ');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'READ');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    await this._verifyGitRepo(pathCheck.path);

    try {
      const { stdout: headOut } = await this._execGit(pathCheck.path, ['rev-parse', '--short', 'HEAD']);
      const headCommit = headOut.trim();

      const { stdout: branchOut } = await this._execGit(pathCheck.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = branchOut.trim();

      const { stdout: statusOut } = await this._execGit(pathCheck.path, ['status', '--porcelain=v1']);
      const statusLines = statusOut.split('\n').filter(Boolean);

      let stagedCount = 0;
      let unstagedCount = 0;
      let untrackedCount = 0;

      for (const line of statusLines) {
        const x = line[0];
        const y = line[1];
        if (x === '?' && y === '?') {
          untrackedCount++;
        } else {
          if (x !== ' ' && x !== '?') stagedCount++;
          if (y !== ' ' && y !== '?') unstagedCount++;
        }
      }

      const summary = {
        branch,
        commit: headCommit,
        isClean: statusLines.length === 0,
        stagedCount,
        unstagedCount,
        untrackedCount,
        totalDirtyFiles: statusLines.length,
        executionMs: Date.now() - t0
      };

      this.logger.log({
        agentId,
        action: 'git_summary',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: summary
      });

      return summary;
    } catch (err) {
      throw new Error(`GitSummaryFailed: ${err.message}`);
    }
  }

  async getBlame(repoPath, agentId, filePath, startLine = 1, endLine = 50) {
    const t0 = Date.now();
    const perm = this.guard.checkPermission(agentId, 'GIT_READ');
    if (!perm.allowed) throw new Error(perm.reason);

    const pathCheck = this.guard.validatePathAccess(repoPath, 'READ');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    await this._verifyGitRepo(pathCheck.path);

    const fileRel = path.relative(pathCheck.path, path.resolve(pathCheck.path, filePath));
    const s = Math.max(1, parseInt(startLine, 10) || 1);
    const e = Math.max(s, parseInt(endLine, 10) || (s + 20));

    try {
      const { stdout } = await this._execGit(pathCheck.path, [
        'blame',
        `-L${s},${e}`,
        '--porcelain',
        '--',
        fileRel
      ]);

      const lines = stdout.split('\n');
      const entries = [];
      let currentCommit = null;
      let currentAuthor = null;
      let currentLineNum = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        if (line.startsWith('\t')) {
          entries.push({
            lineNumber: currentLineNum,
            commit: currentCommit ? currentCommit.slice(0, 8) : 'unknown',
            author: currentAuthor || 'unknown',
            content: line.slice(1).slice(0, 100)
          });
        } else {
          const parts = line.split(' ');
          if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0])) {
            currentCommit = parts[0];
            currentLineNum = parseInt(parts[2], 10);
          } else if (parts[0] === 'author') {
            currentAuthor = parts.slice(1).join(' ');
          }
        }
      }

      const result = {
        file: fileRel,
        range: `${s}-${e}`,
        entries: entries.slice(0, 100),
        executionMs: Date.now() - t0
      };

      this.logger.log({
        agentId,
        action: 'git_blame',
        targetPath: pathCheck.path,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { file: fileRel, count: entries.length }
      });

      return result;
    } catch (err) {
      throw new Error(`GitBlameFailed: ${err.message}`);
    }
  }
}
