import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { EventBus } from '../src/event-bus.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { CONFIG } from '../src/config.js';

test('B1 Lease Recovery: Claim task, kill -9 worker process, verify return to pending, epoch advance, and late result rejection', async (t) => {
  let workerChild = null;
  let mailbox = null;
  try {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-kill9-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger, null, eventBus);
  mailbox = new MailboxHub(logger, taskManager, eventBus);
  const registry = new ToolRegistry({ mailbox });

  // 1. Delegate a task
  const delegated = mailbox.delegateTask({
    fromAgent: 'freebuff',
    toAgent: 'chatgpt-desktop',
    title: 'Process heavy calculation',
    instructions: 'Compute pi to 1000 digits'
  });
  const taskId = delegated.id;
  assert.ok(taskId, 'Task must be created');

  // Query the associated bridge request
  const reqRow = mailbox.db.prepare('SELECT request_id FROM bridge_requests WHERE task_id = ?').get(taskId);
  const requestId = reqRow?.request_id;
  assert.ok(requestId, 'Associated request must exist');

  // 2. Spawn a real child worker process
  // The worker process claims the request with a short lease (800ms) and outputs confirmation
  const workerScript = `
    import { AuditLogger } from '${path.resolve('src/audit-logger.js')}';
    import { TaskManager } from '${path.resolve('src/task-manager.js')}';
    import { MailboxHub } from '${path.resolve('src/mailbox-hub.js')}';

    const logger = new AuditLogger('${dbPath}');
    const taskManager = new TaskManager(logger);
    const mailbox = new MailboxHub(logger, taskManager);

    const claim = mailbox.claimRequest({
      requestId: '${requestId}',
      agentId: 'chatgpt-desktop',
      workerId: 'worker_subproc_1',
      leaseMs: 800
    });

    console.log(JSON.stringify({ claimed: claim.claimed, leaseExpiresAt: claim.leaseExpiresAt, epoch: claim.epoch }));
    // Keep running until killed
    setInterval(() => {}, 1000);
  `;

  let workerClaim = null;
  workerChild = spawn(process.execPath, ['--input-type=module', '-e', workerScript], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  workerChild.stdout.on('data', chunk => {
    try {
      const parsed = JSON.parse(chunk.toString().trim());
      if (parsed.claimed) workerClaim = parsed;
    } catch {}
  });

  // Wait for worker to claim
  const startWait = Date.now();
  while (!workerClaim && Date.now() - startWait < 5000) {
    await new Promise(r => setTimeout(r, 50));
  }

  assert.ok(workerClaim, 'Worker child process must have claimed request');
  const initialEpoch = workerClaim.epoch || 1;
  // Verify task status is claimed/in_progress right now
  const taskWhileWorkerAlive = taskManager.getTask(taskId, false);
  assert.ok(['claimed', 'in_progress'].includes(taskWhileWorkerAlive.status), `Task status must be claimed or in_progress, got ${taskWhileWorkerAlive.status}`);

  // 3. kill -9 the worker child process
  workerChild.kill('SIGKILL');
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(workerChild.killed, true);

  // 4. Wait for lease to expire (800ms + margin)
  await new Promise(r => setTimeout(r, 900));

  // 5. Read status with bridge_get_task_status tool (or getTask / getRequest)
  // Even if no scheduled background sweep has run yet, the expired-lease predicate must report it as pending
  const readViaTool = await registry.executeTool(
    'bridge_get_task_status',
    { taskId, compact: false },
    { agentId: 'freebuff', isPrivileged: false, mailbox }
  );

  assert.strictEqual(readViaTool.status, 'pending', 'Expired lease must report pending, never claimed or in_progress');

  // Also verify via getRequest
  const reqStatus = mailbox.getRequest(requestId, { agentId: 'freebuff' });
  assert.strictEqual(reqStatus.status, 'pending');

  // Verify the epoch advanced
  const refreshedReq = mailbox.db.prepare('SELECT epoch FROM bridge_requests WHERE request_id = ?').get(requestId);
  assert.ok(refreshedReq.epoch > initialEpoch, `Epoch must advance on recovery (current: ${refreshedReq.epoch}, initial: ${initialEpoch})`);

  // 6. Test that a late result from the dead worker with the old epoch is rejected
  const lateAttemptId = 'attempt_dead_worker_1';
  let lateResultRejected = false;

  try {
    const res = mailbox.submitTaskResult({
      taskId,
      agentId: 'chatgpt-desktop',
      status: 'completed',
      result: 'Late result from dead worker',
      attemptId: lateAttemptId,
      epoch: initialEpoch // Stale epoch!
    });
    if (res && res.quarantined) {
      lateResultRejected = true;
    }
  } catch (err) {
    if (err.code === 'FENCED_ATTEMPT_ERROR' || /epoch|fenced/i.test(err.message)) {
      lateResultRejected = true;
    }
  }

  assert.strictEqual(lateResultRejected, true, 'Late result from dead worker with old epoch must be rejected or quarantined');

  } finally {
    if (workerChild && !workerChild.killed) {
      workerChild.kill('SIGKILL');
    }
    if (mailbox) {
      mailbox.stopRecoveryTimer();
    }
  }
});
