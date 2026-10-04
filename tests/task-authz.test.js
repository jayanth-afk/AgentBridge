import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

import { CONFIG } from '../src/config.js';
import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';

const TEST_DB = path.join(CONFIG.DATA_DIR, 'test_task_authz.sqlite');

test('Task authorization (only owner or creator may finalize)', async (t) => {
  for (const s of ['', '-wal', '-shm']) {
    const p = `${TEST_DB}${s}`;
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
  }
  const logger = new AuditLogger(TEST_DB);
  const tasks = new TaskManager(logger);

  t.after(() => {
    try { logger.close(); } catch {}
    for (const s of ['', '-wal', '-shm']) {
      const p = `${TEST_DB}${s}`;
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
    }
  });

  await t.test('assignee can complete its task', () => {
    const task = tasks.createTask({ fromAgent: 'claude-desktop', toAgent: 'chatgpt-desktop', title: 't1', instructions: 'x' });
    const done = tasks.updateTaskStatus({ taskId: task.id, agentId: 'chatgpt-desktop', status: 'completed', result: 'ok' });
    assert.strictEqual(done.status, 'completed');
  });

  await t.test('owner (creator) can cancel its task', () => {
    const task = tasks.createTask({ fromAgent: 'claude-desktop', toAgent: 'chatgpt-desktop', title: 't2', instructions: 'x' });
    const done = tasks.updateTaskStatus({ taskId: task.id, agentId: 'claude-desktop', status: 'cancelled' });
    assert.strictEqual(done.status, 'cancelled');
  });

  await t.test('unrelated agent cannot finalize someone else task', () => {
    const task = tasks.createTask({ fromAgent: 'claude-desktop', toAgent: 'chatgpt-desktop', title: 't3', instructions: 'x' });
    assert.throws(
      () => tasks.updateTaskStatus({ taskId: task.id, agentId: 'antigravity-ide', status: 'completed', result: 'pwn' }),
      /Forbidden/
    );
    const still = tasks.getTask(task.id, false);
    assert.notStrictEqual(still.status, 'completed');
  });

  await t.test('claimNextTask only returns tasks assigned to the caller', () => {
    tasks.createTask({ fromAgent: 'claude-desktop', toAgent: 'chatgpt-desktop', title: 't4', instructions: 'x' });
    assert.strictEqual(tasks.claimNextTask('antigravity-ide'), null);
    const claimed = tasks.claimNextTask('chatgpt-desktop');
    assert.ok(claimed);
    assert.strictEqual(claimed.assignee, 'chatgpt-desktop');
  });
});
