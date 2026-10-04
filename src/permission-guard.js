import path from 'node:path';
import fs from 'node:fs';
import { CONFIG } from './config.js';

export class PermissionGuard {
  constructor(config = CONFIG) {
    this.config = config;

    // Resolve allowed roots once, following symlinks, so containment checks are
    // performed against the real filesystem location rather than a lexical path.
    // Falls back to the lexical path when a root does not yet exist.
    this.realAllowedRoots = (this.config.ALLOWED_ROOTS || []).map(root => {
      try {
        return fs.realpathSync(root);
      } catch {
        return path.resolve(root);
      }
    });

    // Granular per-agent policies: autonomous git push authorized
    this.agentPolicies = {
      'chatgpt-desktop': {
        allowedPermissions: ['READ', 'SEARCH', 'WRITE', 'CREATE', 'EDIT', 'DELETE', 'EXECUTE', 'GIT_READ', 'GIT_WRITE', 'PUSH', 'MESSAGE', 'DELEGATE'],
        requiresHumanApproval: ['DESTRUCTIVE', 'MERGE', 'NETWORK']
      },
      'claude-desktop': {
        allowedPermissions: ['READ', 'SEARCH', 'WRITE', 'CREATE', 'EDIT', 'DELETE', 'EXECUTE', 'GIT_READ', 'GIT_WRITE', 'PUSH', 'MESSAGE', 'DELEGATE'],
        requiresHumanApproval: ['DESTRUCTIVE', 'MERGE', 'NETWORK']
      },
      'antigravity-ide': {
        allowedPermissions: ['READ', 'SEARCH', 'WRITE', 'CREATE', 'EDIT', 'DELETE', 'EXECUTE', 'GIT_READ', 'GIT_WRITE', 'PUSH', 'MESSAGE', 'DELEGATE'],
        requiresHumanApproval: ['DESTRUCTIVE', 'MERGE']
      },
      'freebuff': {
        allowedPermissions: ['READ', 'SEARCH', 'WRITE', 'CREATE', 'EDIT', 'DELETE', 'EXECUTE', 'GIT_READ', 'GIT_WRITE', 'PUSH', 'MESSAGE', 'DELEGATE'],
        requiresHumanApproval: ['DESTRUCTIVE', 'MERGE']
      },
      'system': {
        allowedPermissions: ['READ', 'SEARCH', 'WRITE', 'CREATE', 'EDIT', 'DELETE', 'EXECUTE', 'GIT_READ', 'GIT_WRITE', 'MESSAGE', 'DELEGATE', 'DESTRUCTIVE', 'PUSH'],
        requiresHumanApproval: []
      }
    };
  }

  validateAgent(agentId) {
    if (!agentId || typeof agentId !== 'string') {
      return { allowed: false, reason: 'Invalid or missing agent identity.' };
    }
    const normalized = agentId.trim().toLowerCase();
    if (!this.config.AGENT_IDENTITIES.includes(normalized)) {
      return { allowed: false, reason: `Unknown agent identity '${agentId}'. Allowed: ${this.config.AGENT_IDENTITIES.join(', ')}` };
    }
    return { allowed: true, agentId: normalized };
  }

  checkPermission(agentId, permission) {
    const agentCheck = this.validateAgent(agentId);
    if (!agentCheck.allowed) return agentCheck;

    const policy = this.agentPolicies[agentCheck.agentId];
    if (!policy) {
      return { allowed: false, reason: `No security policy defined for agent '${agentId}'` };
    }

    if (policy.requiresHumanApproval.includes(permission)) {
      return {
        allowed: false,
        requiresApproval: true,
        reason: `Operation requires '${permission}' permission which is gated for agent '${agentId}' and requires explicit human approval.`
      };
    }

    if (!policy.allowedPermissions.includes(permission)) {
      return {
        allowed: false,
        reason: `Permission '${permission}' is not granted to agent '${agentId}'.`
      };
    }

    return { allowed: true };
  }

  /**
   * Resolve the canonical filesystem location of a path for authorization.
   *
   * A lexical `path.resolve()` is not sufficient: a symlink placed inside an
   * allowed root can point at `/etc/passwd`, so the checked path and the file
   * actually read/written differ. This resolves symlinks (including dangling
   * leaf symlinks and missing-leaf paths) so containment is proven on the real
   * target. Fails closed (throws) when the location cannot be proven.
   */
  resolveRealPath(targetPath, depth = 0) {
    if (depth > 40) {
      throw new Error('Symlink loop detected while resolving path.');
    }

    const resolved = path.resolve(targetPath);

    try {
      return fs.realpathSync(resolved);
    } catch (err) {
      if (err.code === 'ELOOP') {
        throw new Error('Symlink loop detected while resolving path.');
      }
    }

    // Leaf may be a dangling symlink (existsSync/realpath follow it and fail).
    // Resolve the link target explicitly so writes cannot be redirected outside.
    try {
      const stat = fs.lstatSync(resolved);
      if (stat.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(resolved);
        const absoluteTarget = path.isAbsolute(linkTarget)
          ? linkTarget
          : path.resolve(path.dirname(resolved), linkTarget);
        return this.resolveRealPath(absoluteTarget, depth + 1);
      }
    } catch (err) {
      if (err.code === 'ELOOP') {
        throw new Error('Symlink loop detected while resolving path.');
      }
      // Leaf does not exist yet: fall through to ancestor resolution.
    }

    // Leaf does not exist: resolve the nearest existing ancestor and re-append
    // the not-yet-created suffix. Any ancestor that is a symlink is resolved by
    // the realpathSync call on that ancestor.
    const suffix = [];
    let cursor = resolved;
    while (true) {
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
      try {
        fs.lstatSync(cursor);
        break;
      } catch {
        continue;
      }
    }

    const realParent = fs.realpathSync(cursor);
    return suffix.length ? path.join(realParent, ...suffix) : realParent;
  }

  validatePathAccess(targetPath, mode = 'READ') {
    if (!targetPath) {
      return { allowed: false, reason: 'Target path is empty.' };
    }

    const resolved = path.resolve(targetPath);

    // Resolve the real target first. If we cannot prove where the path points,
    // deny rather than fall back to an unchecked lexical path.
    let realResolved;
    try {
      realResolved = this.resolveRealPath(resolved);
    } catch (err) {
      return {
        allowed: false,
        reason: `Path '${resolved}' could not be safely resolved (${err.message}).`
      };
    }

    // 1. Check if path matches any forbidden pattern (secrets, credentials, etc.)
    for (const pattern of this.config.FORBIDDEN_PATH_PATTERNS) {
      if (pattern.test(resolved) || pattern.test(realResolved)) {
        return {
          allowed: false,
          reason: `Access to protected path '${resolved}' is forbidden by security policy (matches ${pattern}).`
        };
      }
    }

    // 2. Check if within allowed roots (on the real, symlink-resolved location)
    const inAllowedRoot = this.realAllowedRoots.some(root => {
      return realResolved === root || realResolved.startsWith(root + path.sep);
    });

    if (!inAllowedRoot) {
      const escaped = realResolved !== resolved;
      return {
        allowed: false,
        reason: escaped
          ? `Path '${resolved}' resolves to '${realResolved}', which is outside allowed roots: ${this.config.ALLOWED_ROOTS.join(', ')}`
          : `Path '${realResolved}' is outside allowed roots: ${this.config.ALLOWED_ROOTS.join(', ')}`
      };
    }

    // 3. Check protected files on mutating operations
    if (['WRITE', 'CREATE', 'EDIT', 'DELETE'].includes(mode)) {
      const baseName = path.basename(resolved);
      if (this.config.PROTECTED_FILES.includes(baseName)) {
        return {
          allowed: false,
          reason: `File '${baseName}' is on the protected files list and cannot be modified.`
        };
      }

      // Check Zia write lock
      const ziaRoot = path.resolve(this.config.ZIA_ROOT);
      if (this.config.ZIA_WRITE_LOCKED && (resolved === ziaRoot || resolved.startsWith(ziaRoot + path.sep))) {
        return {
          allowed: false,
          reason: `Zia main working tree is currently WRITE-LOCKED to protect ongoing Freebuff stabilization work.`
        };
      }
    }

    return { allowed: true, path: realResolved };
  }

  /**
   * Detects shell syntax that could chain, substitute, redirect, or expand into
   * execution of a non-whitelisted program. `exec()` runs the whole line through
   * a shell, so checking only the first token is not sufficient: for example
   * `echo hi; touch /tmp/x` would otherwise run `touch`.
   *
   * Operators are only rejected when they appear OUTSIDE quotes, so literal text
   * such as `echo "a; b"` or `node -e "a;b"` remains valid. Command substitution
   * and backticks are rejected inside double quotes too, because they expand there.
   *
   * Returns a human-readable reason when unsafe syntax is found, else null.
   */
  detectUnsafeShellSyntax(commandLine) {
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < commandLine.length; i++) {
      const ch = commandLine[i];
      const next = commandLine[i + 1];

      if (inSingle) {
        if (ch === "'") inSingle = false;
        continue;
      }

      if (inDouble) {
        if (ch === '\\') { i++; continue; }
        if (ch === '"') { inDouble = false; continue; }
        if (ch === '`') return 'command substitution (backtick) inside quotes';
        if (ch === '$' && next === '(') return 'command substitution $(...) inside quotes';
        if (ch === '$' && next === '{') return 'parameter expansion ${...} inside quotes';
        continue;
      }

      if (ch === "'") { inSingle = true; continue; }
      if (ch === '"') { inDouble = true; continue; }
      if (ch === '\\') return 'backslash escaping outside quotes';
      if (ch === '`') return 'command substitution (backtick)';
      if (ch === '$') return 'variable/command expansion ($)';
      if (';&|<>'.includes(ch)) return `shell control operator '${ch}'`;
      if (ch === '\n' || ch === '\r') return 'newline';
    }

    if (inSingle || inDouble) return 'unterminated quote';
    return null;
  }

  validateCommand(commandLine, cwd) {
    if (!commandLine || typeof commandLine !== 'string') {
      return { allowed: false, reason: 'Empty command line.' };
    }

    const trimmed = commandLine.trim();

    // 1. Check dangerous patterns
    for (const pattern of this.config.DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          allowed: false,
          reason: `Command blocked: contains dangerous pattern (${pattern}).`
        };
      }
    }

    // 2. Reject shell operators that could chain/substitute/redirect into a
    //    non-whitelisted program (the whitelist only names the first token).
    const unsafe = this.detectUnsafeShellSyntax(trimmed);
    if (unsafe) {
      return {
        allowed: false,
        reason: `Command blocked: ${unsafe}. Shell chaining/substitution/redirection is not permitted.`
      };
    }

    // 3. Check executable name
    const firstToken = trimmed.split(/\s+/)[0];
    const execBase = path.basename(firstToken);

    if (!this.config.SAFE_COMMANDS.includes(execBase)) {
      return {
        allowed: false,
        reason: `Command executable '${execBase}' is not in the safe whitelist (${this.config.SAFE_COMMANDS.join(', ')}).`
      };
    }

    // 4. Check CWD safety
    if (cwd) {
      const pathCheck = this.validatePathAccess(cwd, 'READ');
      if (!pathCheck.allowed) {
        return { allowed: false, reason: `Command working directory disallowed: ${pathCheck.reason}` };
      }
    }

    return { allowed: true, command: trimmed };
  }
}
