import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';

function makeTasks(maxDepth) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-bounds-'));
  const logger = new AuditLogger(path.join(tmpDir, 'tasks.sqlite'));
  const tasks = new TaskManager(logger);
  tasks.maxDelegationDepth = maxDepth;
  return { tasks, logger, tmpDir };
}

test('Runaway delegation depth is bounded', async (t) => {
  await t.test('1. a parent chain longer than the configured depth is rejected', () => {
    const { tasks, logger, tmpDir } = makeTasks(2);
    try {
      let prev = null;
      let created = 0;
      let threw = null;
      try {
        for (let i = 0; i < 10; i++) {
          const task = tasks.createTask({
            fromAgent: 'chatgpt', toAgent: 'claude', title: `t${i}`,
            instructions: 'x', parentTaskId: prev, emitEvent: false
          });
          prev = task.id;
          created++;
        }
      } catch (err) {
        threw = err;
      }
      assert.ok(threw, 'delegation beyond the depth bound must throw');
      assert.equal(threw.code, 'DELEGATION_DEPTH_EXCEEDED');
      assert.equal(created, tasks.maxDelegationDepth + 1,
        'exactly maxDepth+1 tasks may exist before the bound is enforced');
    } finally {
      try { logger.close(); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  await t.test('2. a task without a parent is unaffected and shallow chains are allowed', () => {
    const { tasks, logger, tmpDir } = makeTasks(24);
    try {
      const root = tasks.createTask({ fromAgent: 'a', toAgent: 'b', title: 'root', instructions: 'x', emitEvent: false });
      const child = tasks.createTask({ fromAgent: 'b', toAgent: 'c', title: 'child', instructions: 'y', parentTaskId: root.id, emitEvent: false });
      assert.ok(root.id && child.id);
      assert.equal(child.parentTaskId, root.id);
    } finally {
      try { logger.close(); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  await t.test('3. a corrupted parent cycle cannot hang the depth walk', () => {
    const { tasks, logger, tmpDir } = makeTasks(24);
    try {
      const a = tasks.createTask({ fromAgent: 'a', toAgent: 'b', title: 'a', instructions: 'x', emitEvent: false });
      const b = tasks.createTask({ fromAgent: 'b', toAgent: 'c', title: 'b', instructions: 'y', parentTaskId: a.id, emitEvent: false });
      // Force a cycle: a -> parent b (b -> parent a).
      tasks.db.prepare('UPDATE tasks SET parent_task_id = ? WHERE id = ?').run(b.id, a.id);
      const depth = tasks._delegationDepth(a.id);
      assert.ok(Number.isFinite(depth));
      assert.ok(depth <= tasks.maxDelegationDepth + 1, 'cycle walk must stay bounded');

      // Creating against a cyclic parent must not throw a non-bound error.
      const c = tasks.createTask({ fromAgent: 'c', toAgent: 'd', title: 'c', instructions: 'z', parentTaskId: b.id, emitEvent: false });
      assert.ok(c.id);
    } finally {
      try { logger.close(); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});
