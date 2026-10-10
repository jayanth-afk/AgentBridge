import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConcurrencyManager } from './concurrency-manager.js';
import { CacheManager } from './cache-manager.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

let cachedRgPath = undefined;
function getRipgrepPath() {
  if (cachedRgPath !== undefined) return cachedRgPath;
  const candidates = ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', 'rg'];
  for (const cand of candidates) {
    try {
      if (cand.startsWith('/') && fs.existsSync(cand)) {
        cachedRgPath = cand;
        return cachedRgPath;
      }
    } catch {}
  }
  cachedRgPath = 'rg';
  return cachedRgPath;
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svgz',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z',
  '.exe', '.bin', '.dll', '.dylib', '.so', '.a', '.o',
  '.pyc', '.class', '.jar', '.wasm', '.mov', '.mp4', '.mp3',
  '.sqlite', '.sqlite3', '.db', '.DS_Store', '.woff', '.woff2', '.ttf'
]);

export class ProjectController {
  constructor(
    permissionGuard,
    auditLogger,
    concurrencyManager = new ConcurrencyManager(),
    fileActivityManager = null,
    cacheManager = new CacheManager(),
    gitController = null
  ) {
    this.guard = permissionGuard;
    this.logger = auditLogger;
    this.concurrency = concurrencyManager;
    this.fileActivity = fileActivityManager;
    this.cache = cacheManager;
    this.git = gitController;
  }

  isBinaryFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
  }

  otherActivity(resolved, agentId) {
    if (!this.fileActivity) return [];
    return this.fileActivity.get(resolved)
      .filter(a => a.agent_id !== agentId)
      .map(a => ({ agentId: a.agent_id, activityType: a.activity_type, lastSeen: a.last_seen, description: a.description }));
  }

  async inspectProject(rootPath, agentId, options = {}) {
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
      if (file.name === 'node_modules' || file.name === '.build' || file.name === '.cache') continue;
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

  async readFile(filePath, agentId, startLine = 1, endLine = 100, compact = false, knownHash = null) {
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

    if (this.isBinaryFile(resolved)) {
      throw new Error(`Cannot read binary file '${path.basename(resolved)}' as text.`);
    }

    this.fileActivity?.start({ filePath: resolved, agentId, activityType: 'reading' });

    // Include a cheap filesystem signature so external edits cannot return stale
    // cached content. Bridge-originated writes still invalidate immediately.
    const fileStat = fs.statSync(resolved);
    const cacheKey = `read_${resolved}_${fileStat.size}_${fileStat.mtimeMs}_${startLine}_${endLine}_${compact}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.fileActivity?.stop({ filePath: resolved, agentId, activityType: 'reading' });
      if (knownHash && cached.fileHash === knownHash) {
        return { filePath: resolved, unchanged: true, fileHash: cached.fileHash };
      }
      return cached;
    }

    if (knownHash) {
      const currentHash = this.concurrency.computeFileHash(resolved);
      if (currentHash === knownHash) {
        this.fileActivity?.stop({ filePath: resolved, agentId, activityType: 'reading' });
        return { filePath: resolved, unchanged: true, fileHash: currentHash };
      }
    }

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

    const result = compact ? {
      filePath: resolved,
      lineRange: [s, e],
      totalLines,
      fileHash,
      content: numbered
    } : {
      filePath: resolved,
      startLine: s,
      endLine: e,
      totalLines,
      fileHash,
      content: numbered,
      otherActivity: this.otherActivity(resolved, agentId)
    };

    this.cache.set(cacheKey, result, resolved);
    return result;
  }

  async searchFiles(rootPath, agentId, query, isRegex = false, maxResults = 20, extensions = null, filePattern = null) {
    const t0 = Date.now();
    const permCheck = this.guard.checkPermission(agentId, 'SEARCH');
    if (!permCheck.allowed) throw new Error(permCheck.reason);

    const pathCheck = this.guard.validatePathAccess(rootPath, 'READ');
    if (!pathCheck.allowed) {
      this.logger.log({ agentId, action: 'search_files', targetPath: rootPath, status: 'denied', details: pathCheck.reason });
      throw new Error(pathCheck.reason);
    }

    const resolved = pathCheck.path;
    const cacheKey = `search_${resolved}_${query}_${isRegex}_${maxResults}_${extensions}_${filePattern}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const limit = Math.min(maxResults || 20, 100);
    const results = [];

    // Attempt ripgrep acceleration first for sub-5ms repository search
    const rgPath = getRipgrepPath();
    let usedRipgrep = false;
    if (rgPath && typeof query === 'string' && query.length > 0) {
      try {
        const rgArgs = [
          '--line-number',
          '--no-heading',
          '--color=never',
          '--max-columns=120',
          '--max-columns-preview',
          '-m', String(limit)
        ];
        if (!isRegex) {
          rgArgs.push('-F');
        }
        rgArgs.push('-e', query);

        if (Array.isArray(extensions) && extensions.length > 0) {
          for (const ext of extensions) {
            const clean = ext.startsWith('.') ? `*${ext}` : `*.${ext}`;
            rgArgs.push('-g', clean);
          }
        }
        if (filePattern && typeof filePattern === 'string') {
          rgArgs.push('-g', filePattern);
        }

        // Standard exclusions
        rgArgs.push(
          '-g', '!node_modules/**',
          '-g', '!.git/**',
          '-g', '!.build/**',
          '-g', '!.cache/**',
          '-g', '!.next/**',
          '-g', '!dist/**',
          '-g', '!data/**'
        );

        rgArgs.push(resolved);

        const { stdout } = await execFileAsync(rgPath, rgArgs, {
          timeout: 4000,
          maxBuffer: 4 * 1024 * 1024
        });

        const lines = stdout.split('\n').filter(Boolean);
        for (const line of lines) {
          if (results.length >= limit) break;
          const match = line.match(/^([^:]+):(\d+):(.*)$/);
          if (match) {
            const file = match[1];
            const lineNumber = parseInt(match[2], 10);
            const lineContent = match[3].trim();
            const snippet = lineContent.length > 120 ? lineContent.slice(0, 120) + '...' : lineContent;
            results.push({
              file,
              lineNumber,
              line: snippet
            });
          }
        }
        usedRipgrep = true;
      } catch (rgErr) {
        if (rgErr.code === 1) {
          // ripgrep exit code 1 means 0 matches found successfully
          usedRipgrep = true;
        } else {
          // Fall back to pure JS traversal on any binary or execution error
          usedRipgrep = false;
        }
      }
    }

    if (!usedRipgrep) {
      const matcher = isRegex ? new RegExp(query, 'i') : null;
      const allowedExts = Array.isArray(extensions) ? new Set(extensions.map(e => e.toLowerCase())) : null;

      const walk = (dir) => {
        if (results.length >= limit) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          if (results.length >= limit) return;
          if (
            entry.name.startsWith('.git') ||
            entry.name === 'node_modules' ||
            entry.name === '.build' ||
            entry.name === '.cache' ||
            entry.name === '.next' ||
            entry.name === 'dist' ||
            entry.name === 'data'
          ) continue;

          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (allowedExts && !allowedExts.has(ext)) continue;
            if (this.isBinaryFile(full)) continue;

            try {
              const data = fs.readFileSync(full, 'utf8');
              const lines = data.split('\n');
              for (let idx = 0; idx < lines.length; idx++) {
                if (results.length >= limit) break;
                const line = lines[idx];
                const matches = isRegex ? matcher.test(line) : line.includes(query);
                if (matches) {
                  const trimmed = line.trim();
                  const snippet = trimmed.length > 120 ? trimmed.slice(0, 120) + '...' : trimmed;
                  results.push({
                    file: full,
                    lineNumber: idx + 1,
                    line: snippet
                  });
                }
              }
            } catch {}
          }
        }
      };

      walk(resolved);
    }

    this.logger.log({
      agentId,
      action: 'search_files',
      targetPath: resolved,
      status: 'allowed',
      executionMs: Date.now() - t0,
      details: { query, resultsCount: results.length, usedRipgrep }
    });

    const res = {
      rootPath: resolved,
      query,
      count: results.length,
      capped: results.length >= limit,
      results,
      accelerator: usedRipgrep ? 'ripgrep' : 'javascript_walk',
      executionMs: Date.now() - t0
    };

    this.cache.set(cacheKey, res, resolved, 10000);
    return res;
  }

  async checkSyntax(filePath, agentId) {
    const t0 = Date.now();
    const permCheck = this.guard.checkPermission(agentId, 'READ');
    if (!permCheck.allowed) throw new Error(permCheck.reason);

    const pathCheck = this.guard.validatePathAccess(filePath, 'READ');
    if (!pathCheck.allowed) {
      this.logger.log({ agentId, action: 'check_syntax', targetPath: filePath, status: 'denied', details: pathCheck.reason });
      throw new Error(pathCheck.reason);
    }

    const resolved = pathCheck.path;
    if (!fs.existsSync(resolved)) {
      throw new Error(`File '${resolved}' does not exist.`);
    }

    const ext = path.extname(resolved).toLowerCase();
    let valid = true;
    let syntaxError = null;

    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      try {
        await execFileAsync(process.execPath, ['--check', resolved], { timeout: 5000 });
      } catch (err) {
        valid = false;
        syntaxError = (err.stderr || err.message || '').trim();
      }
    } else if (ext === '.json') {
      try {
        const raw = fs.readFileSync(resolved, 'utf8');
        JSON.parse(raw);
      } catch (err) {
        valid = false;
        syntaxError = err.message;
      }
    } else if (ext === '.py') {
      try {
        await execFileAsync('python3', ['-m', 'py_compile', resolved], { timeout: 5000 });
      } catch (err) {
        valid = false;
        syntaxError = (err.stderr || err.message || '').trim();
      }
    } else {
      return {
        filePath: resolved,
        supported: false,
        message: `Syntax validation not implemented for extension '${ext}'`
      };
    }

    this.logger.log({
      agentId,
      action: 'check_syntax',
      targetPath: resolved,
      status: valid ? 'valid' : 'invalid',
      executionMs: Date.now() - t0,
      details: { valid, error: syntaxError }
    });

    return {
      filePath: resolved,
      supported: true,
      valid,
      error: syntaxError,
      executionMs: Date.now() - t0
    };
  }

  async extractData(filePath, agentId, options = {}) {
    const t0 = Date.now();
    const permCheck = this.guard.checkPermission(agentId, 'READ');
    if (!permCheck.allowed) throw new Error(permCheck.reason);

    const pathCheck = this.guard.validatePathAccess(filePath, 'READ');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    const resolved = pathCheck.path;
    if (!fs.existsSync(resolved)) throw new Error(`File '${resolved}' does not exist.`);

    const ext = path.extname(resolved).toLowerCase();
    const raw = fs.readFileSync(resolved, 'utf8');
    const maxEntries = Math.min(options.limit || 50, 200);

    let extracted = null;
    let format = ext.replace('.', '');

    if (ext === '.json') {
      try {
        const parsed = JSON.parse(raw);
        if (options.jsonPath) {
          const parts = options.jsonPath.split('.');
          let cur = parsed;
          for (const p of parts) {
            if (cur && typeof cur === 'object') cur = cur[p];
            else { cur = undefined; break; }
          }
          extracted = cur;
        } else if (Array.isArray(parsed)) {
          extracted = { total: parsed.length, sample: parsed.slice(0, maxEntries) };
        } else if (typeof parsed === 'object' && parsed !== null) {
          extracted = { keys: Object.keys(parsed), sample: Object.fromEntries(Object.entries(parsed).slice(0, maxEntries)) };
        } else {
          extracted = parsed;
        }
      } catch (err) {
        throw new Error(`JSON parse error: ${err.message}`);
      }
    } else if (ext === '.csv') {
      const lines = raw.split(/\r?\n/).filter(Boolean);
      if (lines.length > 0) {
        const header = lines[0].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
        const rows = [];
        for (let i = 1; i < Math.min(lines.length, maxEntries + 1); i++) {
          const cols = lines[i].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
          const rowObj = {};
          header.forEach((h, idx) => { rowObj[h || `col_${idx}`] = cols[idx] !== undefined ? cols[idx] : null; });
          rows.push(rowObj);
        }
        extracted = { headers: header, totalRows: lines.length - 1, sampleRows: rows };
      }
    } else if (ext === '.md' || ext === '.markdown') {
      const lines = raw.split('\n');
      const headings = [];
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
        if (match) {
          headings.push({ level: match[1].length, text: match[2].trim(), line: i + 1 });
        }
      }
      extracted = { headings, totalHeadings: headings.length };
    } else {
      throw new Error(`Unsupported extract format for '${ext}'. Supported: .json, .csv, .md`);
    }

    return {
      filePath: resolved,
      format,
      data: extracted,
      executionMs: Date.now() - t0
    };
  }

  async findSymbol(rootPath, agentId, symbol, maxResults = 20) {
    if (!symbol || typeof symbol !== 'string') throw new Error('symbol is required.');
    const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(String.raw`(?:export\s+)?(?:async\s+)?function\s+${escapedSymbol}\b`),
      new RegExp(String.raw`(?:export\s+)?class\s+${escapedSymbol}\b`),
      new RegExp(String.raw`(?:export\s+)?(?:const|let|var)\s+${escapedSymbol}\s*=`),
      new RegExp(String.raw`(?:def|class)\s+${escapedSymbol}\b`),
      new RegExp(String.raw`(?:func|class|struct|enum|protocol)\s+${escapedSymbol}\b`)
    ];
    const searchResults = await this.searchFiles(rootPath, agentId, symbol, false, Math.min(maxResults, 100));
    const results = [];
    for (const hit of searchResults.results) {
      if (patterns.some(pattern => pattern.test(hit.line))) {
        results.push({ file: hit.file, lineNumber: hit.lineNumber, line: hit.line });
      }
      if (results.length >= maxResults) break;
    }
    return { symbol, count: results.length, results };
  }

  async readSymbol(filePath, agentId, symbol, contextLines = 2, maxLines = 120) {
    const found = await this.findSymbol(path.dirname(filePath), agentId, symbol, 100);
    const match = found.results.find(r => path.resolve(r.file) === path.resolve(filePath));
    if (!match) throw new Error(`Symbol '${symbol}' not found in '${filePath}'.`);
    const start = Math.max(1, match.lineNumber - contextLines);
    const end = Math.min(start + Math.max(1, maxLines) - 1, match.lineNumber + maxLines);
    const result = await this.readFile(filePath, agentId, start, end, true);
    return { symbol, ...result };
  }

  async buildContext(rootPath, agentId, query = null, maxResults = 8) {
    const root = rootPath || this.guard.config.BRIDGE_ROOT;
    const snapshot = await this.projectSnapshot(root, agentId);
    let search = null;
    if (query) {
      search = await this.searchFiles(root, agentId, query, false, Math.min(maxResults, 20));
    }
    return {
      root: snapshot.root,
      git: snapshot.git,
      structure: snapshot.structure,
      query: query || null,
      relevant: search ? search.results.slice(0, maxResults) : [],
      generatedAt: new Date().toISOString()
    };
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

      // Atomic write using temp file and rename
      const tempPath = path.join(dir, `.tmp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
      fs.writeFileSync(tempPath, content, 'utf8');
      fs.renameSync(tempPath, resolved);

      const newHash = this.concurrency.computeFileHash(resolved);
      this.cache.invalidatePath(resolved);

      this.logger.log({
        agentId,
        action: 'create_file',
        targetPath: resolved,
        status: 'allowed',
        executionMs: Date.now() - t0,
        details: { bytesWritten: Buffer.byteLength(content, 'utf8'), overwrite, fileHash: newHash }
      });

      return {
        filePath: resolved,
        bytesWritten: Buffer.byteLength(content, 'utf8'),
        fileHash: newHash,
        status: 'created'
      };
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

    this.fileActivity?.start({ filePath: resolved, agentId, activityType: 'editing' });
    const lock = this.concurrency.acquireLock(resolved, agentId);
    if (!lock.acquired) {
      throw new Error(`Cannot edit file: ${lock.reason}`);
    }

    try {
      const buf = fs.readFileSync(resolved);
      const current = buf.toString('utf8');

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

      // Atomic write via temp file
      const dir = path.dirname(resolved);
      const tempPath = path.join(dir, `.tmp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
      fs.writeFileSync(tempPath, updated, 'utf8');
      fs.renameSync(tempPath, resolved);

      const newHash = this.concurrency.computeFileHash(resolved);
      this.cache.invalidatePath(resolved);

      this.logger.log({
        agentId,
        action: 'edit_file',
        targetPath: resolved,
        status: 'allowed',
        executionMs: Date.now() - t0,
        details: { replacedBytes: targetContent.length, newBytes: replacementContent.length, fileHash: newHash }
      });

      return {
        filePath: resolved,
        fileHash: newHash,
        status: 'edited',
        otherActivity: this.otherActivity(resolved, agentId)
      };
    } finally {
      this.concurrency.releaseLock(resolved, agentId);
      this.fileActivity?.stop({ filePath: resolved, agentId, activityType: 'editing' });
    }
  }

  /**
   * Atomic patch operation with expectedHash and conflict detection.
   * Returns minimal compact content.
   */
  async applyPatch(filePath, agentId, patch, expectedHash = null) {
    const t0 = Date.now();
    const permCheck = this.guard.checkPermission(agentId, 'EDIT');
    if (!permCheck.allowed) throw new Error(permCheck.reason);

    const pathCheck = this.guard.validatePathAccess(filePath, 'EDIT');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    const resolved = pathCheck.path;
    if (!fs.existsSync(resolved)) {
      throw new Error(`File '${resolved}' does not exist.`);
    }

    const lock = this.concurrency.acquireLock(resolved, agentId);
    if (!lock.acquired) throw new Error(lock.reason);

    try {
      const currentBuf = fs.readFileSync(resolved);
      const currentContent = currentBuf.toString('utf8');
      const currentHash = crypto.createHash('sha256').update(currentBuf).digest('hex');

      // Conflict detection against expectedHash
      if (expectedHash && currentHash !== expectedHash) {
        const conflictRes = {
          status: 'conflict',
          conflict: true,
          filePath: resolved,
          expectedHash,
          currentHash,
          message: `ConflictDetected: file was modified concurrently. Expected ${expectedHash}, found ${currentHash}.`
        };
        this.logger.log({
          agentId,
          action: 'apply_patch',
          targetPath: resolved,
          status: 'conflict',
          details: conflictRes
        });
        return conflictRes;
      }

      let updatedContent = currentContent;

      if (typeof patch === 'object' && patch !== null) {
        if (patch.targetContent && patch.replacementContent !== undefined) {
          if (!currentContent.includes(patch.targetContent)) {
            throw new Error(`Target content not found in '${resolved}'.`);
          }
          updatedContent = currentContent.replace(patch.targetContent, patch.replacementContent);
        } else if (patch.newContent !== undefined) {
          updatedContent = patch.newContent;
        } else {
          throw new Error(`Invalid patch payload: expected targetContent/replacementContent or newContent.`);
        }
      } else if (typeof patch === 'string') {
        updatedContent = patch;
      } else {
        throw new Error('Patch argument must be an object or string.');
      }

      // Atomic write via temp file
      const dir = path.dirname(resolved);
      const tempPath = path.join(dir, `.tmp_patch_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
      fs.writeFileSync(tempPath, updatedContent, 'utf8');
      fs.renameSync(tempPath, resolved);

      const newHash = this.concurrency.computeFileHash(resolved);
      this.cache.invalidatePath(resolved);

      const result = {
        status: 'applied',
        conflict: false,
        filePath: resolved,
        newHash,
        bytesWritten: Buffer.byteLength(updatedContent, 'utf8')
      };

      this.logger.log({
        agentId,
        action: 'apply_patch',
        targetPath: resolved,
        status: 'success',
        executionMs: Date.now() - t0,
        details: { newHash, bytesWritten: result.bytesWritten }
      });

      return result;
    } finally {
      this.concurrency.releaseLock(resolved, agentId);
    }
  }

  async batchRead(files, agentId, compact = true) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('files must be a non-empty array of file read requests.');
    }
    const items = files.slice(0, 50);
    // Reads are independent. Run them concurrently to remove N-serial filesystem
    // round trips while preserving input order and per-file error isolation.
    const results = await Promise.all(items.map(async (item) => {
      const filePath = typeof item === 'string' ? item : item.filePath;
      const startLine = typeof item === 'object' && item.startLine ? item.startLine : 1;
      const endLine = typeof item === 'object' && item.endLine ? item.endLine : 100;

      try {
        const readRes = await this.readFile(filePath, agentId, startLine, endLine, compact);
        return { ...readRes, success: true };
      } catch (err) {
        return { filePath, success: false, error: err.message };
      }
    }));
    return { count: results.length, results };
  }

  async batchWrite(files, agentId) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('files must be a non-empty array of file write requests.');
    }
    const results = [];
    for (const item of files.slice(0, 50)) {
      const { filePath, content, expectedHash = null, overwrite = true } = item;
      try {
        if (expectedHash) {
          const patchRes = await this.applyPatch(filePath, agentId, { newContent: content }, expectedHash);
          results.push(patchRes);
        } else {
          const createRes = await this.createFile(filePath, agentId, content, overwrite);
          results.push({ status: 'created', ...createRes });
        }
      } catch (err) {
        results.push({ filePath, status: 'error', error: err.message });
      }
    }
    return { count: results.length, results };
  }

  async batchStat(paths, agentId) {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error('paths must be a non-empty array of file paths.');
    }
    const results = [];
    for (const p of paths.slice(0, 100)) {
      try {
        const pathCheck = this.guard.validatePathAccess(p, 'READ');
        if (!pathCheck.allowed) {
          results.push({ path: p, exists: false, error: pathCheck.reason });
          continue;
        }
        const resolved = pathCheck.path;
        if (!fs.existsSync(resolved)) {
          results.push({ path: resolved, exists: false });
          continue;
        }
        const stat = fs.statSync(resolved);
        results.push({
          path: resolved,
          exists: true,
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          fileHash: stat.isFile() ? this.concurrency.computeFileHash(resolved) : null
        });
      } catch (err) {
        results.push({ path: p, exists: false, error: err.message });
      }
    }
    return { count: results.length, items: results };
  }

  async projectSnapshot(rootPath, agentId) {
    const t0 = Date.now();
    const permCheck = this.guard.checkPermission(agentId, 'READ');
    if (!permCheck.allowed) throw new Error(permCheck.reason);

    const targetDir = rootPath || this.guard.config.BRIDGE_ROOT;
    const pathCheck = this.guard.validatePathAccess(targetDir, 'READ');
    if (!pathCheck.allowed) throw new Error(pathCheck.reason);

    const resolved = pathCheck.path;
    const cacheKey = `snapshot_${resolved}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    // Structure
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const directories = [];
    const keyFiles = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.git') && entry.name !== '.gitignore') continue;
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) {
        directories.push(entry.name);
      } else if (entry.isFile()) {
        if (['package.json', 'README.md', 'Package.swift', 'tsconfig.json'].includes(entry.name) || entry.name.endsWith('.js') || entry.name.endsWith('.json')) {
          keyFiles.push(entry.name);
        }
      }
    }

    // Git Status
    let gitInfo = null;
    if (this.git) {
      try {
        const gitStatus = await this.git.getStatus(resolved, agentId);
        gitInfo = {
          branch: gitStatus.branch,
          isClean: gitStatus.isClean,
          stagedCount: gitStatus.stagedCount,
          unstagedCount: gitStatus.unstagedCount,
          untrackedCount: gitStatus.untrackedCount,
          changedFiles: gitStatus.changedFiles || []
        };
      } catch {}
    }

    const snapshot = {
      root: resolved,
      timestamp: new Date().toISOString(),
      git: gitInfo,
      structure: {
        totalEntries: entries.length,
        directories,
        keyFiles: keyFiles.slice(0, 15)
      }
    };

    this.cache.set(cacheKey, snapshot, resolved, 15000);

    this.logger.log({
      agentId,
      action: 'project_snapshot',
      targetPath: resolved,
      status: 'allowed',
      executionMs: Date.now() - t0,
      details: { branch: gitInfo?.branch, directoriesCount: directories.length }
    });

    return snapshot;
  }

  async testPlan(rootPath, agentId) {
    const root = rootPath || this.guard.config.BRIDGE_ROOT;
    let status = { changedFiles: [] };
    if (this.git) {
      try { status = await this.git.getStatus(root, agentId, false); } catch {}
    }
    const testDir = path.join(root, 'tests');
    const available = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && /\.(test|spec)\.(js|mjs|cjs|ts|tsx)$/.test(entry.name)) available.push(path.relative(root, full));
      }
    };
    walk(testDir);

    const changed = status.changedFiles || [];
    const selected = new Set();
    for (const file of changed) {
      const base = path.basename(file).replace(/\.[^.]+$/, '').toLowerCase();
      for (const test of available) {
        const testBase = path.basename(test).toLowerCase();
        if (testBase.includes(base) || base.includes(testBase.replace(/\.(test|spec)\.[^.]+$/, ''))) selected.add(test);
      }
    }
    const tests = selected.size ? [...selected].slice(0, 20) : available.slice(0, 20);
    return {
      root,
      changedFiles: changed.slice(0, 20),
      selectedTests: tests,
      fallbackToFullSuite: selected.size === 0,
      command: tests.length && !selected.size ? 'npm test' : (tests.length ? `node --test ${tests.join(' ')}` : 'npm test')
    };
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
      this.cache.invalidatePath(resolved);
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
        stderr: stderr.trim(),
        timedOut: false,
        isError: false
      };
    } catch (err) {
      // A timeout or non-zero exit is a real failure. Surface it as such instead
      // of returning a normal-shaped result the client would read as success.
      const timedOut = err.killed === true || err.signal != null || err.code === 'ETIMEDOUT'
        || /timed out/i.test(err.message || '');
      const exitCode = typeof err.code === 'number' ? err.code : (timedOut ? 124 : 1);

      this.logger.log({
        agentId,
        action: 'execute_command',
        command: cmdCheck.command,
        status: 'failed',
        executionMs: Date.now() - t0,
        details: { exitCode, timedOut, error: err.message }
      });

      return {
        command: cmdCheck.command,
        exitCode,
        stdout: String(err.stdout || '').trim(),
        stderr: String(err.stderr || err.message || '').trim(),
        timedOut,
        timeoutMs: timedOut ? timeoutMs : undefined,
        isError: true,
        error: timedOut
          ? `Command timed out after ${timeoutMs}ms: ${cmdCheck.command}`
          : `Command exited with code ${exitCode}: ${cmdCheck.command}`
      };
    }
  }
}
