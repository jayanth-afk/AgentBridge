import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';
import { AttemptLedger, AttemptState } from '../src/attempts/attempt-ledger.js';
import { EffectsLedger, EffectClassification, EffectState, isEffectfulTool, getToolClassification } from '../src/effects/effects-ledger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ProjectController } from '../src/project-controller.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { CONFIG } from '../src/config.js';

test('Effects Boundary & Invariants Suite: Authoritative ToolRegistry Enforcement', async (t) => {
  const tmpDir = path.join(process.cwd(), 'tmp-effects-test-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const logger = new AuditLogger(dbPath);
  const attemptLedger = new AttemptLedger(logger);
  const effectsLedger = new EffectsLedger(logger);
  const taskManager = new TaskManager(logger, attemptLedger);
  const guard = new PermissionGuard({ ...CONFIG, ALLOWED_ROOTS: [tmpDir] });
  const controller = new ProjectController(guard, logger);
  const registry = new ToolRegistry();

  const baseContext = {
    logger,
    db: logger.db,
    taskManager,
    attemptLedger,
    effectsLedger,
    controller,
    enforcementMode: 'V2_ATTEMPT_SCOPED'
  };

  t.after(() => {
    logger.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await t.test('1. Valid attempt executes effectful tool and commits to EffectsLedger', async () => {
    const task = taskManager.createTask({
      fromAgent: 'antigravity',
      toAgent: 'freebuff',
      title: 'Write test file',
      instructions: 'Write content'
    });

    const att = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'freebuff',
      routeId: 'default'
    });
    attemptLedger.acquireAttempt(att.attemptId, 'freebuff');

    const testFile = path.join(tmpDir, 'valid_effect.txt');
    const result = await registry.executeTool('bridge_create_file', {
      filePath: testFile,
      content: 'hello world from v2 attempt',
      overwrite: true,
      agentId: 'freebuff',
      attemptId: att.attemptId,
      epoch: att.epoch,
      idempotencyKey: 'idem_create_01'
    }, baseContext);

    assert.ok(result);
    assert.strictEqual(fs.readFileSync(testFile, 'utf8'), 'hello world from v2 attempt');

    // Verify EffectsLedger record
    const effectRow = logger.db.prepare('SELECT * FROM bridge_effects_ledger WHERE idempotency_key = ?').get('idem_create_01');
    assert.ok(effectRow);
    assert.strictEqual(effectRow.state, 'COMMITTED');
    assert.strictEqual(effectRow.attempt_id, att.attemptId);
    assert.strictEqual(effectRow.epoch, att.epoch);
  });

  await t.test('2. Missing attempt context is rejected under V2_ATTEMPT_SCOPED', async () => {
    const testFile = path.join(tmpDir, 'no_attempt.txt');
    await assert.rejects(
      async () => {
        await registry.executeTool('bridge_create_file', {
          filePath: testFile,
          content: 'unauthorized write',
          agentId: 'freebuff'
        }, baseContext);
      },
      /V2_ENFORCEMENT_ERROR/
    );
    assert.strictEqual(fs.existsSync(testFile), false);
  });

  await t.test('3. Pure read-only tools do NOT require attempt context even under V2_ATTEMPT_SCOPED', async () => {
    const pingRes = await registry.executeTool('bridge_ping', { agentId: 'freebuff' }, baseContext);
    assert.strictEqual(pingRes.status, 'OK');

    // Read an existing file
    const existingFile = path.join(tmpDir, 'valid_effect.txt');
    const readRes = await registry.executeTool('bridge_read_file', {
      filePath: existingFile,
      agentId: 'freebuff'
    }, baseContext);
    assert.ok(readRes.content.includes('hello world from v2 attempt'));
  });

  await t.test('4. Non-existent attemptId is rejected with ATTEMPT_NOT_FOUND', async () => {
    const testFile = path.join(tmpDir, 'fake_attempt.txt');
    await assert.rejects(
      async () => {
        await registry.executeTool('bridge_create_file', {
          filePath: testFile,
          content: 'fake',
          agentId: 'freebuff',
          attemptId: 'att_non_existent_123',
          epoch: 1
        }, baseContext);
      },
      /does not exist|ATTEMPT_NOT_FOUND/
    );
  });

  await t.test('5. Impersonation error: attempt belongs to another agent', async () => {
    const task = taskManager.createTask({
      fromAgent: 'antigravity',
      toAgent: 'freebuff',
      title: 'Impersonation task',
      instructions: 'Run'
    });
    const att = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'freebuff'
    });
    attemptLedger.acquireAttempt(att.attemptId, 'freebuff');

    const testFile = path.join(tmpDir, 'impersonate.txt');
    await assert.rejects(
      async () => {
        // zia-brain tries to use freebuff's attempt
        await registry.executeTool('bridge_create_file', {
          filePath: testFile,
          content: 'hacked',
          agentId: 'zia-brain',
          attemptId: att.attemptId,
          epoch: att.epoch
        }, baseContext);
      },
      /belongs to agent 'freebuff', not 'zia-brain'/
    );
  });

  await t.test('6. Stale epoch is rejected with FENCED_ATTEMPT_ERROR before effect happens', async () => {
    const task = taskManager.createTask({
      fromAgent: 'antigravity',
      toAgent: 'freebuff',
      title: 'Fencing task',
      instructions: 'Run'
    });
    const att1 = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'freebuff'
    });
    attemptLedger.acquireAttempt(att1.attemptId, 'freebuff');

    // Supersede att1 with att2 (advances epoch to 2, fencing att1)
    const att2 = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'freebuff'
    });
    attemptLedger.acquireAttempt(att2.attemptId, 'freebuff');

    const testFile = path.join(tmpDir, 'stale_epoch.txt');
    await assert.rejects(
      async () => {
        await registry.executeTool('bridge_create_file', {
          filePath: testFile,
          content: 'stale attempt write',
          agentId: 'freebuff',
          attemptId: att1.attemptId,
          epoch: att1.epoch
        }, baseContext);
      },
      /FENCED_ATTEMPT_ERROR/
    );
    assert.strictEqual(fs.existsSync(testFile), false);
  });

  await t.test('7. Expired lease is rejected with LEASE_EXPIRED_ERROR', async () => {
    const task = taskManager.createTask({
      fromAgent: 'antigravity',
      toAgent: 'freebuff',
      title: 'Expired lease task',
      instructions: 'Run'
    });
    const att = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'freebuff',
      leaseTimeoutMs: 1 // 1 millisecond lease
    });
    attemptLedger.acquireAttempt(att.attemptId, 'freebuff');

    // Force lease expiration in DB
    logger.db.prepare(`
      UPDATE bridge_attempts
      SET lease_expires_at = '2020-01-01T00:00:00.000Z'
      WHERE attempt_id = ?
    `).run(att.attemptId);

    const testFile = path.join(tmpDir, 'expired_lease.txt');
    await assert.rejects(
      async () => {
        await registry.executeTool('bridge_create_file', {
          filePath: testFile,
          content: 'expired write',
          agentId: 'freebuff',
          attemptId: att.attemptId,
          epoch: att.epoch
        }, baseContext);
      },
      /LEASE_EXPIRED_ERROR/
    );
  });

  await t.test('8. Duplicate idempotency key replays cached result without re-executing effect', async () => {
    const task = taskManager.createTask({
      fromAgent: 'antigravity',
      toAgent: 'freebuff',
      title: 'Idempotency task',
      instructions: 'Run'
    });
    const att = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'freebuff'
    });
    attemptLedger.acquireAttempt(att.attemptId, 'freebuff');

    const testFile = path.join(tmpDir, 'idempotent_test.txt');
    const idemKey = 'idem_create_repeatable';

    const firstRun = await registry.executeTool('bridge_create_file', {
      filePath: testFile,
      content: 'version 1',
      overwrite: true,
      agentId: 'freebuff',
      attemptId: att.attemptId,
      epoch: att.epoch,
      idempotencyKey: idemKey
    }, baseContext);

    // Overwrite the file on disk directly to detect if tool handler is re-executed
    fs.writeFileSync(testFile, 'MODIFIED_ON_DISK');

    const secondRun = await registry.executeTool('bridge_create_file', {
      filePath: testFile,
      content: 'version 2',
      overwrite: true,
      agentId: 'freebuff',
      attemptId: att.attemptId,
      epoch: att.epoch,
      idempotencyKey: idemKey
    }, baseContext);

    // Returned cached result from first execution
    assert.deepStrictEqual(secondRun, firstRun);
    // Disk content was NOT modified because tool handler was skipped!
    assert.strictEqual(fs.readFileSync(testFile, 'utf8'), 'MODIFIED_ON_DISK');
  });

  await t.test('9. Unknown / un-reconciled external effect cannot be blindly retried', async () => {
    const task = taskManager.createTask({
      fromAgent: 'antigravity',
      toAgent: 'freebuff',
      title: 'Crash task',
      instructions: 'Run'
    });
    const att = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'freebuff'
    });
    attemptLedger.acquireAttempt(att.attemptId, 'freebuff');

    const idemKey = 'idem_crashed_op';
    // Record intent and simulate crash by marking state UNKNOWN
    const intent = effectsLedger.recordIntent({
      idempotencyKey: idemKey,
      attemptId: att.attemptId,
      taskId: task.id,
      epoch: att.epoch,
      agentId: 'freebuff',
      operation: 'bridge_git_push',
      classification: EffectClassification.EXTERNAL
    });
    effectsLedger.markExecuting(intent.effectId);
    logger.db.prepare("UPDATE bridge_effects_ledger SET state = 'UNKNOWN' WHERE effect_id = ?").run(intent.effectId);

    // Calling again with same idempotency key must be REFUSED
    await assert.rejects(
      async () => {
        await registry.executeTool('bridge_git_push', {
          agentId: 'freebuff',
          attemptId: att.attemptId,
          epoch: att.epoch,
          idempotencyKey: idemKey
        }, baseContext);
      },
      /EFFECT_IN_FLIGHT_OR_UNKNOWN/
    );
  });

  await t.test('10. Grant restrictions on attempt are strictly enforced', async () => {
    const task = taskManager.createTask({
      fromAgent: 'antigravity',
      toAgent: 'freebuff',
      title: 'Restricted task',
      instructions: 'Run'
    });
    const att = attemptLedger.createAttempt({
      taskId: task.id,
      agentId: 'freebuff',
      grant: {
        allowedTools: ['bridge_read_file'], // create_file not allowed!
        allowedPaths: [tmpDir]
      }
    });
    attemptLedger.acquireAttempt(att.attemptId, 'freebuff');

    const testFile = path.join(tmpDir, 'grant_blocked.txt');
    await assert.rejects(
      async () => {
        await registry.executeTool('bridge_create_file', {
          filePath: testFile,
          content: 'forbidden',
          agentId: 'freebuff',
          attemptId: att.attemptId,
          epoch: att.epoch
        }, baseContext);
      },
      /GRANT_VIOLATION_ERROR.*not permitted under attempt grant/
    );
  });
});
