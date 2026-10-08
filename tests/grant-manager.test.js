import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionGuard } from '../src/permission-guard.js';
import { GrantManager } from '../src/security/grant-manager.js';
import { TrustTier } from '../src/capabilities/capability-registry.js';
import { CONFIG } from '../src/config.js';

test('GrantManager: Confused-Deputy Defense & Route Ceilings', async (t) => {
  const guard = new PermissionGuard(CONFIG);
  // Add a restricted agent policy for testing
  guard.agentPolicies['restricted-agent'] = {
    allowedPermissions: ['READ', 'SEARCH'],
    requiresHumanApproval: ['DESTRUCTIVE']
  };

  const grantManager = new GrantManager(guard);

  await t.test('1. Confused-Deputy Defense: Delegation cannot escalate authority', () => {
    // restricted-agent delegates to system (which has all permissions)
    const grant = grantManager.computeGrant({
      delegatorId: 'restricted-agent',
      assigneeId: 'system',
      taskId: 'task_sec_1',
      trustTier: TrustTier.T1_ACTIVE_MCP
    });

    // Effective grant MUST NOT include WRITE or PUSH or EXECUTE because delegator lacks them!
    assert.equal(grant.hasPermission('READ').allowed, true);
    assert.equal(grant.hasPermission('SEARCH').allowed, true);
    assert.equal(grant.hasPermission('WRITE').allowed, false);
    assert.equal(grant.hasPermission('PUSH').allowed, false);
    assert.equal(grant.hasPermission('EXECUTE').allowed, false);
  });

  await t.test('2. High privilege delegator can grant intersection to assignee', () => {
    const grant = grantManager.computeGrant({
      delegatorId: 'system',
      assigneeId: 'chatgpt-desktop',
      taskId: 'task_sec_2',
      trustTier: TrustTier.T1_ACTIVE_MCP
    });

    assert.equal(grant.hasPermission('READ').allowed, true);
    assert.equal(grant.hasPermission('WRITE').allowed, true);
    assert.equal(grant.hasPermission('GIT_WRITE').allowed, true);
  });

  await t.test('3. Route Trust Ceiling gates sensitive permissions on UI automation', () => {
    const grant = grantManager.computeGrant({
      delegatorId: 'system',
      assigneeId: 'chatgpt-desktop',
      taskId: 'task_sec_3',
      routeId: 'accessibility',
      trustTier: TrustTier.T4_UI_AUTOMATION
    });

    // UI route automatically gates PUSH and EXECUTE for approval
    const pushCheck = grant.hasPermission('PUSH');
    assert.equal(pushCheck.allowed, false);
    assert.equal(pushCheck.requiresApproval, true);

    const execCheck = grant.hasPermission('EXECUTE');
    assert.equal(execCheck.allowed, false);
    assert.equal(execCheck.requiresApproval, true);
  });
});
