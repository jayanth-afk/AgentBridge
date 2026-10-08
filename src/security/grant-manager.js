import path from 'node:path';
import fs from 'node:fs';
import { TrustTier } from '../capabilities/capability-registry.js';

/**
 * Attempt-Scoped Authorization Grant
 * Bound immutably to an attempt.
 */
export class AttemptGrant {
  constructor({
    delegatorId,
    assigneeId,
    taskId,
    routeId,
    allowedPermissions = [],
    allowedRoots = [],
    requiresApproval = [],
    trustTierCeiling = TrustTier.T5_NOTIFICATION_HUMAN
  }) {
    this.delegatorId = delegatorId;
    this.assigneeId = assigneeId;
    this.taskId = taskId;
    this.routeId = routeId;
    this.allowedPermissions = new Set(allowedPermissions);
    this.allowedRoots = allowedRoots.map(r => path.resolve(r));
    this.requiresApproval = new Set(requiresApproval);
    this.trustTierCeiling = trustTierCeiling;
  }

  hasPermission(permission) {
    if (this.requiresApproval.has(permission)) {
      return { allowed: false, requiresApproval: true, reason: `Permission '${permission}' is gated and requires explicit human approval.` };
    }
    if (!this.allowedPermissions.has(permission)) {
      return { allowed: false, reason: `Permission '${permission}' is not in attempt grant.` };
    }
    return { allowed: true };
  }

  canAccessPath(targetPath) {
    if (!targetPath) return { allowed: false, reason: 'Empty path.' };
    const resolved = path.resolve(targetPath);
    const inRoot = this.allowedRoots.some(root => resolved === root || resolved.startsWith(root + path.sep));
    if (!inRoot) {
      return { allowed: false, reason: `Path '${resolved}' is outside attempt grant allowed roots.` };
    }
    return { allowed: true, path: resolved };
  }

  toJSON() {
    return {
      delegatorId: this.delegatorId,
      assigneeId: this.assigneeId,
      taskId: this.taskId,
      routeId: this.routeId,
      allowedPermissions: Array.from(this.allowedPermissions),
      allowedRoots: this.allowedRoots,
      requiresApproval: Array.from(this.requiresApproval),
      trustTierCeiling: this.trustTierCeiling
    };
  }

  static fromJSON(data) {
    if (!data) return null;
    const obj = typeof data === 'string' ? JSON.parse(data) : data;
    return new AttemptGrant(obj);
  }
}

/**
 * GrantManager:
 * Computes least-privilege intersection and enforces Confused-Deputy defenses.
 */
export class GrantManager {
  constructor(permissionGuard) {
    this.guard = permissionGuard;
  }

  /**
   * Computes the effective authorization grant:
   * requester authority ∩ agent policy ∩ route trust ceiling ∩ task scope
   */
  computeGrant({
    delegatorId,
    assigneeId,
    taskId,
    routeId = 'default',
    requestedPermissions = null,
    trustTier = TrustTier.T1_ACTIVE_MCP
  }) {
    const normDelegator = String(delegatorId || 'freebuff').trim().toLowerCase();
    const normAssignee = String(assigneeId).trim().toLowerCase();

    const delegatorPolicy = this.guard.agentPolicies[normDelegator] || { allowedPermissions: [], requiresHumanApproval: [] };
    const assigneePolicy = this.guard.agentPolicies[normAssignee] || { allowedPermissions: [], requiresHumanApproval: [] };

    const delegatorAllowed = new Set(delegatorPolicy.allowedPermissions);
    const assigneeAllowed = new Set(assigneePolicy.allowedPermissions);

    // CONFUSED-DEPUTY DEFENSE:
    // Effective permissions CANNOT exceed what the delegator possesses!
    // low privilege agent -> delegate -> high privilege agent CANNOT gain higher privilege than delegator.
    const effectiveAllowed = [];
    const effectiveApproval = new Set([
      ...(delegatorPolicy.requiresHumanApproval || []),
      ...(assigneePolicy.requiresHumanApproval || [])
    ]);

    for (const perm of assigneeAllowed) {
      // Must be present in delegator authority (unless delegator is system)
      if (normDelegator === 'system' || delegatorAllowed.has(perm)) {
        // If caller specified requestedPermissions, restrict further
        if (!requestedPermissions || requestedPermissions.includes(perm)) {
          effectiveAllowed.push(perm);
        }
      }
    }

    // ROUTE TRUST CEILING:
    // UI automation routes (Tier 4) and Notification routes (Tier 5)
    // CANNOT execute destructive or network operations without approval
    if (trustTier >= TrustTier.T4_UI_AUTOMATION) {
      effectiveApproval.add('DESTRUCTIVE');
      effectiveApproval.add('PUSH');
      effectiveApproval.add('EXECUTE');
    }

    return new AttemptGrant({
      delegatorId: normDelegator,
      assigneeId: normAssignee,
      taskId,
      routeId,
      allowedPermissions: effectiveAllowed,
      allowedRoots: this.guard.config.ALLOWED_ROOTS || [],
      requiresApproval: Array.from(effectiveApproval),
      trustTierCeiling: trustTier
    });
  }
}
