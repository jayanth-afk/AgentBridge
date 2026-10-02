import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { ConcurrencyManager } from './concurrency-manager.js';

const execAsync = promisify(exec);

export class ProjectController {
  constructor(permissionGuard, auditLogger, concurrencyManager = new ConcurrencyManager(), fileActivityManager = null) {
    this.guard = permissionGuard;
    this.logger = auditLogger;
    this.concurrency = concurrencyManager;
    this.fileActivity = fileActivityManager;
  }

  async inspectProject(rootPath, agentId) {
    const t0 = Date.now();
    const permCheck = this.guard.checkPermission(agentId, 'READ');
    if (!permCheck.allowed) throw new Error(permCheck.reason);

    const pathCheck = this.guard.validatePathAccess(rootPath, 'READ');
    if (!pathCheck.allowed) {
      this.logger.log({ agentId, action: 'inspect_project', targetPath: rootPath, status: 'denied', details: pathCheck.reason });
      throw new Error(pathCheck.reason);
    }

    const resolved = pathCheck.path;
    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      throw new Error(`Path '${resolved}' is not a directory.`);
    }

    const files = fs.readdirSync(resolved, { withFileTypes: true });
    const summary = {
      path: resolved,
      totalEntries: files.length,
      directories: [],
      files: []
    };

    for (const file of files) {
      if (file.name.startsWith('.git') && file.name !== '.gitignore') continue;
      if (file.isDirectory()) {
        summary.directories.push(file.name);
      } else {
        summary.files.push(file.name);
      }
    }

    this.logger.log({
      agentId,
      action: 'inspect_project',
      targetPath: resolved,
      status: 'allowed',
      executionMs: Date.now() - t0,
      details: { totalEntries: summary.totalEntries }
    });

    return summary;
  }

  async readFile(filePath, agentId, startLine = 1, endLine = 500) {
    const t0 = Date.now();
    const permCheck = this.guard.checkPermission(agentId, 'READ');
    if (!permCheck.allowed) throw new Error(permCheck.reason);

    const pathCheck = this.guard.validatePathAccess(filePath, 'READ');
    if (!pathCheck.allowed) {
      this.logger.log({ agentId, action: 'read_file', targetPath: filePath, status: 'denied', details: pathCheck.reason });
      throw new Error(pathCheck.reason);
    }

    const resolved = pathCheck.path;
    if (!fs.existsSync(resolved)) {
      throw new Error(`File '${resolved}' does not exist.`);
    }

    this.fileActivity?.start({ filePath: resolved, agentId, activityType: 'reading' });
    const content = fs.readFileSync(resolved, 'utf8');
    this.fileActivity?.stop({ filePath: resolved, agentId, activityType: 'reading' });
    const lines = content.split('\n');
    const totalLines = lines.length;

    const s = Math.max(1, startLine);
    const e = Math.min(totalLines, endLine);
    const slice = lines.slice(s - 1, e);
    const numbered = slice.map((line, idx) => `${s + idx}: ${line}`).join('\n');
    const fileHash = this.concurrency.computeFileHash(resolved);

    this.logger.log({
      agentId,
      action: 'read_file',
      targetPath: resolved,
      status: 'allowed',
      executionMs: Date.now() - t0,
      details: { totalLines, linesReturned: slice.length, fileHash }
    });

    return {
      filePath: resolved,
      startLine: s,
      endLine: e,
      totalLines,
      fileHash,
      content: numbered,
      // Awareness only: other agents that have announced activity on this file.
      otherActivity: this.otherActivity(resolved, agentId)
    };
  }

  otherActivity(resolved, agentId) {
    if (!this.fileActivity) return [];
    return this.fileActivity.get(resolved)
      .filter(a => a.agent_id !== agentId)
      .map(a => ({ agentId: a.agent_id, activityType: a.activity_type, lastSeen: a.last_seen, description: a.description }));
  }

  async searchFiles(rootPath, agentId, query, isRegex = false, maxResults = 50) {
    const t0 = Date.now();
    const permCheck = this.guard.checkPermission(agentId, 'SEARCH');
    if (!permCheck.allowed) throw new Error(permCheck.reason);

    const pathCheck = this.guard.validatePathAccess(rootPath, 'READ');
    if (!pathCheck.allowed) {
      this.logger.log({ agentId, action: 'search_files', targetPath: rootPath, status: 'denied', details: pathCheck.reason });
      throw new Error(pathCheck.reason);
    }

    const resolved = pathCheck.path;
    const matcher = isRegex ? new RegExp(query, 'i') : null;
    const results = [];

    const walk = (dir) => {
      if (results.length >= maxResults) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.git') || entry.name === 'node_modules' || entry.name === '.build') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          try {
            const data = fs.readFileSync(full, 'utf8');
            const lines = data.split('\n');
            lines.forEach((line, idx) => {
              if (results.length >= maxResults) return;
              const matches = isRegex ? matcher.test(line) : line.includes(query);
              if (matches) {
                results.push({
                  file: full,
                  lineNumber: idx + 1,
                  line: line.trim()
                });
              }
            });
          } catch {
            // Ignore unreadable binary files
          }
        }
      }
    };

    walk(resolved);

    this.logger.log({
      agentId,
      action: 'search_files',
      targetPath: resolved,
      status: 'allowed',
      executionMs: Date.now() - t0,
      details: { query, resultsCount: results.length }
    });

    return { rootPath: resolved, query, results };
  }

  async createFile(filePath, agentId, content, overwrite = false) {
    const t0 = Date.now();
    const permCheck = this.guard.checkPermission(agentId, 'CREATE');
    if (!permCheck.allowed) throw new Error(permCheck.reason);

    const pathCheck = this.guard.validatePathAccess(filePath, 'CREATE');
    if (!pathCheck.allowed) {
      this.logger.log({ agentId, action: 'create_file', targetPath: filePath, status: 'denied', details: pathCheck.reason });
      throw new Error(pathCheck.reason);
    }

    const resolved = pathCheck.path;
    if (fs.existsSync(resolved) && !overwrite) {
      throw new Error(`File '${resolved}' already exists. Pass overwrite=true to overwrite.`);
    }

    const lock = this.concurrency.acquireLock(resolved, agentId);
    if (!lock.acquired) {
      throw new Error(`Cannot create file: ${lock.reason}`);
    }

    try {
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(resolved, content, 'utf8');
      const newHash = this.concurrency.computeFileHash(resolved);

      this.logger.log({
        agentId,
        action: 'create_file',
        targetPath: resolved,
        status: 'allowed',
        executionMs: Date.now() - t0,
        details: { bytesWritten: Buffer.byteLength(content, 'utf8'), overwrite, fileHash: newHash }
      });

      return { filePath: resolved, bytesWritten: Buffer.byteLength(content, 'utf8'), fileHash: newHash, status: 'created' };
    } finally {
      this.concurrency.releaseLock(resolved, agentId);
    }
  }

  async editFile(filePath, agentId, targetContent, replacementContent, expectedHash = null) {
    const t0 = Date.now();
    const permCheck = this.guard.checkPermission(agentId, 'EDIT');
    if (!permCheck.allowed) throw new Error(permCheck.reason);

    const pathCheck = this.guard.validatePathAccess(filePath, 'EDIT');
    if (!pathCheck.allowed) {
      this.logger.log({ agentId, action: 'edit_file', targetPath: filePath, status: 'denied', details: pathCheck.reason });
      throw new Error(pathCheck.reason);
    }

    const resolved = pathCheck.path;
    if (!fs.existsSync(resolved)) {
      throw new Error(`File '${resolved}' does not exist.`);
    }

    // 1. Optimistic concurrency check
    const hashCheck = this.concurrency.verifyExpectedHash(resolved, expectedHash);
    if (!hashCheck.valid) {
      this.logger.log({ agentId, action: 'edit_file', targetPath: resolved, status: 'conflict', details: hashCheck.reason });
      throw new Error(hashCheck.reason);
    }

    // Advisory activity only: this announces the edit but never blocks another agent.
    this.fileActivity?.start({ filePath: resolved, agentId, activityType: 'editing' });

    // Advisory concurrency record; never denies another agent.
    const lock = this.concurrency.acquireLock(resolved, agentId);
    if (!lock.acquired) {
      throw new Error(`Cannot edit file: ${lock.reason}`);
    }

    try {
      const buf = fs.readFileSync(resolved);
      const current = buf.toString('utf8');

      // Re-verify against the exact bytes about to be modified. The earlier check
      // runs before this read, so another agent could have written in between.
      // This is optimistic conflict DETECTION only; it never blocks or queues.
      if (expectedHash) {
        const hashNow = crypto.createHash('sha256').update(buf).digest('hex');
        if (hashNow !== expectedHash) {
          const reason = `ConflictDetected: file was modified concurrently by another agent. Expected hash ${expectedHash}, current hash is ${hashNow}. Please refresh file content and retry.`;
          this.logger.log({ agentId, action: 'edit_file', targetPath: resolved, status: 'conflict', details: reason });
          throw new Error(reason);
        }
      }

      if (!current.includes(targetContent)) {
        throw new Error(`Target content not found in '${resolved}'. Edit aborted.`);
      }

      const firstIndex = current.indexOf(targetContent);
      const lastIndex = current.lastIndexOf(targetContent);
      if (firstIndex !== lastIndex) {
        throw new Error(`Target content appears multiple times in '${resolved}'. Must be unique.`);
      }

      const updated = current.replace(targetContent, replacementContent);
      fs.writeFileSync(resolved, updated, 'utf8');
      const newHash = this.concurrency.computeFileHash(resolved);

      this.logger.log({
        agentId,
        action: 'edit_file',
        targetPath: resolved,
        status: 'allowed',
        executionMs: Date.now() - t0,
        details: { replacedBytes: targetContent.length, newBytes: replacementContent.length, fileHash: newHash }
      });

      return { filePath: resolved, fileHash: newHash, status: 'edited', otherActivity: this.otherActivity(resolved, agentId) };
    } finally {
      this.concurrency.releaseLock(resolved, agentId);
      this.fileActivity?.stop({ filePath: resolved, agentId, activityType: 'editing' });
    }
  }

  async deleteFile(filePath, agentId) {
    const t0 = Date.now();
    const permCheck = this.guard.checkPermission(agentId, 'DELETE');
    if (!permCheck.allowed) throw new Error(permCheck.reason);

    const pathCheck = this.guard.validatePathAccess(filePath, 'DELETE');
    if (!pathCheck.allowed) {
      this.logger.log({ agentId, action: 'delete_file', targetPath: filePath, status: 'denied', details: pathCheck.reason });
      throw new Error(pathCheck.reason);
    }

    const resolved = pathCheck.path;
    if (!fs.existsSync(resolved)) {
      throw new Error(`File '${resolved}' does not exist.`);
    }

    const lock = this.concurrency.acquireLock(resolved, agentId);
    if (!lock.acquired) throw new Error(lock.reason);

    try {
      fs.unlinkSync(resolved);
      this.logger.log({
        agentId,
        action: 'delete_file',
        targetPath: resolved,
        status: 'allowed',
        executionMs: Date.now() - t0
      });
      return { filePath: resolved, status: 'deleted' };
    } finally {
      this.concurrency.releaseLock(resolved, agentId);
    }
  }

  async executeCommand(commandLine, cwd, agentId, timeoutMs = 30000) {
    const t0 = Date.now();
    const permCheck = this.guard.checkPermission(agentId, 'EXECUTE');
    if (!permCheck.allowed) throw new Error(permCheck.reason);

    const cmdCheck = this.guard.validateCommand(commandLine, cwd);
    if (!cmdCheck.allowed) {
      this.logger.log({ agentId, action: 'execute_command', command: commandLine, status: 'denied', details: cmdCheck.reason });
      throw new Error(cmdCheck.reason);
    }

    const scrubbedEnv = {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin',
      HOME: process.env.HOME || '/Users/jayanthpranaykonada',
      USER: process.env.USER || 'jayanthpranaykonada',
      SHELL: '/bin/zsh',
      LANG: 'en_US.UTF-8'
    };

    try {
      const { stdout, stderr } = await execAsync(cmdCheck.command, {
        cwd: cwd || this.guard.config.TEST_WORKSPACE,
        env: scrubbedEnv,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024
      });

      this.logger.log({
        agentId,
        action: 'execute_command',
        command: cmdCheck.command,
        status: 'executed',
        executionMs: Date.now() - t0,
        details: { exitCode: 0 }
      });

      return {
        command: cmdCheck.command,
        exitCode: 0,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      };
    } catch (err) {
      this.logger.log({
        agentId,
        action: 'execute_command',
        command: cmdCheck.command,
        status: 'failed',
        executionMs: Date.now() - t0,
        details: { exitCode: err.code || 1, error: err.message }
      });

      return {
        command: cmdCheck.command,
        exitCode: err.code || 1,
        stdout: (err.stdout || '').trim(),
        stderr: (err.stderr || err.message).trim()
      };
    }
  }
}
