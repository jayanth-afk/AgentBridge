import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AuditLogger } from '../src/audit-logger.js';
import { CollaborationManager } from '../src/collaboration-manager.js';
import { FileActivityManager } from '../src/file-activity-manager.js';

const db = path.join(process.cwd(), 'data', 'collaboration-smoke.sqlite');

test('collaboration board and non-blocking file awareness', async (t) => {
  if (fs.existsSync(db)) fs.unlinkSync(db);
  const logger = new AuditLogger(db);
  t.after(() => { logger.close(); if (fs.existsSync(db)) fs.unlinkSync(db); });

  const collab = new CollaborationManager(logger);
  const activity = new FileActivityManager(logger, { ttlMs: 60000 });

  const board = collab.create({
    ownerAgent: 'chatgpt-desktop',
    title: 'Parallel review',
    objective: 'Review one file together'
  });
  assert.equal(board.status, 'active');

  collab.join({ collaborationId: board.id, agentId: 'claude-desktop', capabilities: ['review'] });
  collab.join({ collaborationId: board.id, agentId: 'antigravity-ide', capabilities: ['coding'] });

  collab.event({
    collaborationId: board.id,
    agentId: 'claude-desktop',
    eventType: 'finding',
    payload: { message: 'Potential race in recovery flow' }
  });

  const file = '/tmp/shared-review.swift';
  activity.start({ filePath: file, agentId: 'chatgpt-desktop', activityType: 'editing', collaborationId: board.id });
  activity.start({ filePath: file, agentId: 'claude-desktop', activityType: 'editing', collaborationId: board.id });

  const active = activity.get(file);
  assert.equal(active.length, 2);
  assert.deepEqual(new Set(active.map(x => x.agent_id)), new Set(['chatgpt-desktop', 'claude-desktop']));

  // Both agents remain able to announce/edit; awareness is informational, not a lock.
  activity.heartbeat({ filePath: file, agentId: 'chatgpt-desktop', activityType: 'editing' });
  activity.heartbeat({ filePath: file, agentId: 'claude-desktop', activityType: 'editing' });

  const current = collab.get(board.id);
  assert.equal(current.members.length, 3);
  assert.equal(current.events.some(e => e.event_type === 'finding'), true);
});
