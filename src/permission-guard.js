import path from 'node:path';
import { CONFIG } from './config.js';

export class PermissionGuard {
  constructor(config = CONFIG) {
    this.config = config;

    // Granular per-agent policies
    this.agentPolicies = {
      'chatgpt-desktop': {
        allowedPermissions: ['READ', 'SEARCH', 'WRITE', 'CREATE', 'EDIT', 'DELETE', 'EXECUTE', 'GIT_READ', 'MESSAGE', 'DELEGATE'],
        requiresHumanApproval: ['DESTRUCTIVE', 'PUSH', 'MERGE', 'NETWORK']
      },
      'claude-desktop': {
        allowedPermissions: ['READ', 'SEARCH', 'WRITE', 'CREATE', 'EDIT', 'DELETE', 'EXECUTE', 'GIT_READ', 'MESSAGE', 'DELEGATE'],
        requiresHumanApproval: ['DESTRUCTIVE', 'PUSH', 'MERGE', 'NETWORK']
      },
      'antigravity-ide': {
        allowedPermissions: ['READ', 'SEARCH', 'WRITE', 'CREATE', 'EDIT', 'DELETE', 'EXECUTE', 'GIT_READ', 'GIT_WRITE', 'MESSAGE', 'DELEGATE'],
        requiresHumanApproval: ['DESTRUCTIVE', 'PUSH', 'MERGE']
      },
      'freebuff': {
        allowedPermissions: ['READ', 'SEARCH', 'WRITE', 'CREATE', 'EDIT', 'DELETE', 'EXECUTE', 'GIT_READ', 'GIT_WRITE', 'MESSAGE', 'DELEGATE'],
        requiresHumanApproval: ['DESTRUCTIVE', 'PUSH', 'MERGE']
      },
      'system': {
        allowedPermissions: ['READ', 'SEARCH', 'WRITE', 'CREATE', 'EDIT', 'DELETE', 'EXECUTE', 'GIT_READ', 'GIT_WRITE', 'MESSAGE', 'DELEGATE', 'DESTRUCTIVE'],
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

  validatePathAccess(targetPath, mode = 'READ') {
    if (!targetPath) {
      return { allowed: false, reason: 'Target path is empty.' };
    }

    const resolved = path.resolve(targetPath);

    // 1. Check if path matches any forbidden pattern (secrets, credentials, etc.)
    for (const pattern of this.config.FORBIDDEN_PATH_PATTERNS) {
      if (pattern.test(resolved)) {
        return {
          allowed: false,
          reason: `Access to protected path '${resolved}' is forbidden by security policy (matches ${pattern}).`
        };
      }
    }

    // 2. Check if within allowed roots
    const inAllowedRoot = this.config.ALLOWED_ROOTS.some(root => {
      const resolvedRoot = path.resolve(root);
      return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    });

    if (!inAllowedRoot) {
      return {
        allowed: false,
        reason: `Path '${resolved}' is outside allowed roots: ${this.config.ALLOWED_ROOTS.join(', ')}`
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

    return { allowed: true, path: resolved };
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

    // 2. Check executable name
    const firstToken = trimmed.split(/\s+/)[0];
    const execBase = path.basename(firstToken);

    if (!this.config.SAFE_COMMANDS.includes(execBase)) {
      return {
        allowed: false,
        reason: `Command executable '${execBase}' is not in the safe whitelist (${this.config.SAFE_COMMANDS.join(', ')}).`
      };
    }

    // 3. Check CWD safety
    if (cwd) {
      const pathCheck = this.validatePathAccess(cwd, 'READ');
      if (!pathCheck.allowed) {
        return { allowed: false, reason: `Command working directory disallowed: ${pathCheck.reason}` };
      }
    }

    return { allowed: true, command: trimmed };
  }
}
