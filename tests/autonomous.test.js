import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { PresenceManager } from '../src/presence-manager.js';
import { ProjectController } from '../src/project-controller.js';
import { AgentRunner } from '../src/agent-runner.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_autonomous.sqlite');

test('Autonomous Multi-Agent Consumption & Execution Suite', async (t) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  const logger = new AuditLogger(TEST_DB);
  const guard = new PermissionGuard();
  const taskManager = new TaskManager(logger);
  const mailbox = new MailboxHub(logger, taskManager);
  const presence = new PresenceManager(logger);
  const controller = new ProjectController(guard, logger);

  t.after(() => {
    try {
      if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    } catch {}
  });

  const testWorkspace = CONFIG.TEST_WORKSPACE;
  if (!fs.existsSync(testWorkspace)) {
    fs.mkdirSync(testWorkspace, { recursive: true });
  }

  await t.test('1. Task Lifecycle & Dependency Management', async () => {
    // Parent task with child dependency
    const parentTask = taskManager.createTask({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'antigravity-ide',
      title: 'Parent Task',
      instructions: 'Do parent work after child completes',
      dependencies: ['child_1']
    });

    assert.strictEqual(parentTask.status, 'blocked');
    assert.deepStrictEqual(parentTask.dependencies, ['child_1']);

    // Attempting to claim before dependency completes returns null
    const claimedBefore = taskManager.claimNextTask('antigravity-ide');
    assert.strictEqual(claimedBefore, null);

    // Create child task with id 'child_1'
    const childTask = taskManager.createTask({
      fromAgent: 'antigravity-ide',
      toAgent: 'claude-desktop',
      title: 'Child Task',
      instructions: 'Perform child subtask'
    });
    // Manually force id for dependency test
    logger.db.prepare(`UPDATE tasks SET id = 'child_1' WHERE id = ?`).run(childTask.id);

    // Complete child task
    taskManager.updateTaskStatus({
      taskId: 'child_1',
      agentId: 'claude-desktop',
      status: 'completed',
      result: 'Child subtask finished'
    });

    // Parent task should now be unblocked and claimable
    const claimedParent = taskManager.claimNextTask('antigravity-ide');
    assert.ok(claimedParent, 'Parent task should now be claimed');
    assert.strictEqual(claimedParent.id, parentTask.id);
    assert.strictEqual(claimedParent.status, 'claimed');
  });

  await t.test('2. Task Retry on Failure within Limit', async () => {
    const task = taskManager.createTask({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'antigravity-ide',
      title: 'Flaky Task',
      instructions: 'Retryable operation',
      maxRetries: 2
    });

    // Claim task
    const claimed = taskManager.claimNextTask('antigravity-ide');
    assert.strictEqual(claimed.id, task.id);

    // Fail attempt 1 -> should re-queue as pending
    const retry1 = taskManager.failTask({
      taskId: task.id,
      agentId: 'antigravity-ide',
      error: 'Network glitch',
      allowRetry: true
    });
    assert.strictEqual(retry1.status, 'pending');
    assert.strictEqual(retry1.retryCount, 1);
    assert.strictEqual(retry1.willRetry, true);

    // Claim attempt 2
    const claimed2 = taskManager.claimNextTask('antigravity-ide');
    assert.strictEqual(claimed2.id, task.id);

    // Fail attempt 2 -> should re-queue
    const retry2 = taskManager.failTask({
      taskId: task.id,
      agentId: 'antigravity-ide',
      error: 'Temporary error',
      allowRetry: true
    });
    assert.strictEqual(retry2.status, 'pending');
    assert.strictEqual(retry2.retryCount, 2);

    // Claim attempt 3
    const claimed3 = taskManager.claimNextTask('antigravity-ide');
    assert.strictEqual(claimed3.id, task.id);

    // Fail attempt 3 -> exceeds maxRetries (2) -> final status failed
    const finalFail = taskManager.failTask({
      taskId: task.id,
      agentId: 'antigravity-ide',
      error: 'Fatal breakdown',
      allowRetry: true
    });
    assert.strictEqual(finalFail.status, 'failed');
  });

  await t.test('3. Expired task lease recovery and retry accounting', async () => {
    const task = taskManager.createTask({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'antigravity-ide',
      title: 'Lease Recovery Test',
      instructions: 'Simulate abandoned work',
      timeoutMs: 1,
      maxRetries: 1
    });
    const claimed = taskManager.claimNextTask('antigravity-ide');
    assert.strictEqual(claimed.id, task.id);

    await new Promise(r => setTimeout(r, 5));
    const recovered = taskManager.recoverExpiredTasks('antigravity-ide');
    assert.strictEqual(recovered.length, 1);
    assert.strictEqual(recovered[0].status, 'pending');
    assert.strictEqual(taskManager.getTask(task.id, false).retryCount, 1);

    const reclaimed = taskManager.claimNextTask('antigravity-ide');
    assert.strictEqual(reclaimed.id, task.id);
    await new Promise(r => setTimeout(r, 5));
    const failed = taskManager.recoverExpiredTasks('antigravity-ide');
    assert.strictEqual(failed[0].status, 'failed');
  });

  await t.test('4. End-to-End Autonomous Smoke Test (ChatGPT -> Bridge -> Antigravity Runner -> Result -> ChatGPT)', async () => {
    // Start an autonomous AgentRunner for antigravity-ide
    const runner = new AgentRunner({
      agentId: 'antigravity-ide',
      mailboxHub: mailbox,
      presenceManager: presence,
      projectController: controller,
      pollIntervalMinMs: 50,
      pollIntervalMaxMs: 200,
      allowSmokeTests: true
    });

    runner.start();
    assert.strictEqual(runner.state, 'IDLE');

    // 1. ChatGPT delegates an autonomous smoke test task to Antigravity
    const delegated = mailbox.delegateTask({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'antigravity-ide',
      title: 'Autonomous Smoke Test Request',
      instructions: 'Please run autonomous-test in test workspace: create autonomous-test.txt with AUTONOMOUS_OK, read it back, and report completion.',
      context: { testMode: true, smokeTest: true }
    });

    assert.ok(delegated.id);
    assert.strictEqual(delegated.status, 'pending');

    // 2. Wait briefly for autonomous runner to wake up, claim, execute, and deliver result
    let taskFinished = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 50));
      const current = taskManager.getTask(delegated.id, false);
      if (current && current.status === 'completed') {
        taskFinished = true;
        break;
      }
    }

    assert.ok(taskFinished, 'Autonomous runner should have completed the task automatically without human intervention');

    // 3. Verify file was created in test workspace and contains AUTONOMOUS_OK
    const expectedFilePath = path.join(testWorkspace, 'autonomous-test.txt');
    assert.ok(fs.existsSync(expectedFilePath), 'autonomous-test.txt should exist');
    const content = fs.readFileSync(expectedFilePath, 'utf8');
    assert.strictEqual(content, 'AUTONOMOUS_OK');

    // 4. Verify completed task payload
    const completedTask = taskManager.getTask(delegated.id, false);
    assert.strictEqual(completedTask.status, 'completed');
    assert.ok(completedTask.completedAt);
    assert.ok(completedTask.result.includes('AUTONOMOUS_OK'));

    // 5. Verify automatic result delivery to ChatGPT inbox!
    const chatgptInbox = mailbox.getInbox({ agentId: 'chatgpt-desktop' });
    const resultMsg = chatgptInbox.find(m => m.subject.includes(delegated.id) || m.subject.includes(delegated.title));
    assert.ok(resultMsg, 'Requester (chatgpt-desktop) should have received an automatic result notification in its inbox');
    assert.strictEqual(resultMsg.from_agent, 'antigravity-ide');
    assert.ok(resultMsg.content.includes('completed'));

    // Cleanup runner
    runner.stop();
    assert.strictEqual(runner.state, 'OFFLINE');
  });

  await t.test('5. Live Acknowledgment Ping (ChatGPT -> Antigravity -> ACK)', async () => {
    const runner = new AgentRunner({
      agentId: 'antigravity-ide',
      mailboxHub: mailbox,
      presenceManager: presence,
      projectController: controller,
      pollIntervalMinMs: 50
    });
    runner.start();

    const ackTask = mailbox.delegateTask({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'antigravity-ide',
      title: 'Connectivity Smoke Test',
      instructions: 'Reply with exactly LINKAGE_ACK_ANTIGRAVITY if you received this live request through the Agent Bridge.'
    });

    let completed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 50));
      const t = taskManager.getTask(ackTask.id, false);
      if (t && t.status === 'completed') {
        completed = true;
        assert.strictEqual(t.result, 'LINKAGE_ACK_ANTIGRAVITY');
        break;
      }
    }

    assert.ok(completed, 'Antigravity should have acknowledged with LINKAGE_ACK_ANTIGRAVITY');
    runner.stop();
  });
});
