import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';
import { AttemptLedger } from '../src/attempts/attempt-ledger.js';
import { RequestExplainer } from '../src/diagnostics/request-explainer.js';
import { ToolRegistry } from '../src/tool-registry.js';

test('RequestExplainer: Deep Lifecycle Observability & Causal Tracing', async (t) => {
  const db = new DatabaseSync(':memory:');
  const logger = new AuditLogger(':memory:');
  // swap db for in-memory
  logger.db = db;
  logger.initTables();

  const attemptLedger = new AttemptLedger(logger);
  const taskManager = new TaskManager(logger, attemptLedger);
  const explainer = new RequestExplainer(logger);

  // Seed sample request
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO bridge_requests (
      request_id, conversation_id, from_agent, to_agent, question,
      task_id, status, response, error, timeout_ms, created_at, updated_at, completed_at
    ) VALUES ('req_obs_1', 'conv_obs_1', 'antigravity-ide', 'chatgpt-desktop', 'Review design', 'task_obs_1', 'completed', 'Design looks solid', NULL, 30000, ?, ?, ?)
  `).run(now, now, now);

  db.prepare(`
    INSERT INTO tasks (
      id, created_at, updated_at, from_agent, to_agent, title, instructions, status
    ) VALUES ('task_obs_1', ?, ?, 'antigravity-ide', 'chatgpt-desktop', 'Review design', 'Inspect doc', 'completed')
  `).run(now, now);

  const att = attemptLedger.createAttempt({
    taskId: 'task_obs_1',
    requestId: 'req_obs_1',
    agentId: 'chatgpt-desktop',
    routeId: 'chatgpt-local-engine'
  });
  attemptLedger.acquireAttempt(att.attemptId, 'chatgpt-desktop');
  attemptLedger.completeAttempt({
    attemptId: att.attemptId,
    epoch: att.epoch,
    result: 'Design looks solid'
  });

  await t.test('1. explainRequest produces chronological causal timeline', () => {
    const trace = explainer.explainRequest('req_obs_1');
    assert.equal(trace.found, true);
    assert.equal(trace.requestId, 'req_obs_1');
    assert.equal(trace.fromAgent, 'antigravity-ide');
    assert.equal(trace.toAgent, 'chatgpt-desktop');
    assert.equal(trace.currentStatus, 'completed');
    assert.equal(trace.totalAttempts, 1);
    assert.ok(trace.timeline.length >= 3);

    const phases = trace.timeline.map(t => t.phase);
    assert.ok(phases.includes('REQUEST_CREATED'));
    assert.ok(phases.includes('TASK_BOUND'));
    assert.ok(phases.includes('ATTEMPT_CREATED'));
    assert.ok(phases.includes('ATTEMPT_COMPLETED'));
  });

  await t.test('2. bridge_explain_request tool returns trace', async () => {
    const registry = new ToolRegistry();
    const ctx = { requestExplainer: explainer };

    const res = await registry.executeTool('bridge_explain_request', { requestId: 'req_obs_1' }, ctx);
    assert.equal(res.found, true);
    assert.equal(res.requestId, 'req_obs_1');
    assert.equal(res.totalAttempts, 1);
  });
});
